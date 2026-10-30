// Open-Meteo для страницы: GET /meteo?<те же параметры, что у api.open-meteo.com/v1/forecast>.
//
// С v84 страница идёт сюда первой, а напрямую, только если сервер не ответил. Причина: суточный
// лимит Open-Meteo (10 000 обращений) считается по адресу, и у посетителей за одним Wi-Fi или
// мобильным оператором он кончался; здесь же одна копия на всех. Копия хранится в памяти
// экземпляра и в D1 (noaa_cache, имя «meteo:<запрос>»), поэтому её видят все экземпляры worker'а:
// Cache API Cloudflare на адресе *.workers.dev не работает.
//
// Пустой ответ модели (Open-Meteo отвечает успешно, но без облачности, пока модель пересчитывается)
// считается сбоем: берётся резерв MET Norway. Что именно сломалось, meteoProxy возвращает строкой:
// api.js пишет её в журнал ошибок, и владелец узнаёт о новом виде сбоя в Telegram.
//
// Это не открытый прокси: только /v1/forecast, только перечисленные параметры с проверенными
// значениями, только запросы со страницы сайта (Origin из ALLOWED_ORIGINS).

import { metnoFallback } from './metno.js';

export const METEO_TTL_MS = 10 * 60 * 1000;
/** Последняя удачная копия выручает, если не ответили ни Open-Meteo, ни MET Norway. */
export const STALE_KEEP_MS = 3 * 60 * 60 * 1000;
const MAX_ENTRIES = 60;
const MAX_POINTS = 100;
const UPSTREAM = 'https://api.open-meteo.com/v1/forecast';

const LIST = /^[a-z0-9_]+(,[a-z0-9_]+)*$/;
const NUMBERS = /^-?\d{1,3}(\.\d{1,6})?(,-?\d{1,3}(\.\d{1,6})?)*$/;
const RULES = {
  latitude: v => NUMBERS.test(v) && v.split(',').length <= MAX_POINTS,
  longitude: v => NUMBERS.test(v) && v.split(',').length <= MAX_POINTS,
  current: v => LIST.test(v) && v.length <= 400,
  hourly: v => LIST.test(v) && v.length <= 400,
  models: v => LIST.test(v) && v.length <= 40,
  forecast_days: v => /^([1-9]|1[0-6])$/.test(v),
  forecast_hours: v => /^\d{1,3}$/.test(v) && Number(v) <= 384,
  past_days: v => /^\d{1,2}$/.test(v) && Number(v) <= 14,
  timezone: v => /^(UTC|GMT|auto|[A-Za-z_]+\/[A-Za-z_]+)$/.test(v),
  timeformat: v => v === 'unixtime' || v === 'iso8601'
};

/** Проверенный и упорядоченный запрос к Open-Meteo или null. Порядок — чтобы одинаковые совпадали в кэше. */
export function meteoUpstream(search) {
  const params = new URLSearchParams(search);
  const out = [];
  for (const [key, value] of params) {
    if (!RULES[key] || !RULES[key](value)) return null;
    if (out.some(([k]) => k === key)) return null;
    out.push([key, value]);
  }
  const has = key => out.some(([k]) => k === key);
  if (!has('latitude') || !has('longitude') || !(has('current') || has('hourly'))) return null;
  const lat = out.find(([k]) => k === 'latitude')[1].split(',').length;
  const lon = out.find(([k]) => k === 'longitude')[1].split(',').length;
  if (lat !== lon) return null;
  out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return UPSTREAM + '?' + out.map(([k, v]) => k + '=' + v).join('&');
}

// Память живёт, пока жив экземпляр worker'а: этого хватает, чтобы волна одинаковых запросов
// (например, все открывшие сайт в Мурманске) не уходила даже в базу каждый раз.
const memory = new Map();

export function clearMeteoCache() {
  memory.clear();
}

// Идущие запросы: одинаковые промахи кэша ждут один и тот же, а не уходят в Open-Meteo каждый.
const pending = new Map();

const savedName = upstream => 'meteo:' + upstream.slice(UPSTREAM.length);

/** Есть ли облачность в ответе: текущая или почасовая, хоть по одной точке (как meteoHasCloud у страницы). */
export function meteoHasCloud(body) {
  if (!/"cloud_cover"/.test(body)) return true;   // облачность не просили: проверять нечего
  let data;
  try { data = JSON.parse(body); } catch { return false; }
  const list = Array.isArray(data) ? data : [data];
  const real = v => v !== null && v !== undefined && Number.isFinite(Number(v));
  return list.some(d => d && ((d.current && real(d.current.cloud_cover)) ||
    (d.hourly && Array.isArray(d.hourly.cloud_cover) && d.hourly.cloud_cover.some(real))));
}

/**
 * Ответ для страницы: [тело (строка), статус, из запаса ли, что сломалось или null]. Копия
 * старше срока отдаётся с признаком: страница пробует другой путь и, если не вышло, показывает
 * её как сохранённую. opts.db: база с таблицей noaa_cache (общая копия для всех экземпляров).
 */
export async function meteoProxy(search, nowMs, fetchFn, opts = {}) {
  const upstream = meteoUpstream(search);
  if (!upstream) return [JSON.stringify({ error: 'bad_query' }), 400, false, null];
  const db = opts.db || null;

  let hit = memory.get(upstream);
  if (!hit || nowMs - hit.at >= METEO_TTL_MS) {
    const saved = await readSaved(db, upstream);
    if (saved && (!hit || saved.at > hit.at)) { hit = saved; remember(upstream, saved.body, saved.at); }
  }
  if (hit && nowMs - hit.at < METEO_TTL_MS) return [hit.body, 200, false, null];

  let job = pending.get(upstream);
  if (!job) {
    job = fetchFresh(upstream, nowMs, fetchFn, db);
    pending.set(upstream, job);
    job.then(() => pending.delete(upstream), () => pending.delete(upstream));
  }
  const [body, status, note] = await job;
  if (status === 200) return [body, 200, false, note];
  if (hit && nowMs - hit.at < STALE_KEEP_MS) return [hit.body, 200, true, note];
  return [body, status, false, note];
}

/** Open-Meteo, затем MET Norway; удачный ответ запоминается. [тело, статус, что сломалось или null]. */
async function fetchFresh(upstream, nowMs, fetchFn, db) {
  let failure;
  let why;
  try {
    const res = await fetchFn(upstream, { signal: AbortSignal.timeout(10000) });
    const body = await res.text();
    if (res.ok && meteoHasCloud(body)) {
      await keep(db, upstream, body, nowMs);
      return [body, 200, null];
    }
    if (res.ok) {
      why = 'пустой ответ модели';
      failure = [JSON.stringify({ error: 'empty_model' }), 502];
    } else {
      why = 'ответ ' + res.status;
      failure = [JSON.stringify({ error: 'upstream', status: res.status }), res.status === 429 ? 429 : 502];
    }
  } catch {
    why = 'нет ответа';
    failure = [JSON.stringify({ error: 'upstream_unreachable' }), 502];
  }

  // Open-Meteo не ответил: резерв — MET Norway в том же формате (src/metno.js), затем (в
  // meteoProxy) последняя удачная копия не старше 3 часов. Резервный ответ хранится так же, 10 минут.
  const backup = await metnoFallback(upstream, nowMs, fetchFn);
  if (backup) {
    const body = JSON.stringify(backup);
    await keep(db, upstream, body, nowMs);
    return [body, 200, 'Open-Meteo: ' + why + ', взят резерв MET Norway'];
  }
  return [...failure, 'Open-Meteo: ' + why + ', резерва нет'];
}

function remember(key, body, at) {
  memory.set(key, { body, at });
  if (memory.size > MAX_ENTRIES) memory.delete(memory.keys().next().value);
}

/** Копия в память и в базу. Без базы (или до миграции): только память. */
async function keep(db, upstream, body, nowMs) {
  remember(upstream, body, nowMs);
  if (!db) return;
  try {
    await db.prepare('INSERT INTO noaa_cache (name, body, at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(name) DO UPDATE SET body = excluded.body, at = excluded.at').bind(savedName(upstream), body, nowMs).run();
  } catch (e) { /* копия в базе: только ускорение */ }
}

async function readSaved(db, upstream) {
  if (!db) return null;
  try {
    const row = await db.prepare('SELECT body, at FROM noaa_cache WHERE name = ?').bind(savedName(upstream)).first();
    return row ? { body: row.body, at: row.at } : null;
  } catch (e) {
    return null;
  }
}

/** Уборка копий старше срока запаса: проходом по расписанию (копий столько, сколько разных запросов). */
export function purgeMeteo(env, nowMs) {
  return env.DB.prepare("DELETE FROM noaa_cache WHERE name LIKE 'meteo:%' AND at < ?").bind(nowMs - STALE_KEEP_MS).run();
}
