// Журнал проходов и сверка с очевидцами (/timing); OVATION в уровне сервера из готовой копии в
// noaa_cache и её обновление по своему расписанию.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runCheck, refreshOvation, activityExtras, OVATION_CRON, OVATION_CACHE_MAX_MS } from '../src/check.js';
import { timingRows, timingSummary, timingText, nightOf, JOURNAL_KEEP_DAYS } from '../src/journal.js';
import worker from '../src/index.js';
import { makeEnv, makeFetch, addSub, NIGHT, MIN, HOUR } from './helpers.mjs';

const T0 = NIGHT;
const T1 = NIGHT + 10 * MIN;
const run = (env, now, world = {}) => runCheck(env, now, makeFetch(now, world));
const log = env => env.DB.raw.prepare('SELECT * FROM alert_log ORDER BY at, point').all().map(r => ({ ...r }));

/** Урезанная копия OVATION, как её кладёт /noaa/ovation: probability — у Мурманска и севернее. */
function ovationBody(now, probability, lonFrom = 17, lonTo = 53) {
  const coords = [];
  for (let lon = lonFrom; lon <= lonTo; lon++) for (let lat = 55; lat <= 80; lat++) coords.push([lon, lat, lat >= 69 && lon >= 30 && lon <= 36 ? probability : 3]);
  return JSON.stringify({ 'Observation Time': new Date(now - 5 * MIN).toISOString().slice(0, 19) + 'Z',
    'Forecast Time': new Date(now + 40 * MIN).toISOString().slice(0, 19) + 'Z', coordinates: coords });
}
const putOvation = (env, at, probability) => env.DB.raw.prepare(
  'INSERT INTO noaa_cache(name, body, at) VALUES(?, ?, ?) ON CONFLICT(name) DO UPDATE SET body = excluded.body, at = excluded.at'
).run('ovation', ovationBody(at, probability), at);

test('журнал: строка на точку за проход — признаки, уровень и сколько уведомлений ушло', async () => {
  const { env } = await makeEnv();
  addSub(env, { n: 1, created: NIGHT - 2 * HOUR });
  await run(env, T0, { kp: 0.3 });
  const summary = await run(env, T1, { kp: 4.3 });
  assert.equal(summary.sent, 1);
  assert.equal(summary.journal, 1);

  const rows = log(env);
  assert.equal(rows.length, 2);
  assert.deepEqual({ level: rows[0].level, sent: rows[0].sent_high }, { level: 'low', sent: 0 });
  const r = rows[1];
  assert.equal(r.at, T1);
  assert.equal(r.point, 'murmansk');
  assert.equal(r.level, 'high');
  assert.equal(r.ks, 3);
  assert.equal(r.cs, 3);
  assert.equal(r.source, 'kp');
  assert.equal(r.kp, 4.3);
  assert.equal(r.sent_high, 1);
  assert.equal(r.sent_bz, 0);
  assert.equal(r.bz, 3, 'Bz из сводки NOAA');
  assert.ok(r.alt < -12, 'полярная ночь');
  assert.ok(typeof r.cloud === 'number');
});

test('журнал: ранний сигнал Bz считается отдельно; старые строки убираются', async () => {
  const { env } = await makeEnv();
  addSub(env, { n: 1, created: NIGHT - 2 * HOUR });
  env.DB.raw.prepare("INSERT INTO alert_log(at, point, level) VALUES(?, 'murmansk', 'low')").run(T0 - (JOURNAL_KEEP_DAYS + 1) * 24 * HOUR);
  await run(env, T0, { kp: 0.7, bz: -12 });
  await run(env, T1, { kp: 0.7, bz: -12 });
  const rows = log(env);
  assert.equal(rows.length, 2, 'строка старше срока удалена');
  assert.equal(rows[1].sent_bz, 1);
  assert.equal(rows[1].bz_level, 'strong');
});

test('журнал: базы без таблицы — рассылка идёт как раньше', async () => {
  const { env } = await makeEnv();
  env.DB.raw.exec('DROP TABLE alert_log');
  addSub(env, { n: 1, created: NIGHT - 2 * HOUR });
  await run(env, T0, { kp: 0.3 });
  const summary = await run(env, T1, { kp: 4.3 });
  assert.equal(summary.sent, 1);
  assert.equal(summary.journalError, true);
});

test('OVATION из свежей копии поднимает уровень, как на сайте; устаревшая копия не в счёт', async () => {
  const { env } = await makeEnv();
  addSub(env, { n: 1, created: NIGHT - 2 * HOUR });
  await run(env, T0, { kp: 0.3 });                    // точка отсчёта: «низкий»
  putOvation(env, T1 - 3 * MIN, 60);
  const summary = await run(env, T1, { kp: 0.3 });
  assert.equal(summary.levels.murmansk, 'high', 'OVATION 60% в поле зрения и ясно — высокий');
  assert.equal(summary.sent, 1);
  const r = log(env).at(-1);
  assert.equal(r.source, 'ovation');
  assert.equal(r.ovation, 60);

  const old = await makeEnv();
  putOvation(old.env, T1 - OVATION_CACHE_MAX_MS - MIN, 60);
  const extra = await activityExtras(old.env, T1, makeFetch(T1));
  assert.deepEqual(extra.ovation, {});
});

test('расписание OVATION: загружает и кладёт урезанную копию; проверку и рассылку не запускает', async () => {
  const { env } = await makeEnv();
  addSub(env, { n: 1, created: NIGHT - 2 * HOUR });
  const full = ovationBody(T0, 40, 0, 359);   // полный файл NOAA — все долготы
  const fetchFn = async url => (String(url).includes('ovation_aurora_latest')
    ? new Response(full.replace(/\],\[/g, '], [').replace(/,(-?\d)/g, ', $1'), { status: 200 })
    : new Response('unexpected', { status: 500 }));
  assert.equal(await refreshOvation(env, T0, fetchFn), 'ok');
  const row = env.DB.raw.prepare("SELECT at FROM noaa_cache WHERE name = 'ovation'").get();
  assert.equal(row.at, T0);
  const extra = await activityExtras(env, T0 + 5 * MIN, makeFetch(T0 + 5 * MIN));
  assert.equal(extra.ovation.murmansk, 40);

  // обработчик расписания различает два cron'а
  const pending = [];
  const ctx = { waitUntil: p => pending.push(p) };
  worker.scheduled({ cron: OVATION_CRON }, env, ctx);
  await Promise.allSettled(pending);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM heartbeat').get().c, 0, 'проверка не запускалась');
});

/** Строка журнала напрямую: проход в момент at. */
function put(env, at, point, level, { seen = 0, high = 0, bz = 0 } = {}) {
  env.DB.raw.prepare('INSERT INTO alert_log(at, point, level, seen, sent_high, sent_bz) VALUES(?, ?, ?, ?, ?, ?)')
    .run(at, point, level, seen, high, bz);
}

test('сверка: ночь — с полудня до полудня по Москве; раньше, позже, пропуск, без очевидцев', async () => {
  assert.equal(nightOf(Date.parse('2026-10-20T20:00:00Z')), '2026-10-20', '23:00 МСК');
  assert.equal(nightOf(Date.parse('2026-10-20T23:30:00Z')), '2026-10-20', '02:30 МСК — та же ночь');
  assert.equal(nightOf(Date.parse('2026-10-21T10:00:00Z')), '2026-10-21', '13:00 МСК — уже следующая');

  const { env } = await makeEnv();
  const now = Date.parse('2026-10-22T09:00:00Z');
  const n1 = Date.parse('2026-10-20T18:00:00Z');   // 21:00 МСК
  // ночь 1, Мурманск: уведомление в 21:00, очевидцы с 21:20 — раньше на 20 минут
  put(env, n1, 'murmansk', 'high', { high: 3 });
  put(env, n1 + 20 * MIN, 'murmansk', 'high', { seen: 2 });
  // ночь 1, Кировск: очевидцы в 21:00, «высокий» и уведомление в 21:40 — позже на 40 минут
  put(env, n1, 'kirovsk', 'mid', { seen: 1 });
  put(env, n1 + 40 * MIN, 'kirovsk', 'high', { seen: 1, high: 1 });
  // ночь 2, Териберка: видели, уведомления не было
  const n2 = Date.parse('2026-10-21T19:00:00Z');
  put(env, n2, 'teriberka', 'mid', { seen: 1 });
  // ночь 2, Мурманск: «высокий» без очевидцев
  put(env, n2, 'murmansk', 'high', { high: 1 });
  // ночь 2, Апатиты: ничего — в сверку не попадает
  put(env, n2, 'apatity', 'low');

  const rows = await timingRows(env, now);
  assert.equal(rows.length, 4);
  const s = timingSummary(rows);
  assert.deepEqual(s, { seenNights: 3, early: 1, late: 1, missed: 1, unconfirmed: 1, lateAfterEnd: 0, medianLead: 20, medianLag: 40 });

  const text = await timingText(env, now, { murmansk: 'Мурманск', kirovsk: 'Кировск', teriberka: 'Териберка' });
  assert.match(text, /раньше очевидцев: 1 \(медиана на 20 мин\)/);
  assert.match(text, /позже очевидцев: 1 \(медиана на 40 мин\)/);
  assert.match(text, /20\.10 Мурманск: высокий 21:00, уведомление 21:00, очевидцы 21:20 → раньше на 20 мин/);
  assert.match(text, /20\.10 Кировск: высокий 21:40, уведомление 21:40, очевидцы 21:00–21:40 → позже на 40 мин/);
  assert.match(text, /21\.10 Териберка: очевидцы 22:00 → уведомления не было/);
});

test('сверка: пустой журнал и база без таблицы — понятный ответ', async () => {
  const { env } = await makeEnv();
  assert.match(await timingText(env, NIGHT), /пока пусто/);
  env.DB.raw.exec('DROP TABLE alert_log');
  assert.match(await timingText(env, NIGHT), /нужна миграция/);
});
