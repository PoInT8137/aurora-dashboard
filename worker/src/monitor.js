// Мониторинг источников с оповещением владельцу в Telegram.
//
// Каждый проход по расписанию (раз в 10 минут) проверяет, что источники отвечают и данные
// свежие: Kp и солнечный ветер у NOAA, Open-Meteo, сам сайт. Сбой дольше 20 минут (два прохода
// подряд — чтобы не будить из-за одной осечки) — сообщение владельцу; пока сбой длится —
// напоминание раз в 6 часов; источник вернулся — сообщение «восстановлено».
//
// Токен бота и чат владельца — секреты worker'а (TELEGRAM_TOKEN, TELEGRAM_OWNER_CHAT), в коде и
// в репозитории их нет. Пока их не задали, состояние всё равно ведётся, но ничего не отправляется.

import '../../core.js';

const Core = globalThis.AuroraCore;
const MIN = 60 * 1000;

export const ALERT_AFTER_MS = 20 * MIN;
export const REMIND_EVERY_MS = 6 * 60 * MIN;

async function getJson(url, fetchFn) {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('ответ ' + res.status);
  return res.json();
}

const ageMin = (time, nowMs) => Math.round((nowMs - time) / MIN);

/** Проверки: имя → { title, run(nowMs, fetchFn) → null (в порядке) или текст проблемы }. */
export const PROBES = {
  noaa_kp: {
    title: 'Kp (NOAA)',
    async run(nowMs, fetchFn) {
      const kp = Core.readKpSeries(await getJson('https://services.swpc.noaa.gov/json/planetary_k_index_1m.json', fetchFn));
      if (!kp.time) return 'нет времени измерения';
      return nowMs - kp.time.getTime() > 30 * MIN ? 'последнее измерение ' + ageMin(kp.time.getTime(), nowMs) + ' мин назад' : null;
    }
  },
  noaa_sw: {
    title: 'Солнечный ветер (NOAA)',
    async run(nowMs, fetchFn) {
      const data = await getJson('https://services.swpc.noaa.gov/products/summary/solar-wind-mag-field.json', fetchFn);
      const row = Array.isArray(data) ? data[0] : data;
      const time = row && Core.parseUtc(row.time_tag);
      if (!time) return 'нет данных';
      return nowMs - time.getTime() > 45 * MIN ? 'спутники молчат ' + ageMin(time.getTime(), nowMs) + ' мин' : null;
    }
  },
  open_meteo: {
    title: 'Open-Meteo',
    async run(nowMs, fetchFn) {
      const p = Core.POINTS[0];
      const data = await getJson('https://api.open-meteo.com/v1/forecast?latitude=' + p.lat + '&longitude=' + p.lon +
        '&current=cloud_cover&models=' + Core.WEATHER_MODEL, fetchFn);
      return data && data.current && Core.num(data.current.cloud_cover) !== null ? null : 'в ответе нет облачности';
    }
  },
  site: {
    title: 'Сайт auroramurmansk.ru',
    async run(nowMs, fetchFn) {
      const res = await fetchFn('https://auroramurmansk.ru/sw.js', { signal: AbortSignal.timeout(10000) });
      return res.ok ? null : 'ответ ' + res.status;
    }
  }
};

/** Сообщение в Telegram владельцу; без секретов — ничего не делает. Возвращает, отправлено ли. */
export async function notifyOwner(env, text, fetchFn) {
  if (!env.TELEGRAM_TOKEN || !env.TELEGRAM_OWNER_CHAT) return false;
  try {
    const res = await fetchFn('https://api.telegram.org/bot' + env.TELEGRAM_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_OWNER_CHAT, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000)
    });
    return res.ok;
  } catch {
    return false;
  }
}

const fmtDuration = ms => {
  const m = Math.round(ms / MIN);
  return m < 60 ? m + ' мин' : Math.floor(m / 60) + ' ч ' + (m % 60) + ' мин';
};

/**
 * Один проход мониторинга. Состояние — таблица monitor (source, down_since, notified_at, detail).
 * Возвращает { problems: [имена], sent: число сообщений }.
 */
export async function monitorStep(env, nowMs, fetchFn) {
  const names = Object.keys(PROBES);
  const results = await Promise.all(names.map(async name => {
    try { return await PROBES[name].run(nowMs, fetchFn); } catch (e) { return (e && e.message) || 'не отвечает'; }
  }));

  const { results: rows } = await env.DB.prepare('SELECT source, down_since, notified_at, detail FROM monitor').all();
  const state = new Map(rows.map(r => [r.source, r]));
  const plan = [];       // { name, problem, since, notify: 'down' | 'remind' | 'up' | null }
  const problems = [];

  names.forEach((name, i) => {
    const problem = results[i];
    const row = state.get(name);
    if (problem) {
      problems.push(name);
      const since = row ? row.down_since : nowMs;
      const notified = row ? row.notified_at : 0;
      const due = nowMs - since >= ALERT_AFTER_MS && (!notified || nowMs - notified >= REMIND_EVERY_MS);
      plan.push({ name, problem, since, notified, notify: due ? (notified ? 'remind' : 'down') : null });
    } else if (row) {
      plan.push({ name, problem: null, since: row.down_since, notified: row.notified_at, notify: row.notified_at ? 'up' : null });
    }
  });

  const messages = plan.filter(p => p.notify).map(p => {
    const title = PROBES[p.name].title;
    if (p.notify === 'up') return '✅ Снова работает: ' + title + ' (сбой длился ' + fmtDuration(nowMs - p.since) + ').';
    return (p.notify === 'remind' ? '⚠️ Всё ещё не работает: ' : '⚠️ Не работает: ') + title + ' — ' + p.problem +
      ' (уже ' + fmtDuration(nowMs - p.since) + ').';
  });
  // Отметка «сообщили» — только если сообщение действительно ушло: иначе оно не должно потеряться.
  const sent = messages.length ? await notifyOwner(env, messages.join('\n'), fetchFn) : false;

  const writes = plan.map(p => {
    if (!p.problem) {
      // Источник вернулся. Если о сбое сообщали, а «восстановлено» не ушло — попробуем в следующий раз.
      if (p.notify === 'up' && !sent) return null;
      return env.DB.prepare('DELETE FROM monitor WHERE source = ?').bind(p.name);
    }
    const notified = p.notify && sent ? nowMs : p.notified;
    return env.DB.prepare(
      'INSERT INTO monitor(source, down_since, notified_at, detail) VALUES(?, ?, ?, ?) ' +
      'ON CONFLICT(source) DO UPDATE SET notified_at = excluded.notified_at, detail = excluded.detail'
    ).bind(p.name, p.since, notified, p.problem);
  }).filter(Boolean);
  if (writes.length) await env.DB.batch(writes);

  return { problems, sent: sent ? messages.length : 0, pending: messages.length };
}
