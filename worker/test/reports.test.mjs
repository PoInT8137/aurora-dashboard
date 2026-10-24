// Отметки «Вижу сияние»: приём, проверки, ограничения частоты, сводка за час, обезличивание,
// уборка старых и работа с базой до миграции.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/api.js';
import { runCheck } from '../src/check.js';
import { reporterId, deviceId, DEVICE_INTERVAL_MS, IP_PER_HOUR, REPORTS_PER_DAY, REPORTS_PER_HOUR_TOTAL, CONFIRM_DEVICES } from '../src/reports.js';
import { makeEnv, makeFetch, apiRequest, fakeCtx, NIGHT, DAY, MIN, HOUR, ORIGIN } from './helpers.mjs';

/** Отметка от адреса ip в момент now. */
async function report(env, now, body, ip = '198.51.100.7', opts = {}) {
  const req = apiRequest('/report', body, opts);
  req.headers.set('CF-Connecting-IP', ip);
  const res = await handleRequest(req, env, fakeCtx(), now);
  return { status: res.status, body: await res.json() };
}

async function summary(env, now) {
  const res = await handleRequest(apiRequest('/reports', null, { method: 'GET' }), env, fakeCtx(), now);
  return { res, body: await res.json() };
}

test('отметка принимается ночью у точки области и попадает в сводку за час', async () => {
  const { env } = await makeEnv();
  const r = await report(env, NIGHT, { point: 'teriberka', strength: 'bright' });
  assert.deepEqual(r, { status: 200, body: { ok: true, point: 'teriberka' } });
  await report(env, NIGHT + MIN, { point: 'teriberka', strength: 'faint' }, '203.0.113.9');

  const { res, body } = await summary(env, NIGHT + 5 * MIN);
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=60');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.deepEqual(body, { window: 60, total: 2, confirm: CONFIRM_DEVICES,
    points: { teriberka: { count: 2, devices: 2, bright: 1, last: NIGHT + MIN, confirmed: false } } });

  // через час с лишним — уже не в сводке
  assert.deepEqual((await summary(env, NIGHT + MIN + HOUR + 1)).body.points, {});
});

test('проверки: точка области, сила из списка, темнота, запрос со страницы сайта', async () => {
  const { env } = await makeEnv();
  assert.deepEqual((await report(env, NIGHT, { point: 'my-1', strength: 'bright' })).body, { error: 'bad_point' });
  assert.deepEqual((await report(env, NIGHT, { point: 'murmansk', strength: 'ОГОНЬ' })).body, { error: 'bad_strength' });
  const day = await report(env, DAY, { point: 'murmansk', strength: 'bright' });
  assert.deepEqual(day, { status: 400, body: { error: 'not_dark' } }, 'днём сияния не видно');
  const foreign = await report(env, NIGHT, { point: 'murmansk', strength: 'bright' }, '1.2.3.4', { origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM reports').get().c, 0);
});

const dev = n => 'device-' + String(n).padStart(10, '0');

test('устройство и точка: одна отметка в час; другая точка или другое устройство не мешают', async () => {
  const { env } = await makeEnv();
  assert.equal((await report(env, NIGHT, { point: 'murmansk', strength: 'faint', device: dev(1) })).status, 200);
  const again = await report(env, NIGHT + 10 * MIN, { point: 'murmansk', strength: 'bright', device: dev(1) });
  assert.equal(again.status, 429);
  assert.equal(again.body.error, 'too_often');
  assert.equal(again.body.retryAfter, (DEVICE_INTERVAL_MS - 10 * MIN) / 1000);
  // то же устройство у другой точки и другое устройство за тем же роутером проходят
  assert.equal((await report(env, NIGHT + 10 * MIN, { point: 'teriberka', strength: 'faint', device: dev(1) })).status, 200);
  assert.equal((await report(env, NIGHT + 11 * MIN, { point: 'murmansk', strength: 'faint', device: dev(2) })).status, 200);
  // через час то же устройство снова может
  assert.equal((await report(env, NIGHT + HOUR + MIN, { point: 'murmansk', strength: 'faint', device: dev(1) })).status, 200);
});

test('лимит по хешу IP: не больше 4 в час и 12 в сутки, даже с разными номерами устройств', async () => {
  const { env } = await makeEnv();
  // сутки считаются по UTC: начинаем в 15:00, чтобы все отметки уложились в одни сутки
  const NIGHT = Date.UTC(2026, 11, 15, 15, 0, 0);
  for (let i = 0; i < IP_PER_HOUR; i++) {
    assert.equal((await report(env, NIGHT + i * MIN, { point: 'murmansk', strength: 'faint', device: dev(i) })).status, 200, 'отметка ' + (i + 1));
  }
  const fifth = await report(env, NIGHT + 5 * MIN, { point: 'murmansk', strength: 'faint', device: dev(99) });
  assert.deepEqual([fifth.status, fifth.body.error], [429, 'too_often']);
  assert.equal((await report(env, NIGHT + 5 * MIN, { point: 'murmansk', strength: 'faint', device: dev(99) }, '203.0.113.50')).status, 200, 'другой адрес не мешает');

  // за сутки с одного адреса больше 12 не принимается
  let t = NIGHT + HOUR;
  for (let i = IP_PER_HOUR; i < REPORTS_PER_DAY; i++) {
    if (i % IP_PER_HOUR === 0) t += HOUR;
    assert.equal((await report(env, t + i * MIN, { point: 'murmansk', strength: 'faint', device: dev(100 + i) })).status, 200, 'отметка ' + (i + 1));
  }
  const over = await report(env, t + 4 * HOUR, { point: 'murmansk', strength: 'faint', device: dev(500) });
  assert.deepEqual(over.body, { error: 'too_many' });
});

test('подтверждение: от трёх разных устройств за час; два устройства или одно много раз не подтверждают', async () => {
  const { env } = await makeEnv();
  await report(env, NIGHT, { point: 'teriberka', strength: 'bright', device: dev(1) }, '198.51.100.1');
  await report(env, NIGHT + MIN, { point: 'teriberka', strength: 'faint', device: dev(2) }, '198.51.100.2');
  let p = (await summary(env, NIGHT + 2 * MIN)).body.points.teriberka;
  assert.deepEqual([p.count, p.devices, p.confirmed], [2, 2, false]);
  await report(env, NIGHT + 2 * MIN, { point: 'teriberka', strength: 'faint', device: dev(3) }, '198.51.100.3');
  p = (await summary(env, NIGHT + 3 * MIN)).body.points.teriberka;
  assert.deepEqual([p.count, p.devices, p.confirmed], [3, 3, true]);
});

test('номер устройства не хранится: только HMAC с солью; без соли отметки не принимаются', async () => {
  const { env } = await makeEnv();
  await report(env, NIGHT, { point: 'murmansk', strength: 'faint', device: dev(7) });
  const row = env.DB.raw.prepare('SELECT * FROM reports').get();
  assert.equal(row.dev, await deviceId(dev(7), env.VAPID_PRIVATE_KEY));
  assert.doesNotMatch(JSON.stringify(row), /device-/);

  env.REPORT_SALT = 'соль-из-окружения';
  await report(env, NIGHT + 2 * HOUR, { point: 'murmansk', strength: 'faint', device: dev(7) });
  const second = env.DB.raw.prepare('SELECT * FROM reports ORDER BY at DESC').get();
  assert.equal(second.dev, await deviceId(dev(7), 'соль-из-окружения'), 'REPORT_SALT важнее запасного ключа');

  const { env: bare } = await makeEnv();
  delete bare.VAPID_PRIVATE_KEY;
  assert.deepEqual(await report(bare, NIGHT, { point: 'murmansk', strength: 'faint', device: dev(1) }), { status: 503, body: { error: 'unavailable' } });
});

test('база до миграции (нет колонки dev): отметки принимаются, лимит устройства — по IP-хешу', async () => {
  const { env } = await makeEnv();
  env.DB.raw.exec('DROP TABLE reports; CREATE TABLE reports (id INTEGER PRIMARY KEY AUTOINCREMENT, point TEXT NOT NULL, strength TEXT NOT NULL, at INTEGER NOT NULL, who TEXT NOT NULL)');
  assert.equal((await report(env, NIGHT, { point: 'murmansk', strength: 'faint', device: dev(1) })).status, 200);
  assert.equal((await report(env, NIGHT + MIN, { point: 'murmansk', strength: 'faint' })).status, 429);
  const p = (await summary(env, NIGHT + 2 * MIN)).body.points.murmansk;
  assert.deepEqual([p.count, p.devices, p.confirmed], [1, 1, false]);
});

test('общий потолок в час защищает базу', async () => {
  const { env } = await makeEnv();
  const insert = env.DB.raw.prepare('INSERT INTO reports(point, strength, at, who) VALUES(?, ?, ?, ?)');
  for (let i = 0; i < REPORTS_PER_HOUR_TOTAL; i++) insert.run('murmansk', 'faint', NIGHT - MIN, 'w' + i);
  assert.deepEqual(await report(env, NIGHT, { point: 'murmansk', strength: 'faint' }), { status: 503, body: { error: 'busy' } });
});

test('адрес не хранится: только 16 знаков HMAC; на другие сутки и с другим ключом — другое значение', async () => {
  const { env } = await makeEnv();
  await report(env, NIGHT, { point: 'murmansk', strength: 'faint' }, '198.51.100.7');
  const row = env.DB.raw.prepare('SELECT * FROM reports').get();
  assert.match(row.who, /^[0-9a-f]{16}$/);
  assert.doesNotMatch(JSON.stringify(row), /198\.51/);
  assert.equal(row.who, await reporterId('198.51.100.7', NIGHT, env.VAPID_PRIVATE_KEY));
  assert.notEqual(row.who, await reporterId('198.51.100.7', NIGHT + 24 * HOUR, env.VAPID_PRIVATE_KEY));
  assert.notEqual(row.who, await reporterId('198.51.100.7', NIGHT, 'другой ключ'));
  // в сводке — только числа
  assert.doesNotMatch(JSON.stringify((await summary(env, NIGHT)).body), /who|198/);
});

test('отметки старше суток убираются проходом по расписанию — даже без подписчиков', async () => {
  const { env } = await makeEnv();
  const insert = env.DB.raw.prepare('INSERT INTO reports(point, strength, at, who) VALUES(?, ?, ?, ?)');
  insert.run('murmansk', 'faint', NIGHT - 25 * HOUR, 'old');
  insert.run('murmansk', 'faint', NIGHT - 2 * HOUR, 'fresh');
  await runCheck(env, NIGHT, makeFetch(NIGHT));
  assert.deepEqual(env.DB.raw.prepare('SELECT who FROM reports').all().map(r => r.who), ['fresh']);
});

test('база до миграции: сводка пустая, отметка — понятный отказ, проверка по расписанию идёт', async () => {
  const { env } = await makeEnv();
  env.DB.raw.exec('DROP TABLE reports');
  assert.deepEqual((await summary(env, NIGHT)).body, { window: 60, total: 0, points: {} });
  assert.deepEqual(await report(env, NIGHT, { point: 'murmansk', strength: 'faint' }), { status: 503, body: { error: 'unavailable' } });
  const result = await runCheck(env, NIGHT, makeFetch(NIGHT));
  assert.deepEqual(result, { skipped: 'нет подписчиков' });
});
