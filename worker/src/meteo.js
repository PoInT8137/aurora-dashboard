// Запасной путь к Open-Meteo для страницы: GET /meteo?<те же параметры, что у api.open-meteo.com/v1/forecast>.
//
// Сайт запрашивает Open-Meteo напрямую, а сюда приходит, только если прямой запрос не прошёл:
// сеть или VPN не пускает к api.open-meteo.com, адрес исчерпал суточный лимит Open-Meteo (тогда
// ответ 429 приходит без CORS-заголовков, и браузер видит «нет соединения») и т. п. Сервер
// уведомлений и так ходит в Open-Meteo каждые 10 минут.
//
// Это не открытый прокси: только /v1/forecast, только перечисленные параметры с проверенными
// значениями, только запросы со страницы сайта (Origin из ALLOWED_ORIGINS). Ответы хранятся
// в памяти worker'а 10 минут — облачность модель всё равно пересчитывает раз в час.

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
// (например, все открывшие сайт в Мурманске) не уходила в Open-Meteo каждый раз.
const memory = new Map();

export function clearMeteoCache() {
  memory.clear();
}

/** Ответ для страницы: [тело (строка), статус]. */
export async function meteoProxy(search, nowMs, fetchFn) {
  const upstream = meteoUpstream(search);
  if (!upstream) return [JSON.stringify({ error: 'bad_query' }), 400];

  const hit = memory.get(upstream);
  if (hit && nowMs - hit.at < METEO_TTL_MS) return [hit.body, 200];

  let failure;
  try {
    const res = await fetchFn(upstream, { signal: AbortSignal.timeout(10000) });
    const body = await res.text();
    if (res.ok) {
      remember(upstream, body, nowMs);
      return [body, 200];
    }
    failure = [JSON.stringify({ error: 'upstream', status: res.status }), res.status === 429 ? 429 : 502];
  } catch {
    failure = [JSON.stringify({ error: 'upstream_unreachable' }), 502];
  }

  // Open-Meteo не ответил: резерв — MET Norway в том же формате (src/metno.js), затем последняя
  // удачная копия не старше 3 часов. Резервный ответ хранится так же, 10 минут.
  const backup = await metnoFallback(upstream, nowMs, fetchFn);
  if (backup) {
    const body = JSON.stringify(backup);
    remember(upstream, body, nowMs);
    return [body, 200];
  }
  if (hit && nowMs - hit.at < STALE_KEEP_MS) return [hit.body, 200];
  return failure;
}

function remember(key, body, nowMs) {
  memory.set(key, { body, at: nowMs });
  if (memory.size > MAX_ENTRIES) memory.delete(memory.keys().next().value);
}
