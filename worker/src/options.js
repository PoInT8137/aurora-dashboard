// Настройки уведомлений подписчика (выбираются на сайте, хранятся рядом с подпиской):
//
//   min_level = 'mid' — сообщать уже о среднем шансе, а не только о высоком;
//   sky = 1           — «небо скоро откроется»: сейчас сплошные облака, но сияние возможно
//                       (Kp дотягивает до порога точки), а в ближайшие 3 часа модель
//                       обещает просвет в тёмное время.
//
// Основная рассылка (переход в «высокий» — check.js) от этих настроек не зависит и идёт
// первой; здесь — дополнительные сигналы. Любой сбой здесь основную рассылку не трогает.

import '../../core.js';
import { sendPush } from './push.js';
import { alertMessage, skyMessage, DEFAULT_LANG } from './messages.js';

const Core = globalThis.AuroraCore;

/** Сигнал «небо откроется» — не чаще раза в 8 часов: одна ночь — один сигнал. */
export const SKY_COOLDOWN_MS = 8 * 60 * 60 * 1000;
/** Насколько вперёд смотрим прогноз облаков. */
export const SKY_LOOKAHEAD_MS = 3 * 60 * 60 * 1000;
/** Просвет — облачность не больше этого (балл облачности ≥ 2). */
export const SKY_CLEAR = 50;
/** Не раньше чем через час после любого уведомления о сиянии. */
const AFTER_ALERT_MS = 60 * 60 * 1000;

const RANK = { low: 0, mid: 1, high: 2 };

/**
 * Начало текущего «среднего или выше» по точке: переход из «низкого». Первое наблюдение —
 * точка отсчёта (0), как у «высокого» в check.js.
 */
export function nextMidSince(prev, level, nowMs) {
  const since = prev && prev.mid_since ? prev.mid_since : 0;
  if (RANK[level] >= 1 && prev && RANK[prev.level] === 0) return nowMs;
  return since;
}

/**
 * Первый час просвета: время (мс) и облачность, или null. Час — в пределах SKY_LOOKAHEAD_MS,
 * тёмный и с облачностью не больше SKY_CLEAR.
 */
export function clearingHour(point, hours, nowMs) {
  for (const h of hours || []) {
    if (h.time <= nowMs || h.time - nowMs > SKY_LOOKAHEAD_MS) continue;
    if (h.cloud > SKY_CLEAR) continue;
    if (Core.solarAltitude(new Date(h.time), point.lat, point.lon) > Core.DARK_USABLE) continue;
    return h;
  }
  return null;
}

/** Повод для «небо откроется» по точке: сейчас закрыто, сияние возможно, просвет скоро. */
export function skyChance(point, kp, cloud, nowMs) {
  if (!kp || !cloud) return null;
  if (Core.cloudScore(cloud.value, cloud.conflict) !== 0) return null;   // и так видно или просветы есть
  if (Core.kpScoreAt(kp.value, point) < 1) return null;                  // сияния не ждём
  return clearingHour(point, cloud.hours, nowMs);
}

/** Рассылка набора подписчиков; column — какая отметка времени ставится при успехе. */
async function deliver(env, nowMs, fetchFn, subs, messageFor, column, summary, key) {
  const updates = [];
  const statuses = await Promise.all(subs.map(s => sendPush(s.endpoint, env, nowMs, fetchFn)));
  subs.forEach((sub, i) => {
    const status = statuses[i];
    if (status >= 200 && status < 300) {
      summary[key]++;
      updates.push(env.DB.prepare('UPDATE subs SET ' + column + ' = ?, msg = ?, fails = 0 WHERE id = ?')
        .bind(nowMs, JSON.stringify(messageFor(sub)), sub.id));
    } else if (status === 404 || status === 410) {
      summary.gone++;
      updates.push(env.DB.prepare('DELETE FROM subs WHERE id = ?').bind(sub.id));
    } else {
      summary.failed++;
      updates.push(env.DB.prepare('UPDATE subs SET fails = fails + 1 WHERE id = ?').bind(sub.id));
    }
  });
  if (updates.length) await env.DB.batch(updates);
}

const notQuiet = date => c => !Core.inQuietHours(date, c.tz || undefined, c.quiet_from, c.quiet_to);

/**
 * Дополнительные сигналы после основной рассылки. ctx: { points, clouds, kp, levels, sentIds, budget }.
 * Возвращает оставшийся бюджет отправок.
 */
export async function optionAlerts(env, nowMs, fetchFn, ctx, summary) {
  let budget = ctx.budget;
  const date = new Date(nowMs);
  summary.midSent = 0;
  summary.skySent = 0;

  // «Средний или выше» по точкам: отметка начала хранится в point_state.mid_since.
  const { results: rows } = await env.DB.prepare('SELECT point, level, mid_since FROM point_state').all();
  const prevState = new Map(rows.map(r => [r.point, r]));
  const writes = [];
  const midSince = {};
  ctx.points.forEach(point => {
    const level = summary.levels[point.id];
    if (!level) return;
    const since = nextMidSince(ctx.prevLevels.get(point.id) && { ...prevState.get(point.id), level: ctx.prevLevels.get(point.id) }, level, nowMs);
    midSince[point.id] = since;
    writes.push(env.DB.prepare('UPDATE point_state SET mid_since = ? WHERE point = ?').bind(since, point.id));
  });
  if (writes.length) await env.DB.batch(writes);

  for (let i = 0; i < ctx.points.length && budget > 0; i++) {
    const point = ctx.points[i];
    const level = summary.levels[point.id];
    const since = midSince[point.id];
    if (!level || RANK[level] < 1 || !since) continue;

    const { results } = await env.DB.prepare(
      "SELECT id, endpoint, lang, quiet_from, quiet_to, tz FROM subs WHERE point = ? AND min_level = 'mid' " +
      'AND created < ? AND last_sent < ? AND ? - last_sent >= ? ORDER BY last_sent'
    ).bind(point.id, since, since, nowMs, ctx.cooldownMs).all();
    const subs = results.filter(s => !ctx.sentIds.has(s.id)).filter(notQuiet(date)).slice(0, budget);
    if (!subs.length) continue;
    budget -= subs.length;
    subs.forEach(s => ctx.sentIds.add(s.id));
    const cloud = ctx.clouds[i];
    await deliver(env, nowMs, fetchFn, subs,
      s => alertMessage(point, ctx.kp, cloud, nowMs, s.lang || DEFAULT_LANG, level),
      'last_sent', summary, 'midSent');
  }

  // «Небо скоро откроется».
  for (let i = 0; i < ctx.points.length && budget > 0; i++) {
    const point = ctx.points[i];
    const clear = skyChance(point, ctx.kp, ctx.clouds[i], nowMs);
    if (!clear) continue;

    const { results } = await env.DB.prepare(
      'SELECT id, endpoint, lang, quiet_from, quiet_to, tz FROM subs WHERE point = ? AND sky = 1 ' +
      'AND ? - last_sky >= ? AND ? - last_sent >= ? ORDER BY last_sky'
    ).bind(point.id, nowMs, SKY_COOLDOWN_MS, nowMs, AFTER_ALERT_MS).all();
    const subs = results.filter(s => !ctx.sentIds.has(s.id)).filter(notQuiet(date)).slice(0, budget);
    if (!subs.length) continue;
    budget -= subs.length;
    subs.forEach(s => ctx.sentIds.add(s.id));
    await deliver(env, nowMs, fetchFn, subs,
      s => skyMessage(point, ctx.kp, clear, nowMs, s.lang || DEFAULT_LANG, s.tz),
      'last_sky', summary, 'skySent');
  }
  return budget;
}
