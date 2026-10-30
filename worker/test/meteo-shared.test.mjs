// Open-Meteo через сервер (v84): пустой ответ модели: сбой с резервом, общая копия в D1 для всех
// экземпляров, что сломалось: в журнал ошибок.
// Запуск: node --test test/meteo-shared.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/api.js';
import { meteoProxy, meteoHasCloud, clearMeteoCache, purgeMeteo, METEO_TTL_MS, STALE_KEEP_MS } from '../src/meteo.js';
import { makeEnv, apiRequest, fakeCtx, NIGHT, MIN } from './helpers.mjs';

const Q = '?latitude=68.9678&longitude=33.0992&current=cloud_cover&hourly=cloud_cover&models=icon_eu&forecast_days=2&timezone=UTC';
const GOOD = JSON.stringify({ current: { cloud_cover: 42 }, hourly: { cloud_cover: [42, 50] } });
const EMPTY = JSON.stringify({ current: { cloud_cover: null }, hourly: { cloud_cover: [null, null] } });

/** Open-Meteo отвечает body, MET Norway: met (или недоступен). */
function world(body, { status = 200, met = null } = {}) {
  const calls = [];
  const fn = async url => {
    calls.push(String(url));
    if (String(url).includes('api.met.no')) return met ? new Response(JSON.stringify(met), { status: 200 }) : new Response('', { status: 503 });
    return new Response(body, { status });
  };
  fn.calls = calls;
  return fn;
}

test('пустой ответ модели, это сбой: проверка облачности по текущей и почасовой', () => {
  assert.equal(meteoHasCloud(GOOD), true);
  assert.equal(meteoHasCloud(EMPTY), false);
  assert.equal(meteoHasCloud(JSON.stringify([JSON.parse(EMPTY), { hourly: { cloud_cover: [null, 7] } }])), true, 'хоть одна точка с облачностью');
  assert.equal(meteoHasCloud('{"current":{"temperature_2m":3}}'), true, 'облачность не просили');
  assert.equal(meteoHasCloud('<html>'), true, 'без cloud_cover: не наш случай; разбор не нужен');
});

test('пустой ответ ICON-EU без резерва: ошибка и запись «что сломалось», а не пустые данные', async () => {
  clearMeteoCache();
  const [, status, stale, note] = await meteoProxy(Q, NIGHT, world(EMPTY));
  assert.equal(status, 502);
  assert.equal(stale, false);
  assert.equal(note, 'Open-Meteo: пустой ответ модели, резерва нет');
});

test('ответ Open-Meteo лежит в D1: другой экземпляр (пустая память) берёт его без обращения к Open-Meteo', async () => {
  clearMeteoCache();
  const { env } = await makeEnv();
  const first = world(GOOD);
  assert.equal((await meteoProxy(Q, NIGHT, first, { db: env.DB }))[1], 200);
  assert.equal(first.calls.length, 1);

  clearMeteoCache();                          // «другой экземпляр»
  const second = world(GOOD);
  const [body, status] = await meteoProxy(Q, NIGHT + 5 * MIN, second, { db: env.DB });
  assert.equal(status, 200);
  assert.equal(body, GOOD);
  assert.equal(second.calls.length, 0);

  // копия из базы выручает и при сбое: отдаётся с пометкой запаса
  clearMeteoCache();
  const [, s2, stale] = await meteoProxy(Q, NIGHT + METEO_TTL_MS + MIN, world('', { status: 429 }), { db: env.DB });
  assert.equal(s2, 200);
  assert.equal(stale, true);
});

test('уборка: копии старше срока запаса удаляются, свежие и данные NOAA остаются', async () => {
  clearMeteoCache();
  const { env } = await makeEnv();
  await meteoProxy(Q, NIGHT, world(GOOD), { db: env.DB });
  env.DB.raw.prepare("INSERT INTO noaa_cache (name, body, at) VALUES ('kp', '[]', 0)").run();
  await purgeMeteo(env, NIGHT + STALE_KEEP_MS - MIN);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS c FROM noaa_cache WHERE name LIKE 'meteo:%'").get().c, 1);
  await purgeMeteo(env, NIGHT + STALE_KEEP_MS + MIN);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS c FROM noaa_cache WHERE name LIKE 'meteo:%'").get().c, 0);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS c FROM noaa_cache WHERE name = 'kp'").get().c, 1);
});

test('сбой Open-Meteo на сервере попадает в журнал ошибок: один вид сбоя одной строкой со счётчиком', async () => {
  clearMeteoCache();
  const { env } = await makeEnv();
  for (let i = 0; i < 2; i++) {
    clearMeteoCache();
    const ctx = fakeCtx();
    const res = await handleRequest(apiRequest('/meteo' + Q, null, { method: 'GET' }), env, ctx, NIGHT + i * MIN, world('', { status: 429 }));
    assert.equal(res.status, 429);
    await Promise.all(ctx.pending);
  }
  const rows = env.DB.raw.prepare("SELECT msg, count, kind FROM bugs WHERE src = 'meteo'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].msg, 'meteo: Open-Meteo: ответ 429, резерва нет');
  assert.equal(rows[0].count, 2);
  assert.equal(rows[0].kind, 'worker');
});
