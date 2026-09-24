// Проверка по расписанию: раз в 10 минут считает вердикт по каждой точке, на
// которую есть подписчики, и шлёт push при переходе в «Высокий».
//
// Уровень считает общее ядро (core.js) — то же, что на сайте, поэтому
// уведомление не может расходиться с тем, что человек увидит в приложении.

import '../../core.js';
import { sendPush } from './push.js';
import { alertMessage, bzMessage, DEFAULT_LANG } from './messages.js';
import { loadBz, loadBzState, saveBzState, nextBzState, bzLevel, bzPointOk, BZ_COOLDOWN_MS, BZ_AFTER_ALERT_MS } from './bz.js';
import { purgeReports } from './reports.js';
import { optionAlerts } from './options.js';

export { alertMessage };

const Core = globalThis.AuroraCore;

/** Не чаще раза в 3 часа на человека: суббури идут волнами с таким интервалом. */
export const COOLDOWN_MS = 3 * 60 * 60 * 1000;

/**
 * На бесплатном тарифе у worker'а лимит 50 внешних запросов за запуск.
 * Часть уходит на данные и базу, остальное — на отправку. Если подписчиков
 * больше, остальные получат push при следующем запуске (через 10 минут).
 */
export const MAX_SENDS_PER_RUN = 35;

/** Данные старше этого не годятся, чтобы будить человека. */
const KP_MAX_AGE_MS = 4 * 60 * 60 * 1000;

/** После стольких неудач подряд подписка считается мёртвой. */
const MAX_FAILS = 5;

const URL_KP = 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json';
const URL_KP_ALT = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';

async function loadKp(nowMs, fetchFn) {
  for (const url of [URL_KP, URL_KP_ALT]) {
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const kp = Core.readKpSeries(await res.json());
      // Устаревшее значение хуже отсутствующего: по нему нельзя будить.
      if (kp.time && nowMs - kp.time.getTime() <= KP_MAX_AGE_MS) return kp;
    } catch { /* пробуем резервный источник */ }
  }
  return null;
}

/** Почасовой прогноз облачности из ответа: [{ time (мс), cloud (%) }] — для «небо откроется». */
function readHours(item) {
  const hourly = item && item.hourly;
  if (!hourly || !Array.isArray(hourly.time)) return [];
  const out = [];
  hourly.time.forEach((t, i) => {
    const time = Core.parseUtc(t);
    let value = Core.effectiveCloud(Core.readLayers(hourly, i));
    if (value === null) value = Core.num(hourly.cloud_cover ? hourly.cloud_cover[i] : null);
    if (time && value !== null) out.push({ time: time.getTime(), cloud: Math.round(value) });
  });
  return out;
}

/**
 * Облачность по всем точкам одним запросом; массив в порядке points. К облачности «сейчас»
 * приложен почасовой прогноз на 4 часа (cloud.hours) — тем же запросом.
 */
async function loadClouds(points, fetchFn) {
  const url = 'https://api.open-meteo.com/v1/forecast'
    + '?latitude=' + points.map(p => p.lat).join(',')
    + '&longitude=' + points.map(p => p.lon).join(',')
    + '&current=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high'
    + '&hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high&forecast_hours=4'
    + '&models=' + Core.WEATHER_MODEL
    + '&timezone=UTC';

  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json();
    // Для одной точки API отдаёт объект, для нескольких — массив.
    const list = Array.isArray(data) ? data : [data];
    if (list.length !== points.length) return null;
    return list.map(item => {
      const cloud = Core.cloudFromCurrent(item && item.current);
      if (cloud) cloud.hours = readHours(item);
      return cloud;
    });
  } catch {
    return null;
  }
}

/** Причины пропуска прохода → короткие коды для пульса. */
const SKIP_CODES = {
  'нет подписчиков': 'no_subs',
  'нет свежего Kp': 'no_kp',
  'нет данных об облачности': 'no_cloud'
};

/**
 * Пульс: время и итог прохода. Запись — лучшее, что можно сделать: если таблицы ещё нет
 * (база до миграции) или запись не удалась, сама проверка от этого не страдает.
 */
async function recordHeartbeat(env, nowMs, outcome) {
  try {
    await env.DB.prepare(
      'INSERT INTO heartbeat(id, at, outcome) VALUES(1, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET at = excluded.at, outcome = excluded.outcome'
    ).bind(nowMs, outcome).run();
  } catch (e) {
    console.error('пульс не записан: ' + (e && e.message));
  }
}

/**
 * Один проход по расписанию и его пульс. nowMs и fetchFn подменяются в тестах.
 * Возвращает сводку для журнала и тестов.
 */
export async function runCheck(env, nowMs = Date.now(), fetchFn = fetch) {
  // Отметки «Вижу сияние» старше суток не нужны. Сбой уборки проверке не мешает.
  try { await purgeReports(env, nowMs); } catch (e) { console.error('отметки не убраны: ' + (e && e.message)); }

  let summary;
  try {
    summary = await checkOnce(env, nowMs, fetchFn);
  } catch (error) {
    await recordHeartbeat(env, nowMs, 'error');
    throw error;
  }
  await recordHeartbeat(env, nowMs, summary.skipped ? (SKIP_CODES[summary.skipped] || 'error') : 'ok');
  return summary;
}

async function checkOnce(env, nowMs, fetchFn) {
  const { results: rows } = await env.DB.prepare('SELECT DISTINCT point FROM subs').all();
  const points = rows
    .map(r => Core.POINTS.find(p => p.id === r.point))
    .filter(Boolean);

  // Нет подписчиков — нет и запросов к внешним сервисам.
  if (!points.length) return { skipped: 'нет подписчиков' };

  const [kp, clouds, bzReading] = await Promise.all([
    loadKp(nowMs, fetchFn), loadClouds(points, fetchFn), loadBz(nowMs, fetchFn)
  ]);

  // При неполных данных уровень не считаем вовсе: он вышел бы «средним», а на
  // следующем удачном проходе «высокий» выглядел бы переходом и разбудил зря.
  if (kp === null) return { skipped: 'нет свежего Kp' };
  if (clouds === null) return { skipped: 'нет данных об облачности' };

  const { results: stateRows } = await env.DB.prepare('SELECT point, level, high_since FROM point_state').all();
  const prevState = new Map(stateRows.map(r => [r.point, r]));
  const prevLevels = new Map(stateRows.map(r => [r.point, r.level]));
  const sentIds = new Set();   // кому уже ушло в этот проход: дополнительные сигналы не дублируют

  const summary = { levels: {}, sent: 0, gone: 0, failed: 0 };
  const stateWrites = [];
  const targets = [];   // { point, cloud, alt, highSince }

  points.forEach((point, i) => {
    const cloud = clouds[i];
    const q = Core.quickLevel(kp.value, cloud, point, new Date(nowMs));
    if (!q || !cloud) return;                       // по этой точке считать не из чего

    const prev = prevState.get(point.id);
    summary.levels[point.id] = q.level;

    // Момент начала «высокого»: переход из другого уровня. Первое наблюдение
    // за точкой — только точка отсчёта (0): подписчиков не будим тем, что
    // «высокий» просто оказался на месте, когда мы начали смотреть.
    let highSince = prev ? prev.high_since : 0;
    if (q.level === 'high' && prev && prev.level !== 'high') highSince = nowMs;

    stateWrites.push(env.DB.prepare(
      'INSERT INTO point_state(point, level, high_since, updated) VALUES(?, ?, ?, ?) ' +
      'ON CONFLICT(point) DO UPDATE SET level = excluded.level, ' +
      'high_since = excluded.high_since, updated = excluded.updated'
    ).bind(point.id, q.level, highSince, nowMs));

    if (q.level === 'high' && highSince > 0) targets.push({ point, cloud, alt: q.alt, highSince });
  });

  if (stateWrites.length) await env.DB.batch(stateWrites);

  // Кому слать: подписался до начала этого «высокого», ещё не получал о нём
  // сообщения и не получал ничего в последние 3 часа. Выборка повторяется на
  // каждом проходе, поэтому лимит на число отправок просто растягивает рассылку
  // на несколько проходов, а не теряет получателей.
  const updates = [];
  let budget = MAX_SENDS_PER_RUN;

  for (const t of targets) {
    if (budget <= 0) break;

    // Тихие часы считаются по поясу подписчика, а он лежит в базе строкой, поэтому отбор по ним —
    // здесь, а не в SQL. Отложенные не теряются: пока «высокий» держится, они остаются подходящими
    // и получат сигнал первым же проходом после тихих часов. Пропущенные не тратят лимит отправок.
    const { results: candidates } = await env.DB.prepare(
      'SELECT id, endpoint, lang, quiet_from, quiet_to, tz FROM subs WHERE point = ? AND created < ? ' +
      'AND last_sent < ? AND ? - last_sent >= ? ORDER BY last_sent'
    ).bind(t.point.id, t.highSince, t.highSince, nowMs, COOLDOWN_MS).all();

    const date = new Date(nowMs);
    const subs = candidates
      .filter(c => !Core.inQuietHours(date, c.tz || undefined, c.quiet_from, c.quiet_to))
      .slice(0, budget);

    if (!subs.length) continue;
    budget -= subs.length;
    subs.forEach(s => sentIds.add(s.id));

    // Текст собирается на языке каждого подписчика; одинаковые не пересчитываются.
    const texts = new Map();
    const messageFor = sub => {
      const lang = sub.lang || DEFAULT_LANG;
      if (!texts.has(lang)) texts.set(lang, JSON.stringify(alertMessage(t.point, kp, t.cloud, nowMs, lang)));
      return texts.get(lang);
    };
    const statuses = await Promise.all(subs.map(s => sendPush(s.endpoint, env, nowMs, fetchFn)));

    subs.forEach((sub, i) => {
      const status = statuses[i];
      if (status >= 200 && status < 300) {
        summary.sent++;
        updates.push(env.DB.prepare('UPDATE subs SET last_sent = ?, msg = ?, fails = 0 WHERE id = ?')
          .bind(nowMs, messageFor(sub), sub.id));
      } else if (status === 404 || status === 410) {
        summary.gone++;                               // человек отозвал подписку или сменил браузер
        updates.push(env.DB.prepare('DELETE FROM subs WHERE id = ?').bind(sub.id));
      } else {
        summary.failed++;
        updates.push(env.DB.prepare('UPDATE subs SET fails = fails + 1 WHERE id = ?').bind(sub.id));
      }
    });
  }

  if (updates.length) {
    updates.push(env.DB.prepare('DELETE FROM subs WHERE fails >= ?').bind(MAX_FAILS));
    await env.DB.batch(updates);
  }

  // Настройки подписчиков: «средний шанс» и «небо откроется». Сбой — только в журнал.
  try {
    budget = await optionAlerts(env, nowMs, fetchFn, {
      points, clouds, kp, prevLevels, sentIds, budget, cooldownMs: COOLDOWN_MS
    }, summary);
  } catch (e) {
    summary.optionsError = true;
    console.error('дополнительные сигналы не проверены: ' + (e && e.message));
  }

  // Ранний сигнал — после основных уведомлений: кто только что получил «высокий шанс», тому он
  // уже не нужен. Сбой здесь (например, база ещё без таблицы sw_state) основную рассылку не трогает.
  try {
    await bzAlerts(env, nowMs, fetchFn, bzReading, points, clouds, summary, budget);
  } catch (e) {
    summary.bzError = true;
    console.error('ранний сигнал Bz не проверен: ' + (e && e.message));
  }

  return summary;
}

/**
 * Ранний сигнал «Bz повернул на юг» подписчикам точек, где темно и облака не сплошные, а уровень
 * ещё не «высокий» (иначе уже ушло основное уведомление). Один раз на эпизод южного поля и не
 * чаще раза в 6 часов на человека; тихие часы соблюдаются так же, как для основных уведомлений.
 */
async function bzAlerts(env, nowMs, fetchFn, reading, points, clouds, summary, budget) {
  const state = nextBzState(await loadBzState(env), reading, nowMs);
  await saveBzState(env, state);
  const level = bzLevel(state, nowMs);
  summary.bz = { value: state.bz, level };
  summary.bzSent = 0;
  if (!level || budget <= 0) return;

  const date = new Date(nowMs);
  const updates = [];

  for (let i = 0; i < points.length && budget > 0; i++) {
    const point = points[i];
    const cloud = clouds[i];
    if (summary.levels[point.id] === 'high' || !bzPointOk(point, cloud, nowMs)) continue;

    const { results: candidates } = await env.DB.prepare(
      'SELECT id, endpoint, lang, quiet_from, quiet_to, tz FROM subs WHERE point = ? AND created < ? ' +
      'AND last_bz < ? AND ? - last_bz >= ? AND ? - last_sent >= ? ORDER BY last_bz'
    ).bind(point.id, state.southSince, state.southSince, nowMs, BZ_COOLDOWN_MS, nowMs, BZ_AFTER_ALERT_MS).all();

    const subs = candidates
      .filter(c => !Core.inQuietHours(date, c.tz || undefined, c.quiet_from, c.quiet_to))
      .slice(0, budget);
    if (!subs.length) continue;
    budget -= subs.length;

    const statuses = await Promise.all(subs.map(s => sendPush(s.endpoint, env, nowMs, fetchFn)));
    subs.forEach((sub, k) => {
      const status = statuses[k];
      if (status >= 200 && status < 300) {
        summary.bzSent++;
        const msg = JSON.stringify(bzMessage(point, state.bz, cloud, level, nowMs, sub.lang || DEFAULT_LANG));
        updates.push(env.DB.prepare('UPDATE subs SET last_bz = ?, msg = ?, fails = 0 WHERE id = ?').bind(nowMs, msg, sub.id));
      } else if (status === 404 || status === 410) {
        summary.gone++;
        updates.push(env.DB.prepare('DELETE FROM subs WHERE id = ?').bind(sub.id));
      } else {
        summary.failed++;
        updates.push(env.DB.prepare('UPDATE subs SET fails = fails + 1 WHERE id = ?').bind(sub.id));
      }
    });
  }

  if (updates.length) {
    updates.push(env.DB.prepare('DELETE FROM subs WHERE fails >= ?').bind(MAX_FAILS));
    await env.DB.batch(updates);
  }
}
