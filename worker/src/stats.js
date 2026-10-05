// Статистика посещений сайта для владельца — в Telegram-боте (/stats и утренняя сводка).
//
// Страница (track.js) раз за загрузку присылает POST /hit: язык, телефон или компьютер,
// открыто ли как приложение с экрана «Домой», первый ли это визит с этого устройства и с какого
// сайта пришли. Ни адресов, ни cookies: посетитель за сутки — первые 16 знаков HMAC от адреса,
// браузера и даты с секретным ключом. По нему нельзя восстановить адрес, а на следующие сутки он
// уже другой — поэтому «посетители за неделю» — это сумма посетителей по дням.
//
// Считаются только визиты на рабочий сайт (Origin https://auroramurmansk.ru): локальная разработка
// статистику не портит. Строки старше 120 дней удаляются проходом по расписанию.

import { reporterId } from './reports.js';
import { purgeBugs } from './bugs.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MSK_MS = 3 * 60 * 60 * 1000;            // Мурманск — UTC+3 круглый год
export const SITE_ORIGIN = 'https://auroramurmansk.ru';
export const VISITS_KEEP_DAYS = 120;
export const MAX_VISITORS_PER_DAY = 20000;     // защита базы от накрутки
const LANGS = ['ru', 'en', 'zh'];

/** Дата по Москве: 2026-10-05. */
export const mskDay = nowMs => new Date(nowMs + MSK_MS).toISOString().slice(0, 10);

/** Хост сайта, с которого пришли; свой сайт и пустое — null. */
export function refHost(ref) {
  try {
    const host = new URL(String(ref)).hostname.replace(/^www\./, '').toLowerCase();
    return host && host !== 'auroramurmansk.ru' && host.length <= 80 ? host : null;
  } catch {
    return null;
  }
}

/**
 * Приём визита. Возвращает [тело ответа, статус]. Один посетитель в сутки — одна строка,
 * повторные загрузки увеличивают views.
 */
export async function acceptHit(env, body, origin, ip, ua, nowMs) {
  if (origin !== SITE_ORIGIN) return [{ ok: true, counted: false }, 200];
  const day = mskDay(nowMs);
  const who = await reporterId(String(ip) + '|' + String(ua || '').slice(0, 300), nowMs, 'visit:' + (env.REPORT_SECRET || env.VAPID_PRIVATE_KEY));
  const lang = LANGS.includes(body.lang) ? body.lang : null;
  const ver = /^v\d{1,4}$/.test(body.v) ? body.v : null;

  const found = await env.DB.prepare('SELECT 1 AS f FROM visits WHERE day = ? AND who = ?').bind(day, who).first();
  if (found) {
    await env.DB.prepare('UPDATE visits SET views = views + 1, last_at = ?, lang = COALESCE(?, lang), ver = COALESCE(?, ver) WHERE day = ? AND who = ?')
      .bind(nowMs, lang, ver, day, who).run();
    return [{ ok: true, counted: true }, 200];
  }
  const { c } = await env.DB.prepare('SELECT COUNT(*) AS c FROM visits WHERE day = ?').bind(day).first();
  if (c >= MAX_VISITORS_PER_DAY) return [{ ok: true, counted: false }, 200];
  await env.DB.prepare(
    'INSERT INTO visits(day, who, views, lang, mobile, pwa, fresh, ref, ver, first_at, last_at) VALUES(?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(day, who, lang, body.mobile ? 1 : 0, body.pwa ? 1 : 0, body.fresh ? 1 : 0, refHost(body.ref), ver, nowMs, nowMs).run();
  return [{ ok: true, counted: true }, 200];
}

export function purgeVisits(env, nowMs) {
  return env.DB.prepare('DELETE FROM visits WHERE day < ?').bind(mskDay(nowMs - VISITS_KEEP_DAYS * DAY_MS)).run();
}

/* ---------------- сводка для владельца ---------------- */

const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100, b = a % 10;
  return n + ' ' + (a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many);
};
const visitors = n => plural(n, 'посетитель', 'посетителя', 'посетителей');
const views = n => plural(n, 'просмотр', 'просмотра', 'просмотров');
const pct = (part, total) => total ? Math.round(part * 100 / total) + '%' : '—';
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const dayLabel = day => WEEKDAYS[new Date(day + 'T12:00:00Z').getUTCDay()] + ' ' + day.slice(8, 10) + '.' + day.slice(5, 7);

async function range(env, from, to) {
  return env.DB.prepare(
    'SELECT COUNT(*) AS people, COALESCE(SUM(views), 0) AS views, COALESCE(SUM(fresh), 0) AS fresh, ' +
    'COALESCE(SUM(mobile), 0) AS mobile, COALESCE(SUM(pwa), 0) AS pwa FROM visits WHERE day >= ? AND day <= ?'
  ).bind(from, to).first();
}

/** Подписчики: push в браузере и Telegram. Таблиц может не быть — тогда null. */
async function count(env, sql) {
  try { return (await env.DB.prepare(sql).first()).c; } catch { return null; }
}

/** Текст /stats: сегодня, вчера, 7 и 30 дней, по дням, языки, устройства, откуда пришли. */
export async function statsText(env, nowMs) {
  const today = mskDay(nowMs);
  const yesterday = mskDay(nowMs - DAY_MS);
  const week = mskDay(nowMs - 6 * DAY_MS);
  const month = mskDay(nowMs - 29 * DAY_MS);
  const [t, y, w, m] = await Promise.all([range(env, today, today), range(env, yesterday, yesterday), range(env, week, today), range(env, month, today)]);

  const { results: days } = await env.DB.prepare(
    'SELECT day, COUNT(*) AS people, SUM(views) AS views FROM visits WHERE day >= ? GROUP BY day ORDER BY day DESC'
  ).bind(week).all();
  const { results: langs } = await env.DB.prepare(
    "SELECT COALESCE(lang, '?') AS lang, COUNT(*) AS c FROM visits WHERE day >= ? GROUP BY lang ORDER BY c DESC"
  ).bind(week).all();
  const { results: refs } = await env.DB.prepare(
    'SELECT ref, COUNT(*) AS c FROM visits WHERE day >= ? AND ref IS NOT NULL GROUP BY ref ORDER BY c DESC LIMIT 5'
  ).bind(month).all();
  const [push, tg] = await Promise.all([count(env, 'SELECT COUNT(*) AS c FROM subs'), count(env, 'SELECT COUNT(*) AS c FROM tg_subs')]);

  const lines = ['📊 Посещения auroramurmansk.ru', ''];
  lines.push('Сегодня: ' + visitors(t.people) + ', ' + views(t.views));
  lines.push('Вчера: ' + visitors(y.people) + ', ' + views(y.views));
  lines.push('7 дней: ' + visitors(w.people) + ', ' + views(w.views));
  lines.push('30 дней: ' + visitors(m.people) + ', ' + views(m.views));
  if (days.length) {
    lines.push('', 'По дням (посетители / просмотры):');
    for (const d of days) lines.push(dayLabel(d.day) + ' — ' + d.people + ' / ' + d.views);
  }
  if (w.people) {
    lines.push('', 'За 7 дней:');
    lines.push('впервые: ' + pct(w.fresh, w.people) + ', с телефона: ' + pct(w.mobile, w.people) + ', как приложение: ' + pct(w.pwa, w.people));
    lines.push('языки: ' + langs.map(l => l.lang + ' ' + pct(l.c, w.people)).join(', '));
  }
  if (refs.length) lines.push('', 'Откуда пришли (30 дней): ' + refs.map(r => r.ref + ' ' + r.c).join(', '));
  if (push !== null || tg !== null) {
    lines.push('', 'Подписчики: push ' + (push ?? '—') + ', Telegram ' + (tg ?? '—'));
  }
  return lines.join('\n');
}

/** Короткая строка за сутки — для утренней сводки. */
export async function dayLine(env, day) {
  const r = await range(env, day, day);
  return dayLabel(day) + ': ' + visitors(r.people) + ', ' + views(r.views) + (r.people ? ' (впервые ' + pct(r.fresh, r.people) + ')' : '');
}

export const DIGEST_HOUR = 9;   // утренняя сводка — в 9:00 по Москве

/**
 * Проходом по расписанию: раз в сутки, после 9:00 по Москве, — сводка владельцу за вчера
 * (посещения, открытые ошибки) и уборка старых строк. Возвращает, отправлена ли сводка.
 */
export async function dailyDigest(env, nowMs, notify) {
  if (!env.TELEGRAM_TOKEN || !env.TELEGRAM_OWNER_CHAT) return false;
  if (new Date(nowMs + MSK_MS).getUTCHours() < DIGEST_HOUR) return false;
  const today = mskDay(nowMs);
  const done = await env.DB.prepare("SELECT value FROM meta WHERE key = 'digest_day'").first();
  if (done && done.value === today) return false;

  const { c: open } = await env.DB.prepare("SELECT COUNT(*) AS c FROM bugs WHERE status = 'open'").first();
  const text = '☀️ Сводка за вчера\n' + await dayLine(env, mskDay(nowMs - DAY_MS)) +
    '\nОткрытых ошибок: ' + open + '\n\nПодробно: /stats' + (open ? ', /bugs' : '');
  if (!await notify(text)) return false;
  await env.DB.prepare("INSERT INTO meta(key, value) VALUES('digest_day', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(today).run();
  await purgeVisits(env, nowMs);
  await purgeBugs(env, nowMs);
  return true;
}
