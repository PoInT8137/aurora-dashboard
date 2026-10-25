// Исправления по аудиту 25.10.2026: подтверждение очевидцев, лимит подписок, мусор NOAA, /meteo.
// Запуск: node --test test/audit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest, NEW_SUBS_PER_IP_HOUR } from '../src/api.js';
import { clearNoaaCache, SOURCES, usableBody } from '../src/noaa.js';
import { clearMeteoCache, METEO_TTL_MS } from '../src/meteo.js';
import { makeEnv, apiRequest, fakeCtx, ep, subRow, NIGHT, MIN } from './helpers.mjs';

const dev = n => 'device-' + String(n).padStart(10, '0');

async function post(env, path, body, ip, now = NIGHT) {
  const req = apiRequest(path, body);
  req.headers.set('CF-Connecting-IP', ip);
  const res = await handleRequest(req, env, fakeCtx(), now);
  return { status: res.status, body: await res.json() };
}

async function points(env, now) {
  const res = await handleRequest(apiRequest('/reports', null, { method: 'GET' }), env, fakeCtx(), now);
  return (await res.json()).points;
}

test('подтверждение очевидцев: три выдуманных устройства с одного адреса не подтверждают', async () => {
  const { env } = await makeEnv();
  for (let i = 1; i <= 3; i++) {
    assert.equal((await post(env, '/report', { point: 'teriberka', strength: 'bright', device: dev(i) }, '198.51.100.1', NIGHT + i * MIN)).status, 200);
  }
  let p = (await points(env, NIGHT + 5 * MIN)).teriberka;
  assert.deepEqual([p.count, p.devices, p.confirmed], [3, 3, false]);

  // те же три устройства, но из двух сетей — подтверждение
  const { env: env2 } = await makeEnv();
  await post(env2, '/report', { point: 'teriberka', strength: 'bright', device: dev(1) }, '198.51.100.1', NIGHT);
  await post(env2, '/report', { point: 'teriberka', strength: 'faint', device: dev(2) }, '198.51.100.1', NIGHT + MIN);
  await post(env2, '/report', { point: 'teriberka', strength: 'faint', device: dev(3) }, '203.0.113.9', NIGHT + 2 * MIN);
  p = (await points(env2, NIGHT + 5 * MIN)).teriberka;
  assert.deepEqual([p.devices, p.confirmed], [3, true]);
});

test('новые подписки: не больше пяти в час с одного адреса; смена точки и другой адрес не мешают', async () => {
  const { env } = await makeEnv();
  const ip = '198.51.100.20';
  for (let n = 1; n <= NEW_SUBS_PER_IP_HOUR; n++) {
    assert.equal((await post(env, '/subscribe', { endpoint: ep(n), point: 'murmansk' }, ip)).status, 200, 'подписка ' + n);
  }
  const over = await post(env, '/subscribe', { endpoint: ep(99), point: 'murmansk' }, ip);
  assert.deepEqual(over, { status: 429, body: { error: 'limit' } });
  assert.equal(subRow(env, 99), undefined);

  // уже существующая подписка меняет точку свободно
  assert.equal((await post(env, '/subscribe', { endpoint: ep(1), point: 'teriberka' }, ip)).status, 200);
  // с другого адреса — можно
  assert.equal((await post(env, '/subscribe', { endpoint: ep(100), point: 'murmansk' }, '203.0.113.50')).status, 200);
  // через час — снова можно
  assert.equal((await post(env, '/subscribe', { endpoint: ep(101), point: 'murmansk' }, ip, NIGHT + 61 * MIN)).status, 200);
});

test('новые подписки: база без таблицы sub_new (до миграции) — подписка работает без лимита', async () => {
  const { env } = await makeEnv();
  env.DB.raw.exec('DROP TABLE sub_new');
  for (let n = 1; n <= NEW_SUBS_PER_IP_HOUR + 2; n++) {
    assert.equal((await post(env, '/subscribe', { endpoint: ep(n), point: 'murmansk' }, '198.51.100.30')).status, 200);
  }
});

test('мусор NOAA (200 со страницей ошибки или обрывком) не попадает в кэш и не вытесняет удачную копию', async () => {
  assert.equal(usableBody('<html>Service maintenance</html>', 'json'), false);
  assert.equal(usableBody('[{"a":1', 'json'), false);
  assert.equal(usableBody('[]', 'json'), false);
  assert.equal(usableBody('[{"kp_index":1}]', 'json'), true);
  assert.equal(usableBody('<html></html>', 'text'), false);
  assert.equal(usableBody(':Product: 27-day Space Weather Outlook Table', 'text'), true);

  clearNoaaCache();
  const { env } = await makeEnv();
  let reply = () => new Response('[{"time_tag":"2026-12-15T22:00:00","estimated_kp":2.33}]', { status: 200 });
  const fetchFn = async () => reply();
  const get = async now => {
    const res = await handleRequest(apiRequest('/noaa/kp', null, { method: 'GET' }), env, fakeCtx(), now, fetchFn);
    return { status: res.status, stale: res.headers.get('X-Stale'), expose: res.headers.get('Access-Control-Expose-Headers'), body: await res.text() };
  };
  const good = await get(NIGHT);
  assert.equal(good.status, 200);
  assert.equal(good.expose, 'X-Stale', 'страница видит признак запасной копии');

  reply = () => new Response('<html>Service maintenance</html>', { status: 200 });
  const later = NIGHT + SOURCES.kp.ttl + 20 * MIN;
  const res = await get(later);
  assert.equal(res.status, 200);
  assert.equal(res.stale, '1', 'отдана прежняя копия с пометкой');
  assert.match(res.body, /estimated_kp/);
  const saved = env.DB.raw.prepare("SELECT body FROM noaa_cache WHERE name = 'kp'").get();
  assert.match(saved.body, /estimated_kp/, 'в базе осталась удачная копия');
});

const GRID = '?latitude=69.315,69.315&longitude=30.978,31.733&hourly=cloud_cover&models=icon_eu&forecast_hours=24&timezone=UTC&timeformat=unixtime';

test('/meteo: одновременные одинаковые запросы уходят в Open-Meteo один раз', async () => {
  clearMeteoCache();
  const { env } = await makeEnv();
  let calls = 0;
  let release;
  const gate = new Promise(r => { release = r; });
  const fetchFn = async () => { calls++; await gate; return new Response('{"ok":1}', { status: 200 }); };
  const req = () => handleRequest(apiRequest('/meteo' + GRID, null, { method: 'GET' }), env, fakeCtx(), NIGHT, fetchFn);
  const all = Promise.all([req(), req(), req()]);
  await new Promise(r => setTimeout(r, 10));
  release();
  const answers = await all;
  assert.equal(calls, 1);
  assert.deepEqual(answers.map(r => r.status), [200, 200, 200]);
});

test('/meteo: копия после сбоя источников помечена X-Stale и не кэшируется браузером', async () => {
  clearMeteoCache();
  const { env } = await makeEnv();
  const ok = async () => new Response('{"ok":1}', { status: 200 });
  await handleRequest(apiRequest('/meteo' + GRID, null, { method: 'GET' }), env, fakeCtx(), NIGHT, ok);
  const down = async () => { throw new TypeError('down'); };
  const res = await handleRequest(apiRequest('/meteo' + GRID, null, { method: 'GET' }), env, fakeCtx(), NIGHT + METEO_TTL_MS + MIN, down);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-Stale'), '1');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(await res.text(), '{"ok":1}');
});

test('/resubscribe: браузер сменил подписку — запись с точкой переезжает на новый адрес', async () => {
  const { env } = await makeEnv();
  await post(env, '/subscribe', { endpoint: ep(1), point: 'teriberka', lang: 'en' }, '198.51.100.40');
  const moved = await post(env, '/resubscribe', { old: ep(1), endpoint: ep(2) }, '198.51.100.40');
  assert.deepEqual(moved, { status: 200, body: { ok: true } });
  assert.equal(subRow(env, 1), undefined);
  assert.equal(subRow(env, 2).point, 'teriberka');
  assert.equal(subRow(env, 2).lang, 'en');
  assert.equal(subRow(env, 2).endpoint, ep(2));
  // неизвестный старый адрес — 404, ничего не создаётся
  assert.equal((await post(env, '/resubscribe', { old: ep(7), endpoint: ep(8) }, '198.51.100.40')).status, 404);
  assert.equal(subRow(env, 8), undefined);
  // чужой хост вместо старого адреса — 400
  assert.equal((await post(env, '/resubscribe', { old: 'https://evil.example/x', endpoint: ep(9) }, '198.51.100.40')).status, 400);
});
