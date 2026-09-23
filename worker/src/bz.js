// Ранний сигнал: магнитное поле солнечного ветра (Bz) уверенно повернуло на юг.
//
// Kp — усреднение за три часа и запаздывает; Bz, измеренный спутниками в точке L1, опережает
// сияние на 30–60 минут (столько ветер идёт до Земли). Поминутный ряд NOAA весит 1,6 МБ —
// разбирать его раз в 10 минут бесплатному worker'у не по силам, поэтому берётся сводка
// на 60 байт (текущий Bz), а длительность «южного» поля сервер считает сам между проходами
// и хранит в таблице sw_state.
//
// Пороги — те же, что у карточки солнечного ветра на сайте (solarWindSummary в core.js):
// strong — Bz ≤ −10 нТл, south — ≤ −5 нТл держится долго. Шагом в 10 минут:
//   strong: Bz ≤ −10 и поле южное (≤ −5) не меньше 10 минут — два прохода подряд;
//   south:  Bz ≤ −5 не меньше 20 минут — три прохода подряд.

import '../../core.js';

const Core = globalThis.AuroraCore;

export const URL_BZ = 'https://services.swpc.noaa.gov/products/summary/solar-wind-mag-field.json';

/** Сводка старше этого — не повод будить: спутник или NOAA молчат. */
export const BZ_MAX_AGE_MS = 20 * 60 * 1000;

export const BZ_SOUTH = -5;
export const BZ_STRONG = -10;
const STRONG_FOR_MS = 10 * 60 * 1000;
const SOUTH_FOR_MS = 20 * 60 * 1000;

/** Одному человеку — не чаще раза в 6 часов: южное поле может мигать весь вечер. */
export const BZ_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** Сразу после уведомления о высоком шансе ранний сигнал уже не нужен. */
export const BZ_AFTER_ALERT_MS = 60 * 60 * 1000;

/**
 * Сводка NOAA [{ bt, bz_gsm, time_tag }] → { bz, time (мс) } или null, если она
 * не разбирается или устарела.
 */
export function readBz(data, nowMs) {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  const bz = Core.num(row.bz_gsm);
  const date = Core.parseUtc(row.time_tag);
  if (bz === null || !date) return null;
  const time = date.getTime();
  if (time > nowMs + 5 * 60 * 1000 || nowMs - time > BZ_MAX_AGE_MS) return null;
  return { bz, time };
}

/**
 * Новое состояние: с какого момента поле южное (≤ −5). Южное и было — начало сохраняется;
 * повернуло на север или данных нет — сбрасывается. Пропуск данных тоже сбрасывает: без
 * отсчётов между проходами нельзя утверждать, что поле всё это время было южным.
 */
export function nextBzState(prev, reading, nowMs) {
  if (!reading || reading.bz > BZ_SOUTH) return { bz: reading ? reading.bz : null, at: nowMs, southSince: 0 };
  const continuing = prev && prev.southSince > 0 && nowMs - prev.at <= BZ_MAX_AGE_MS;
  return { bz: reading.bz, at: nowMs, southSince: continuing ? prev.southSince : nowMs };
}

/** Уровень по состоянию: 'strong' | 'south' | null (повода нет). */
export function bzLevel(state, nowMs) {
  if (!state || !state.southSince || state.bz === null) return null;
  const southFor = nowMs - state.southSince;
  if (state.bz <= BZ_STRONG && southFor >= STRONG_FOR_MS) return 'strong';
  if (state.bz <= BZ_SOUTH && southFor >= SOUTH_FOR_MS) return 'south';
  return null;
}

/**
 * Годится ли точка для раннего сигнала: небо тёмное и облака не сплошные. Kp не нужен —
 * смысл сигнала в том, что Kp ещё не успел вырасти.
 */
export function bzPointOk(point, cloud, nowMs) {
  if (!cloud) return false;
  const alt = Core.solarAltitude(new Date(nowMs), point.lat, point.lon);
  if (alt > Core.DARK_USABLE) return false;
  return Core.cloudScore(cloud.value, cloud.conflict) >= 1;
}

/** Текущая сводка Bz; null — нет данных (ранний сигнал в этот проход не проверяется). */
export async function loadBz(nowMs, fetchFn) {
  try {
    const res = await fetchFn(URL_BZ, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    return readBz(await res.json(), nowMs);
  } catch {
    return null;
  }
}

/** Прошлое состояние из базы (одна строка) или null. */
export async function loadBzState(env) {
  const row = await env.DB.prepare('SELECT bz, at, south_since FROM sw_state WHERE id = 1').first();
  return row ? { bz: row.bz, at: row.at, southSince: row.south_since } : null;
}

export function saveBzState(env, state) {
  return env.DB.prepare(
    'INSERT INTO sw_state(id, bz, at, south_since) VALUES(1, ?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET bz = excluded.bz, at = excluded.at, south_since = excluded.south_since'
  ).bind(state.bz, state.at, state.southSince).run();
}
