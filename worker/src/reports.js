// Отметки «Вижу сияние»: очевидцы сообщают, что видят сияние у точки, остальные видят сводку
// за последний час. Надёжнее любого прогноза — если отметки есть.
//
// Ни текста, ни фотографий — только точка и «слабое / яркое»: модерировать нечего.
// Защита от накруток:
//   — отметка принимается, только если у точки темно (днём сияния не видно);
//   — с одного адреса не чаще раза в 30 минут и не больше 6 в сутки;
//   — всего не больше 300 отметок в час (защита базы).
// Адрес (IP) не хранится: только первые 16 знаков HMAC от адреса и даты с секретным ключом —
// по ним нельзя восстановить адрес, а на следующие сутки они уже не совпадут. Отметки старше
// суток удаляются проходом по расписанию.

import '../../core.js';

const Core = globalThis.AuroraCore;

export const STRENGTHS = ['faint', 'bright'];
export const REPORT_WINDOW_MS = 60 * 60 * 1000;       // сводка — за последний час
export const REPORT_INTERVAL_MS = 30 * 60 * 1000;     // с одного адреса — не чаще
export const REPORTS_PER_DAY = 6;
export const REPORTS_PER_HOUR_TOTAL = 300;
export const REPORT_KEEP_MS = 24 * 60 * 60 * 1000;

/** Кто отметил: HMAC(ключ, адрес|сутки UTC), первые 16 hex. Без ключа — нельзя подобрать адрес. */
export async function reporterId(ip, nowMs, secret) {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(secret || 'aurora-reports')),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(ip || 'unknown') + '|' + day));
  return [...new Uint8Array(mac)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Приём отметки. Возвращает [тело ответа, статус].
 * body: { point, strength }; ip — адрес из CF-Connecting-IP.
 */
export async function acceptReport(env, body, ip, nowMs) {
  const point = Core.POINTS.find(p => p.id === body.point);
  if (!point) return [{ error: 'bad_point' }, 400];
  if (!STRENGTHS.includes(body.strength)) return [{ error: 'bad_strength' }, 400];

  // Днём сияния не видно: такая отметка — ошибка или накрутка.
  const alt = Core.solarAltitude(new Date(nowMs), point.lat, point.lon);
  if (alt > Core.DARK_USABLE) return [{ error: 'not_dark' }, 400];

  const who = await reporterId(ip, nowMs, env.REPORT_SECRET || env.VAPID_PRIVATE_KEY);
  const mine = await env.DB.prepare(
    'SELECT MAX(at) AS last, COUNT(*) AS c FROM reports WHERE who = ? AND at > ?'
  ).bind(who, nowMs - REPORT_KEEP_MS).first();
  if (mine && mine.last && nowMs - mine.last < REPORT_INTERVAL_MS) {
    return [{ error: 'too_often', retryAfter: Math.ceil((REPORT_INTERVAL_MS - (nowMs - mine.last)) / 1000) }, 429];
  }
  if (mine && mine.c >= REPORTS_PER_DAY) return [{ error: 'too_many' }, 429];

  const total = await env.DB.prepare('SELECT COUNT(*) AS c FROM reports WHERE at > ?').bind(nowMs - REPORT_WINDOW_MS).first();
  if (total && total.c >= REPORTS_PER_HOUR_TOTAL) return [{ error: 'busy' }, 503];

  await env.DB.prepare('INSERT INTO reports(point, strength, at, who) VALUES(?, ?, ?, ?)')
    .bind(point.id, body.strength, nowMs, who).run();
  return [{ ok: true, point: point.id }, 200];
}

/**
 * Сводка за последний час: { window, total, points: { id: { count, bright, last } } }.
 * Только числа: кто и откуда — не отдаётся.
 */
export async function reportSummary(env, nowMs) {
  const { results } = await env.DB.prepare(
    "SELECT point, COUNT(*) AS c, SUM(CASE WHEN strength = 'bright' THEN 1 ELSE 0 END) AS b, MAX(at) AS last " +
    'FROM reports WHERE at > ? GROUP BY point'
  ).bind(nowMs - REPORT_WINDOW_MS).all();
  const points = {};
  let total = 0;
  for (const r of results) {
    if (!Core.POINTS.some(p => p.id === r.point)) continue;
    points[r.point] = { count: r.c, bright: r.b || 0, last: r.last };
    total += r.c;
  }
  return { window: REPORT_WINDOW_MS / 60000, total, points };
}

/** Удаление старых отметок — проходом по расписанию. */
export function purgeReports(env, nowMs) {
  return env.DB.prepare('DELETE FROM reports WHERE at < ?').bind(nowMs - REPORT_KEEP_MS).run();
}
