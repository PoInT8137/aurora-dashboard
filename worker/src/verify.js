// Проверка прогноза: вечером сервер записывает, какой шанс на ночь обещает прогноз для каждой
// из семи точек, а утром — каким он оказался на самом деле. Из этого — честная статистика
// «прогноз совпал в N ночах из M» на сайте.
//
// Правила оценки — те же, что у окна наблюдения на сайте: ночь — первый непрерывный тёмный
// отрезок (Солнце ниже −6°), уровень часа — verdictLevel из ядра по Kp, облачности и высоте
// Солнца, уровень ночи — лучший из часов.
//
//   прогноз: Kp — прогноз NOAA по трёхчасовкам, облачность — прогноз ICON-EU;
//   факт:    Kp — измеренный NOAA (строки observed в том же файле), облачность — та же модель
//            за прошедшие часы (Open-Meteo, past_days=1).
//
// Шаги встроены в проверку по расписанию (раз в 10 минут), но выполняются раз в сутки:
// прогноз — с 17:00 до 20:00 по Москве, сверка — с 08:00 до 12:00. Не получилось (нет данных) —
// следующий проход попробует снова.

import '../../core.js';

const Core = globalThis.AuroraCore;

export const URL_KP = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json';
const HOUR = 60 * 60 * 1000;
const MSK = 3 * HOUR;                         // ночь называется датой вечера по московскому времени
export const FORECAST_HOURS_UTC = [14, 17];   // 17:00–20:00 МСК
export const ACTUAL_HOURS_UTC = [5, 9];       // 08:00–12:00 МСК
export const STATS_NIGHTS = 60;

const RANK = { low: 0, mid: 1, high: 2 };
const LEVELS = ['low', 'mid', 'high'];

/** Ключ ночи — дата вечера по Москве, «2026-09-24». */
export function nightKey(ms) {
  return new Date(ms + MSK).toISOString().slice(0, 10);
}

/** Kp по трёхчасовкам: [{ time (мс), value, observed }] по возрастанию. */
export function readKpRows(data) {
  return Core.normalizeRows(data).map(row => ({
    time: (Core.parseUtc(row.time_tag) || { getTime: () => NaN }).getTime(),
    value: Core.pickKpValue(row),
    observed: String(row.observed || '').toLowerCase() !== 'predicted'
  })).filter(r => Number.isFinite(r.time) && Number.isFinite(r.value)).sort((a, b) => a.time - b.time);
}

function kpAt(rows, time) {
  let value = null;
  for (const r of rows) {
    if (r.time <= time) value = r.value;
    else break;
  }
  return value;
}

/** Почасовая облачность из ответа Open-Meteo: [{ time (мс), cloud }]. */
export function readHourly(item) {
  const hourly = item && item.hourly;
  if (!hourly || !Array.isArray(hourly.time)) return [];
  const out = [];
  hourly.time.forEach((t, i) => {
    const time = Core.parseUtc(t);
    let value = Core.effectiveCloud(Core.readLayers(hourly, i));
    if (value === null) value = Core.num(hourly.cloud_cover ? hourly.cloud_cover[i] : null);
    if (time && value !== null) out.push({ time: time.getTime(), cloud: value });
  });
  return out;
}

/**
 * Уровень ночи: первый тёмный отрезок, начавшийся не раньше fromMs. Возвращает
 * { level, from } или null — темноты нет (белые ночи) или данных не хватило.
 * untilMs — для факта: ночь должна целиком закончиться до этого момента, иначе null
 * (часть часов была бы ещё прогнозом, а не измерением).
 */
export function nightLevel(point, hours, kpRows, fromMs, untilMs) {
  let best = -1;
  let from = null;
  let ended = false;
  for (const h of hours) {
    if (h.time < fromMs) continue;
    const alt = Core.solarAltitude(new Date(h.time), point.lat, point.lon);
    if (alt > Core.DARK_USABLE) {
      // Конец темноты — астрономия, его можно знать заранее; измеренными должны быть тёмные часы.
      if (from !== null) { ended = true; break; }
      continue;
    }
    if (untilMs !== undefined && h.time + HOUR > untilMs) break;   // тёмный час ещё не прошёл
    if (from === null) from = h.time;
    const kp = kpAt(kpRows, h.time);
    const ks = kp === null ? null : Core.kpScoreAt(kp, point);
    const level = RANK[Core.verdictLevel(ks, Core.cloudScore(h.cloud, false), alt)];
    if (level > best) best = level;
  }
  if (from === null) return null;
  if (untilMs !== undefined && !ended) return null;
  return { level: LEVELS[best], from };
}

function cloudsUrl(points, extra) {
  return 'https://api.open-meteo.com/v1/forecast'
    + '?latitude=' + points.map(p => p.lat).join(',')
    + '&longitude=' + points.map(p => p.lon).join(',')
    + '&hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high'
    + '&models=' + Core.WEATHER_MODEL + '&timezone=UTC' + extra;
}

async function getJson(url, fetchFn) {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('http ' + res.status);
  return res.json();
}

async function loadInputs(fetchFn, extra) {
  const points = Core.POINTS;
  const [kpData, cloudData] = await Promise.all([getJson(URL_KP, fetchFn), getJson(cloudsUrl(points, extra), fetchFn)]);
  const list = Array.isArray(cloudData) ? cloudData : [cloudData];
  if (list.length !== points.length) throw new Error('points count');
  return { kp: readKpRows(kpData), hours: list.map(readHourly) };
}

const inWindow = (nowMs, [from, to]) => {
  const h = new Date(nowMs).getUTCHours();
  return h >= from && h < to;
};

/**
 * Один шаг сверки за проход: вечером — записать прогноз на ночь, утром — факт за прошлую.
 * Возвращает, что сделано: 'forecast' | 'actual' | null.
 */
export async function verifyStep(env, nowMs, fetchFn) {
  if (inWindow(nowMs, FORECAST_HOURS_UTC)) {
    const night = nightKey(nowMs);
    const have = await env.DB.prepare('SELECT COUNT(*) AS c FROM verify WHERE night = ?').bind(night).first();
    if (have && have.c > 0) return null;

    // Kp: для уже начавшейся трёхчасовки — измеренный, дальше — прогноз (в файле они подряд).
    const { kp, hours } = await loadInputs(fetchFn, '&forecast_hours=24');
    const writes = [];
    Core.POINTS.forEach((point, i) => {
      const result = nightLevel(point, hours[i], kp, nowMs);
      if (!result) return;   // белые ночи — сверять нечего
      writes.push(env.DB.prepare('INSERT OR IGNORE INTO verify(night, point, forecast, actual, from_ms) VALUES(?, ?, ?, NULL, ?)')
        .bind(night, point.id, result.level, result.from));
    });
    if (writes.length) await env.DB.batch(writes);
    return writes.length ? 'forecast' : null;
  }

  if (inWindow(nowMs, ACTUAL_HOURS_UTC)) {
    const night = nightKey(nowMs - 24 * HOUR);
    const { results: open } = await env.DB.prepare('SELECT point, from_ms FROM verify WHERE night = ? AND actual IS NULL').bind(night).all();
    if (!open.length) return null;

    const { kp, hours } = await loadInputs(fetchFn, '&past_days=1&forecast_days=1');
    const measured = kp.filter(r => r.observed);
    const writes = [];
    for (const row of open) {
      const i = Core.POINTS.findIndex(p => p.id === row.point);
      if (i < 0) continue;
      // Тот же тёмный отрезок, что оценивал прогноз: начинается около from_ms.
      const result = nightLevel(Core.POINTS[i], hours[i], measured, row.from_ms - HOUR, nowMs);
      if (!result) continue;
      writes.push(env.DB.prepare('UPDATE verify SET actual = ? WHERE night = ? AND point = ?').bind(result.level, night, row.point));
    }
    if (writes.length) await env.DB.batch(writes);
    return writes.length ? 'actual' : null;
  }
  return null;
}

/**
 * Статистика за последние STATS_NIGHTS ночей со сверкой:
 * { nights, total, exact, offByOne, offByTwo, promised: { high: { n, high, mid, low }, ... } }.
 */
export async function verifyStats(env) {
  const { results } = await env.DB.prepare(
    'SELECT night, forecast, actual FROM verify WHERE actual IS NOT NULL AND night IN ' +
    '(SELECT DISTINCT night FROM verify WHERE actual IS NOT NULL ORDER BY night DESC LIMIT ?)'
  ).bind(STATS_NIGHTS).all();
  const stats = { nights: new Set(results.map(r => r.night)).size, total: results.length, exact: 0, offByOne: 0, offByTwo: 0, promised: {} };
  for (const level of LEVELS) stats.promised[level] = { n: 0, high: 0, mid: 0, low: 0 };
  for (const r of results) {
    if (!(r.forecast in RANK) || !(r.actual in RANK)) continue;
    const diff = Math.abs(RANK[r.forecast] - RANK[r.actual]);
    if (diff === 0) stats.exact++;
    else if (diff === 1) stats.offByOne++;
    else stats.offByTwo++;
    stats.promised[r.forecast].n++;
    stats.promised[r.forecast][r.actual]++;
  }
  return stats;
}
