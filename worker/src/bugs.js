// Журнал ошибок с оповещением владельцу в Telegram.
//
// Откуда ошибки:
//   page   — необработанные ошибки страницы (track.js → POST /bug);
//   worker — сбои самого сервера: проход по расписанию, запрос, webhook бота;
//   user   — посетитель написал боту /bug <что не так>.
//
// Одинаковые ошибки склеиваются по отпечатку (вид, текст без чисел, файл, строка): у каждой —
// счётчик, первое и последнее появление, версия сайта и браузер. Новая ошибка — сообщение владельцу
// ближайшим проходом по расписанию (все новые одним сообщением, чтобы лавина не превратилась
// в сотню сообщений). Владелец в боте видит список (/bugs), подробности, отмечает «исправлено» или
// «не важно». Исправленная ошибка, повторившаяся в более новой версии сайта, открывается снова
// (старые копии страницы в кэше её «повторять» не будут — у них версия та же).
//
// Ни адресов, ни полных строк браузера: только «iOS 17 · Safari» и т. п.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
export const SITE_ORIGIN = 'https://auroramurmansk.ru';
export const NEW_BUGS_PER_HOUR = 30;          // защита базы от мусора
export const USER_BUGS_PER_DAY = 5;           // сообщений /bug с одного чата
export const BUGS_KEEP_MS = 90 * DAY;         // закрытые ошибки забываются через 90 дней тишины
const LIST_LIMIT = 10;

const clip = (s, n) => String(s ?? '').replace(/\s+$/, '').slice(0, n);
export const verNum = v => { const m = /^v(\d+)$/.exec(String(v || '')); return m ? Number(m[1]) : 0; };

/** Путь файла без адреса сайта и без ?v=…: «js/now.js». */
const stripUrls = text => String(text || '').replace(/https?:\/\/(www\.)?auroramurmansk\.ru\//g, '')
  .replace(/https?:\/\/localhost(:\d+)?\//g, '').replace(/\?[^\s:)]*/g, '');
export const cleanSrc = src => clip(stripUrls(src), 200);
const cleanStack = stack => clip(stripUrls(stack), 1500);

/** Браузер и система одной строкой: «iOS 17 · Safari», «Android 14 · Chrome 129». */
export function uaShort(ua) {
  const s = String(ua || '');
  let os = '?';
  let m;
  if ((m = /(?:iPhone|iPad|iPod).*? OS (\d+)/.exec(s))) os = 'iOS ' + m[1];
  else if ((m = /Android (\d+)/.exec(s))) os = 'Android ' + m[1];
  else if (/Windows/.test(s)) os = 'Windows';
  else if (/Mac OS X/.test(s)) os = 'macOS';
  else if (/Linux/.test(s)) os = 'Linux';
  let br = '?';
  if ((m = /YaBrowser\/(\d+)/.exec(s))) br = 'Яндекс ' + m[1];
  else if ((m = /Edg\/(\d+)/.exec(s))) br = 'Edge ' + m[1];
  else if ((m = /OPR\/(\d+)/.exec(s))) br = 'Opera ' + m[1];
  else if ((m = /(?:Firefox|FxiOS)\/(\d+)/.exec(s))) br = 'Firefox ' + m[1];
  else if ((m = /(?:Chrome|CriOS)\/(\d+)/.exec(s))) br = 'Chrome ' + m[1];
  else if ((m = /Version\/(\d+).*Safari/.exec(s))) br = 'Safari ' + m[1];
  return os + ' · ' + br;
}

async function sha(text) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Отпечаток: числа в тексте не различаем — «index 3» и «index 7» одна и та же ошибка. */
export const fingerprint = (kind, msg, src, line) => sha([kind, String(msg).replace(/\d+/g, '#'), src || '', line || ''].join('|'));

/**
 * Записать ошибку. bug: { kind, msg, src?, line?, col?, stack?, ver?, ua?, page?, fp? }.
 * Возвращает { id, state: 'new' | 'repeat' | 'reopened' | 'dropped' }.
 */
export async function recordBug(env, bug, nowMs) {
  const msg = clip(bug.msg, bug.kind === 'user' ? 1000 : 300) || '(без текста)';
  const src = bug.src ? cleanSrc(bug.src) : null;
  const line = Number.isInteger(bug.line) && bug.line >= 0 ? bug.line : null;
  const col = Number.isInteger(bug.col) && bug.col >= 0 ? bug.col : null;
  const ver = /^v\d{1,4}$/.test(bug.ver) ? bug.ver : null;
  const fp = bug.fp || await fingerprint(bug.kind, msg, src, line);
  const stack = bug.stack ? cleanStack(bug.stack) : null;
  const ua = bug.ua ? clip(bug.ua, 60) : null;
  const page = bug.page ? clip(bug.page, 60) : null;

  const row = await env.DB.prepare('SELECT id, status, ver FROM bugs WHERE fp = ?').bind(fp).first();
  if (row) {
    const reopen = row.status === 'fixed' && verNum(ver) > verNum(row.ver);
    await env.DB.prepare(
      'UPDATE bugs SET count = count + 1, last_at = ?, ver = CASE WHEN ? THEN ? ELSE COALESCE(?, ver) END, ' +
      'stack = COALESCE(?, stack), ua = COALESCE(?, ua), page = COALESCE(?, page), ' +
      "status = CASE WHEN ? THEN 'open' ELSE status END, notified_at = CASE WHEN ? THEN 0 ELSE notified_at END WHERE id = ?"
    ).bind(nowMs, reopen ? 1 : 0, ver, row.status === 'fixed' ? null : ver, stack, ua, page, reopen ? 1 : 0, reopen ? 1 : 0, row.id).run();
    return { id: row.id, state: reopen ? 'reopened' : 'repeat' };
  }
  const recent = await env.DB.prepare('SELECT COUNT(*) AS c FROM bugs WHERE first_at > ?').bind(nowMs - HOUR).first();
  if (recent.c >= NEW_BUGS_PER_HOUR) return { id: null, state: 'dropped' };
  const res = await env.DB.prepare(
    'INSERT INTO bugs(fp, kind, msg, src, line, col, stack, ver, ua, page, first_at, last_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id'
  ).bind(fp, bug.kind, msg, src, line, col, stack, ver, ua, page, nowMs, nowMs).first();
  return { id: res.id, state: 'new' };
}

/** Сбой самого сервера — в журнал. Никогда не бросает: журнал не должен ронять то, что падает. */
export async function recordWorkerError(env, where, error, nowMs = Date.now()) {
  try {
    const msg = where + ': ' + ((error && error.message) || String(error));
    await recordBug(env, { kind: 'worker', msg, src: where, stack: error && error.stack }, nowMs);
  } catch (e) {
    console.error('ошибка не записана в журнал: ' + (e && e.message));
  }
}

/** POST /bug со страницы. Возвращает [тело ответа, статус]. */
export async function acceptBug(env, body, origin, ua, nowMs) {
  if (origin !== SITE_ORIGIN) return [{ ok: true, recorded: false }, 200];
  if (typeof body.msg !== 'string' || !body.msg.trim()) return [{ error: 'bad_bug' }, 400];
  const num = v => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
  const r = await recordBug(env, {
    kind: 'page', msg: body.msg, src: typeof body.src === 'string' ? body.src : null, line: num(body.line), col: num(body.col),
    stack: typeof body.stack === 'string' ? body.stack : null, ver: body.v, ua: uaShort(ua),
    page: typeof body.page === 'string' ? body.page : null
  }, nowMs);
  return [{ ok: true, recorded: r.state !== 'dropped' }, 200];
}

/** /bug <текст> от посетителя бота. Возвращает 'ok' | 'empty' | 'limit'. */
export async function userBug(env, chatId, text, lang, nowMs) {
  const msg = clip(String(text || '').trim(), 1000);
  if (msg.length < 3) return 'empty';
  const src = 'tg:' + chatId;
  const mine = await env.DB.prepare("SELECT COUNT(*) AS c FROM bugs WHERE kind = 'user' AND src = ? AND first_at > ?").bind(src, nowMs - DAY).first();
  if (mine.c >= USER_BUGS_PER_DAY) return 'limit';
  const r = await recordBug(env, { kind: 'user', msg, src, page: 'lang ' + lang, fp: await sha('user|' + src + '|' + nowMs + '|' + msg) }, nowMs);
  return r.state === 'dropped' ? 'limit' : 'ok';
}

export function purgeBugs(env, nowMs) {
  return env.DB.prepare("DELETE FROM bugs WHERE status != 'open' AND last_at < ?").bind(nowMs - BUGS_KEEP_MS).run();
}

/* ---------------- тексты для владельца ---------------- */

const KIND = { page: 'страница', worker: 'сервер', user: 'от посетителя' };
export function ago(ms) {
  const m = Math.max(0, Math.round(ms / MIN));
  if (m < 60) return m + ' мин назад';
  if (m < 48 * 60) return Math.round(m / 60) + ' ч назад';
  return Math.round(m / 1440) + ' дн назад';
}
const where = b => (b.kind === 'user' ? '' : (b.src || '?') + (b.line !== null && b.line !== undefined ? ':' + b.line + (b.col ? ':' + b.col : '') : ''));
const head = b => '#' + b.id + ' · ' + KIND[b.kind] + (b.count > 1 ? ' · ×' + b.count : '') + (b.ver ? ' · ' + b.ver : '');

function shortItem(b, nowMs) {
  return [head(b), clip(b.msg, 200), [where(b), b.ua, ago(nowMs - b.last_at)].filter(Boolean).join(' · ')].join('\n');
}

const bugButtons = b => [
  { text: 'ℹ️ #' + b.id, callback_data: 'bug:d:' + b.id },
  { text: '✅ исправлено', callback_data: 'bug:f:' + b.id },
  { text: '🙈 не важно', callback_data: 'bug:i:' + b.id }
];

/** Список открытых ошибок: { text, reply_markup }. */
export async function bugsList(env, nowMs) {
  const { results } = await env.DB.prepare("SELECT * FROM bugs WHERE status = 'open' ORDER BY last_at DESC LIMIT ?").bind(LIST_LIMIT + 1).all();
  const { c: total } = await env.DB.prepare("SELECT COUNT(*) AS c FROM bugs WHERE status = 'open'").first();
  if (!results.length) return { text: '✅ Открытых ошибок нет.' };
  const shown = results.slice(0, LIST_LIMIT);
  const text = '🐞 Открытые ошибки: ' + total + '\n\n' + shown.map(b => shortItem(b, nowMs)).join('\n\n') +
    (total > shown.length ? '\n\n…и ещё ' + (total - shown.length) + ' (сначала свежие)' : '');
  return { text: clip(text, 4000), reply_markup: { inline_keyboard: shown.map(bugButtons) } };
}

/** Подробности одной ошибки. */
export async function bugDetail(env, id, nowMs) {
  const b = await env.DB.prepare('SELECT * FROM bugs WHERE id = ?').bind(id).first();
  if (!b) return { text: 'Ошибки #' + id + ' нет (возможно, уже удалена).' };
  const status = { open: 'открыта', fixed: 'исправлена', ignored: 'не важна' }[b.status];
  const lines = [head(b) + ' · ' + status, '', b.msg];
  if (where(b)) lines.push('', 'Где: ' + where(b));
  if (b.page && b.kind !== 'user') lines.push('Вкладка: ' + b.page);
  if (b.ua) lines.push('Браузер: ' + b.ua);
  lines.push('Впервые: ' + ago(nowMs - b.first_at) + ', последний раз: ' + ago(nowMs - b.last_at));
  if (b.stack) lines.push('', b.stack);
  const keys = b.status === 'open' ? bugButtons(b).slice(1) : [{ text: '↩️ открыть снова', callback_data: 'bug:o:' + b.id }];
  return { text: clip(lines.join('\n'), 4000), reply_markup: { inline_keyboard: [keys] } };
}

/** Смена статуса кнопкой: f — исправлено, i — не важно, o — открыть снова. */
export async function setBugStatus(env, id, action) {
  const status = { f: 'fixed', i: 'ignored', o: 'open' }[action];
  if (!status) return null;
  const r = await env.DB.prepare('UPDATE bugs SET status = ? WHERE id = ?').bind(status, id).run();
  if (!r.meta || !r.meta.changes) return 'Ошибки #' + id + ' нет.';
  return { fixed: '✅ #' + id + ' — исправлена. Если повторится в новой версии сайта — сообщу.', ignored: '🙈 #' + id + ' — больше не напоминаю.', open: '↩️ #' + id + ' снова открыта.' }[status];
}

/**
 * Проходом по расписанию: о новых (и вернувшихся) ошибках — одним сообщением владельцу.
 * Отметка «сообщили» — только если Telegram сообщение принял. Возвращает число ошибок в сообщении.
 */
export async function bugNotifyStep(env, nowMs, notify) {
  const { results } = await env.DB.prepare("SELECT * FROM bugs WHERE status = 'open' AND notified_at = 0 ORDER BY first_at LIMIT 50").all();
  if (!results.length) return 0;
  const shown = results.slice(0, 5);
  const title = results.length === 1
    ? (results[0].kind === 'user' ? '✉️ Посетитель сообщает об ошибке' : results[0].count > 1 && results[0].first_at < nowMs - HOUR ? '🐞 Ошибка вернулась' : '🐞 Новая ошибка')
    : '🐞 Новых ошибок: ' + results.length;
  const text = title + '\n\n' + shown.map(b => shortItem(b, nowMs)).join('\n\n') +
    (results.length > shown.length ? '\n\n…и ещё ' + (results.length - shown.length) : '') + '\n\nВсе открытые: /bugs';
  const keyboard = results.length === 1 ? { inline_keyboard: [bugButtons(results[0])] } : undefined;
  if (!await notify(clip(text, 4000), keyboard)) return 0;
  await env.DB.batch(results.map(b => env.DB.prepare('UPDATE bugs SET notified_at = ? WHERE id = ?').bind(nowMs, b.id)));
  return results.length;
}
