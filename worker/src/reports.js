// Отметки «Вижу сияние»: очевидцы сообщают, что видят сияние у точки, остальные видят сводку
// за последний час. Надёжнее любого прогноза — если отметки есть.
//
// Ни текста, ни фотографий: только точка и «слабое / яркое», модерировать нечего.
// Защита от накруток:
//   1) точка должна быть из списка области, и у неё должно быть темно (днём сияния не видно);
//   2) с одного устройства у одной точки одна отметка в час. Устройство сайт помечает случайным
//      номером в своём хранилище; сервер хранит не номер, а HMAC от него с солью;
//   3) с одного IP не больше 4 отметок в час и 12 в сутки (семья за одним роутером отметит,
//      накрутка с одного адреса упрётся в лимит);
//   4) всего не больше 300 отметок в час (защита базы).
// IP в открытом виде не хранится: только первые 16 знаков HMAC от адреса и даты с солью
// (переменная окружения REPORT_SALT), на следующие сутки они уже не совпадут. Без соли
// отметки не принимаются. Отметки старше суток удаляются проходом по расписанию.
//
// Подтверждение: отметки считаются подтверждением сияния у точки (и поднимают шанс), только
// если за час они пришли минимум с CONFIRM_DEVICES разных устройств. Меньше: просто число.

import '../../core.js';

const Core = globalThis.AuroraCore;

export const STRENGTHS = ['faint', 'bright'];
export const REPORT_WINDOW_MS = 60 * 60 * 1000;       // сводка — за последний час
export const DEVICE_INTERVAL_MS = 60 * 60 * 1000;     // устройство и точка: одна отметка в час
export const IP_PER_HOUR = 4;                          // с одного IP за час
export const REPORTS_PER_DAY = 12;                     // с одного IP за сутки
export const CONFIRM_DEVICES = 3;                      // столько разных устройств за час: подтверждение
export const REPORTS_PER_HOUR_TOTAL = 300;
export const REPORT_KEEP_MS = 24 * 60 * 60 * 1000;

/** HMAC-SHA256(соль, текст), первые 16 hex. */
async function hmac16(salt, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(salt)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return [...new Uint8Array(mac)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Кто отметил: HMAC(соль, адрес|сутки UTC). Без соли нельзя подобрать адрес перебором. */
export async function reporterId(ip, nowMs, salt) {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  return hmac16(salt, String(ip || 'unknown') + '|' + day);
}

/** Устройство: HMAC(соль, «dev|» + случайный номер со страницы). Сам номер не хранится. */
export async function deviceId(device, salt) {
  return hmac16(salt, 'dev|' + device);
}

/** Соль для хешей. Раньше брался ключ уведомлений, он остаётся запасным для старых развёртываний. */
export function reportSalt(env) {
  return env.REPORT_SALT || env.REPORT_SECRET || env.VAPID_PRIVATE_KEY || null;
}

/** Номер устройства со страницы: 16–64 знака из букв, цифр, «-» и «_». Иначе null. */
export function normalizeDevice(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(value) ? value : null;
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

  const salt = reportSalt(env);
  if (!salt) return [{ error: 'unavailable' }, 503];
  const who = await reporterId(ip, nowMs, salt);
  // Старая страница номера устройства не присылает: тогда устройством считается сам IP-хеш.
  const device = normalizeDevice(body.device);
  const dev = device ? await deviceId(device, salt) : who;

  const devRow = await deviceLast(env, dev, point.id, nowMs);
  if (devRow && nowMs - devRow < DEVICE_INTERVAL_MS) {
    return [{ error: 'too_often', retryAfter: Math.ceil((DEVICE_INTERVAL_MS - (nowMs - devRow)) / 1000) }, 429];
  }

  const ipHour = await env.DB.prepare('SELECT COUNT(*) AS c FROM reports WHERE who = ? AND at > ?')
    .bind(who, nowMs - REPORT_WINDOW_MS).first();
  if (ipHour && ipHour.c >= IP_PER_HOUR) return [{ error: 'too_often', retryAfter: 600 }, 429];
  const ipDay = await env.DB.prepare('SELECT COUNT(*) AS c FROM reports WHERE who = ? AND at > ?')
    .bind(who, nowMs - REPORT_KEEP_MS).first();
  if (ipDay && ipDay.c >= REPORTS_PER_DAY) return [{ error: 'too_many' }, 429];

  const total = await env.DB.prepare('SELECT COUNT(*) AS c FROM reports WHERE at > ?').bind(nowMs - REPORT_WINDOW_MS).first();
  if (total && total.c >= REPORTS_PER_HOUR_TOTAL) return [{ error: 'busy' }, 503];

  try {
    await env.DB.prepare('INSERT INTO reports(point, strength, at, who, dev) VALUES(?, ?, ?, ?, ?)')
      .bind(point.id, body.strength, nowMs, who, dev).run();
  } catch (e) {
    // База до миграции (нет колонки dev): отметка принимается по-старому.
    if (!/no column|has no column named dev/i.test(String(e && e.message))) throw e;
    await env.DB.prepare('INSERT INTO reports(point, strength, at, who) VALUES(?, ?, ?, ?)')
      .bind(point.id, body.strength, nowMs, who).run();
  }
  return [{ ok: true, point: point.id }, 200];
}

/** Последняя отметка этого устройства у точки (мс) или null. До миграции: по IP-хешу. */
async function deviceLast(env, dev, pointId, nowMs) {
  try {
    const row = await env.DB.prepare('SELECT MAX(at) AS last FROM reports WHERE dev = ? AND point = ? AND at > ?')
      .bind(dev, pointId, nowMs - DEVICE_INTERVAL_MS).first();
    return row && row.last ? row.last : null;
  } catch (e) {
    if (!/no such column: dev/i.test(String(e && e.message))) throw e;
    const row = await env.DB.prepare('SELECT MAX(at) AS last FROM reports WHERE who = ? AND point = ? AND at > ?')
      .bind(dev, pointId, nowMs - DEVICE_INTERVAL_MS).first();
    return row && row.last ? row.last : null;
  }
}

/**
 * Сводка за последний час: { window, total, confirm, points: { id: { count, devices, bright, last,
 * confirmed } } }. devices: сколько разных устройств; confirmed: их не меньше CONFIRM_DEVICES.
 * Только числа: кто и откуда, не отдаётся.
 */
export async function reportSummary(env, nowMs) {
  const head = "SELECT point, COUNT(*) AS c, SUM(CASE WHEN strength = 'bright' THEN 1 ELSE 0 END) AS b, MAX(at) AS last, ";
  const tail = ' FROM reports WHERE at > ? GROUP BY point';
  let results;
  try {
    ({ results } = await env.DB.prepare(head + 'COUNT(DISTINCT COALESCE(dev, who)) AS d' + tail).bind(nowMs - REPORT_WINDOW_MS).all());
  } catch (e) {
    if (!/no such column: dev/i.test(String(e && e.message))) throw e;
    ({ results } = await env.DB.prepare(head + 'COUNT(DISTINCT who) AS d' + tail).bind(nowMs - REPORT_WINDOW_MS).all());
  }
  const points = {};
  let total = 0;
  for (const r of results) {
    if (!Core.POINTS.some(p => p.id === r.point)) continue;
    points[r.point] = { count: r.c, devices: r.d, bright: r.b || 0, last: r.last, confirmed: r.d >= CONFIRM_DEVICES };
    total += r.c;
  }
  return { window: REPORT_WINDOW_MS / 60000, total, confirm: CONFIRM_DEVICES, points };
}

/** Удаление старых отметок — проходом по расписанию. */
export function purgeReports(env, nowMs) {
  return env.DB.prepare('DELETE FROM reports WHERE at < ?').bind(nowMs - REPORT_KEEP_MS).run();
}
