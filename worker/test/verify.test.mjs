// Проверка прогноза: вечером — прогноз на ночь, утром — факт по измеренным данным, статистика.
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyStep, verifyStats, nightKey, nightLevel, readKpRows } from '../src/verify.js';
import { runCheck } from '../src/check.js';
import { handleRequest } from '../src/api.js';
import '../../core.js';
import { makeEnv, apiRequest, fakeCtx, HOUR, MIN } from './helpers.mjs';

const Core = globalThis.AuroraCore;
const EVENING = Date.UTC(2026, 8, 24, 15, 0);        // 18:00 МСК, 24 сентября
const MORNING = Date.UTC(2026, 8, 25, 6, 0);         // 09:00 МСК, 25 сентября
const json = body => new Response(JSON.stringify(body), { status: 200 });

/**
 * Внешний мир для сверки. kp(t, observed) — Kp трёхчасовки; cloud(t, pointIndex) — облачность.
 * Файл NOAA: до «сейчас» — observed, дальше — predicted (как настоящий).
 */
function world({ now, kp = () => 1, cloud = () => 10 }) {
  const calls = [];
  const fetchFn = async url => {
    const u = String(url);
    calls.push(u);
    if (u.includes('noaa-planetary-k-index-forecast')) {
      const rows = [];
      const day0 = Math.floor(now / (24 * HOUR)) * 24 * HOUR;
      for (let t = day0 - 4 * 24 * HOUR; t < day0 + 4 * 24 * HOUR; t += 3 * HOUR) {
        const observed = t <= now;
        rows.push({ time_tag: new Date(t).toISOString().slice(0, 19), kp: kp(t, observed), observed: observed ? 'observed' : 'predicted', noaa_scale: null });
      }
      return json(rows);
    }
    if (u.includes('api.open-meteo.com')) {
      const lats = u.match(/latitude=([^&]+)/)[1].split(',');
      const start = u.includes('past_days=1') ? Math.floor(now / (24 * HOUR)) * 24 * HOUR - 24 * HOUR : Math.floor(now / HOUR) * HOUR;
      const count = u.includes('past_days=1') ? 48 : 24;
      return json(lats.map((lat, i) => {
        const time = [], low = [];
        for (let h = 0; h < count; h++) { const t = start + h * HOUR; time.push(new Date(t).toISOString().slice(0, 16)); low.push(cloud(t, i)); }
        return { hourly: { time, cloud_cover: low, cloud_cover_low: low, cloud_cover_mid: low.map(() => 0), cloud_cover_high: low.map(() => 0) } };
      }));
    }
    return new Response('nope', { status: 404 });
  };
  fetchFn.calls = calls;
  return fetchFn;
}

const rows = env => env.DB.raw.prepare('SELECT * FROM verify ORDER BY point').all().map(r => ({ ...r }));

test('ключ ночи — дата вечера по Москве', () => {
  assert.equal(nightKey(EVENING), '2026-09-24');
  assert.equal(nightKey(MORNING - 24 * HOUR), '2026-09-24');
  assert.equal(nightKey(Date.UTC(2026, 8, 24, 21, 30)), '2026-09-25', 'после полуночи МСК — уже следующая дата');
});

test('вечером — прогноз на ночь для семи точек, один раз; утром — факт по измеренным Kp, не по прогнозу', async () => {
  const { env } = await makeEnv();
  // прогноз обещал Kp 4 (высокий), а измерили 1 (при ясном небе — средний)
  const kp = (t, observed) => (observed ? 1 : 4);
  const evening = world({ now: EVENING, kp });
  assert.equal(await verifyStep(env, EVENING, evening), 'forecast');
  const forecast = rows(env);
  assert.equal(forecast.length, 7);
  assert.ok(forecast.every(r => r.night === '2026-09-24' && r.actual === null));
  assert.equal(forecast.find(r => r.point === 'murmansk').forecast, 'high');

  const again = world({ now: EVENING + 30 * MIN, kp });
  assert.equal(await verifyStep(env, EVENING + 30 * MIN, again), null);
  assert.equal(again.calls.length, 0, 'уже записано — без запросов');

  const morning = world({ now: MORNING, kp });
  assert.equal(await verifyStep(env, MORNING, morning), 'actual');
  const done = rows(env);
  assert.equal(done.find(r => r.point === 'murmansk').actual, 'mid', 'по измеренному Kp 1');
  assert.ok(done.every(r => r.actual !== null));
  assert.ok(morning.calls.some(u => u.includes('past_days=1')));

  // вместе с уровнем: Kp и облачность прогноза и измерения, очевидцы (отметок не было: 0)
  const m = done.find(r => r.point === 'murmansk');
  assert.deepEqual([m.forecast_kp, m.forecast_cloud, m.actual_kp, m.actual_cloud, m.seen], [4, 10, 1, 10, 0]);
});

test('облака решают: прогноз ясного неба, а ночью было затянуто — факт низкий', async () => {
  const { env } = await makeEnv();
  await verifyStep(env, EVENING, world({ now: EVENING, kp: () => 4, cloud: () => 10 }));
  await verifyStep(env, MORNING, world({ now: MORNING, kp: () => 4, cloud: () => 95 }));
  const m = rows(env).find(r => r.point === 'murmansk');
  assert.deepEqual([m.forecast, m.actual], ['high', 'low']);
});

test('ночь ещё не кончилась — факт не пишется, пока она не станет прошлым', async () => {
  // Полярная ночь: 16 декабря в 05:00 UTC (08:00 МСК) в Мурманске ещё темно
  const { env } = await makeEnv();
  const dec = Date.UTC(2026, 11, 15, 15);
  assert.equal(await verifyStep(env, dec, world({ now: dec })), 'forecast');
  const early = Date.UTC(2026, 11, 16, 5);
  await verifyStep(env, early, world({ now: early }));
  assert.equal(rows(env).find(r => r.point === 'murmansk').actual, null, 'ночь не кончилась — не сверяем');
  const later = Date.UTC(2026, 11, 16, 8, 30);
  assert.equal(await verifyStep(env, later, world({ now: later })), 'actual');
  assert.notEqual(rows(env).find(r => r.point === 'murmansk').actual, null);
  const h = nightLevel(Core.findPoint('murmansk'), [{ time: Date.UTC(2026, 8, 24, 20), cloud: 5 }, { time: Date.UTC(2026, 8, 24, 21), cloud: 5 }],
    [], Date.UTC(2026, 8, 24, 19), Date.UTC(2026, 8, 24, 22, 30));
  assert.equal(h, null, 'данные кончились посреди ночи — не сверяем');
});

test('белые ночи — сверять нечего, записей нет', async () => {
  const { env } = await makeEnv();
  const june = Date.UTC(2026, 5, 21, 15);
  assert.equal(await verifyStep(env, june, world({ now: june })), null);
  assert.equal(rows(env).length, 0);
});

test('вне вечернего и утреннего окна — ни одного запроса', async () => {
  const { env } = await makeEnv();
  for (const h of [0, 3, 10, 12, 18, 21]) {
    const now = Date.UTC(2026, 8, 24, h);
    const f = world({ now });
    assert.equal(await verifyStep(env, now, f), null, 'час ' + h);
    assert.equal(f.calls.length, 0);
  }
});

test('статистика: совпадения, промахи на ступень и на две, что было, когда обещали высокий', async () => {
  const { env } = await makeEnv();
  const ins = env.DB.raw.prepare('INSERT INTO verify(night, point, forecast, actual, from_ms) VALUES(?, ?, ?, ?, 0)');
  ins.run('2026-09-20', 'murmansk', 'high', 'high');
  ins.run('2026-09-20', 'teriberka', 'high', 'mid');
  ins.run('2026-09-21', 'murmansk', 'low', 'low');
  ins.run('2026-09-21', 'teriberka', 'low', 'high');
  ins.run('2026-09-22', 'murmansk', 'mid', 'mid');
  ins.run('2026-09-23', 'murmansk', 'high', null);   // не сверено — не считается
  ins.run('2026-08-01', 'murmansk', 'high', 'low');  // старше 30 дней — не считается
  const s = await verifyStats(env, MORNING);
  assert.equal(s.days, 30);
  assert.equal(s.nights, 3);
  assert.equal(s.total, 5);
  assert.deepEqual([s.exact, s.offByOne, s.offByTwo], [3, 1, 1]);
  assert.deepEqual(s.promised.high, { n: 2, high: 1, mid: 1, low: 0 });
  assert.deepEqual(s.seen, { checked: 0, confirmed: 0, hit: 0 }, 'очевидцев в этих записях не считали');

  const res = await handleRequest(apiRequest('/verify', null, { method: 'GET' }), env, fakeCtx(), MORNING);
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=3600');
  assert.deepEqual(await res.json(), s);
});

test('очевидцы в статистике: подтверждённое сияние (3 устройства за час) и был ли прогноз средним или высоким', async () => {
  const { env } = await makeEnv();
  const ins = env.DB.raw.prepare('INSERT INTO verify(night, point, forecast, actual, from_ms, seen) VALUES(?, ?, ?, ?, 0, ?)');
  ins.run('2026-09-20', 'murmansk', 'high', 'high', 4);
  ins.run('2026-09-20', 'teriberka', 'low', 'low', 3);
  ins.run('2026-09-21', 'murmansk', 'mid', 'mid', 2);   // два устройства: не подтверждение
  ins.run('2026-09-21', 'teriberka', 'low', 'low', 0);
  const s = await verifyStats(env, MORNING);
  assert.deepEqual(s.seen, { checked: 4, confirmed: 2, hit: 1 });
});

test('очевидцы за ночь: наибольшее число разных устройств за час; одно устройство много раз — одно', async () => {
  const { env } = await makeEnv();
  const { nightSightings } = await import('../src/verify.js');
  const ins = env.DB.raw.prepare('INSERT INTO reports(point, strength, at, who, dev) VALUES(?, ?, ?, ?, ?)');
  const t0 = Date.UTC(2026, 8, 24, 19, 0);
  ins.run('murmansk', 'faint', t0, 'ip1', 'd1');
  ins.run('murmansk', 'faint', t0 + 10 * MIN, 'ip1', 'd1');
  ins.run('murmansk', 'bright', t0 + 20 * MIN, 'ip2', 'd2');
  ins.run('murmansk', 'faint', t0 + 90 * MIN, 'ip3', 'd3');    // через полтора часа: другой час
  ins.run('teriberka', 'faint', t0, 'ip4', 'd4');
  assert.equal(await nightSightings(env, 'murmansk', t0 - HOUR, t0 + 5 * HOUR), 2);
  ins.run('murmansk', 'faint', t0 + 30 * MIN, 'ip5', 'd5');
  assert.equal(await nightSightings(env, 'murmansk', t0 - HOUR, t0 + 5 * HOUR), 3);
  assert.equal(await nightSightings(env, 'lovozero', t0 - HOUR, t0 + 5 * HOUR), 0);
});

test('проход по расписанию делает шаг сверки даже без подписчиков; база до миграции ему не мешает', async () => {
  const { env } = await makeEnv();
  const result = await runCheck(env, EVENING, world({ now: EVENING }));
  assert.deepEqual(result, { skipped: 'нет подписчиков' });
  assert.equal(rows(env).length, 7);

  const old = await makeEnv();
  old.env.DB.raw.exec('DROP TABLE verify');
  assert.deepEqual(await runCheck(old.env, EVENING, world({ now: EVENING })), { skipped: 'нет подписчиков' });
  const res = await handleRequest(apiRequest('/verify', null, { method: 'GET' }), old.env, fakeCtx(), MORNING);
  assert.equal((await res.json()).total, 0);
});

test('разбор файла NOAA: измеренные и прогнозные строки различаются', () => {
  const r = readKpRows([
    { time_tag: '2026-09-24T12:00:00', kp: 2, observed: 'observed' },
    { time_tag: '2026-09-24T15:00:00', kp: 3, observed: 'estimated' },
    { time_tag: '2026-09-24T18:00:00', kp: 4, observed: 'predicted' }
  ]);
  assert.deepEqual(r.map(x => [x.value, x.observed]), [[2, true], [3, true], [4, false]]);
});
