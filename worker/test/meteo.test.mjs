// Запасной путь к Open-Meteo (GET /meteo): только прогноз и нужные параметры, только со страницы
// сайта, кэш на 10 минут, ошибки источника.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/api.js';
import { meteoUpstream, clearMeteoCache, METEO_TTL_MS } from '../src/meteo.js';
import { makeEnv, apiRequest, fakeCtx, NIGHT, MIN, ORIGIN } from './helpers.mjs';

// Запросы, которые реально делает сайт (js/base.js, js/clouds.js, js/history.js)
const SITE = {
  weather: '?latitude=68.9678&longitude=33.0992&current=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,temperature_2m,apparent_temperature,wind_speed_10m,wind_gusts_10m,wind_direction_10m,precipitation,rain,snowfall,weather_code,visibility,relative_humidity_2m&hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high&models=icon_eu&forecast_days=2&timezone=UTC',
  points: '?latitude=68.9678,69.1609,67.9397&longitude=33.0992,35.1453,32.8739&hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high&models=icon_eu&forecast_days=2&timezone=UTC',
  grid: '?latitude=69.315,69.315&longitude=30.978,31.733&hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high&models=icon_eu&forecast_hours=24&timezone=UTC&timeformat=unixtime',
  history: '?latitude=68.9678&longitude=33.0992&hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high&models=icon_eu&past_days=7&forecast_days=1&timezone=UTC'
};

function fakeFetch(status = 200, body = '{"ok":1}') {
  const calls = [];
  const fn = async url => { calls.push(String(url)); if (status === 'down') throw new TypeError('down'); return new Response(body, { status }); };
  fn.calls = calls;
  return fn;
}

async function get(env, search, { origin = ORIGIN, now = NIGHT, fetchFn = fakeFetch() } = {}) {
  const res = await handleRequest(apiRequest('/meteo' + search, null, { method: 'GET', origin }), env, fakeCtx(), now, fetchFn);
  return { status: res.status, body: await res.text(), headers: res.headers, fetchFn };
}

test('все запросы сайта проходят и уходят ровно в api.open-meteo.com/v1/forecast', () => {
  for (const [name, q] of Object.entries(SITE)) {
    const up = meteoUpstream(q);
    assert.ok(up, name);
    assert.ok(up.startsWith('https://api.open-meteo.com/v1/forecast?'), name);
  }
  // одинаковые запросы с разным порядком параметров — один ключ кэша
  assert.equal(meteoUpstream('?longitude=33&latitude=68&current=cloud_cover'), meteoUpstream('?latitude=68&longitude=33&current=cloud_cover'));
});

test('не открытый прокси: чужие параметры, мусор, подмена адреса и огромные списки — отказ', () => {
  const bad = [
    '?latitude=68&longitude=33&current=cloud_cover&apikey=x',
    '?latitude=68&longitude=33&current=cloud_cover&url=https://evil.example',
    '?latitude=68;drop&longitude=33&current=cloud_cover',
    '?latitude=68&longitude=33&current=cloud cover',
    '?latitude=68&longitude=33',
    '?latitude=68,69&longitude=33&current=cloud_cover',
    '?latitude=68&latitude=69&longitude=33&current=cloud_cover',
    '?latitude=' + new Array(101).fill(68).join(',') + '&longitude=' + new Array(101).fill(33).join(',') + '&current=cloud_cover',
    '?latitude=68&longitude=33&current=cloud_cover&timezone=../../etc'
  ];
  for (const q of bad) assert.equal(meteoUpstream(q), null, q.slice(0, 80));
});

test('запрос со страницы сайта: ответ Open-Meteo как есть, с CORS; повтор за 10 минут — из памяти', async () => {
  clearMeteoCache();
  const { env } = await makeEnv();
  const fetchFn = fakeFetch(200, '{"current":{"cloud_cover":40}}');
  const first = await get(env, SITE.weather, { fetchFn });
  assert.equal(first.status, 200);
  assert.equal(first.body, '{"current":{"cloud_cover":40}}');
  assert.equal(first.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const second = await get(env, SITE.weather, { fetchFn, now: NIGHT + 5 * MIN });
  assert.equal(second.body, first.body);
  assert.equal(fetchFn.calls.length, 1, 'из памяти');
  await get(env, SITE.weather, { fetchFn, now: NIGHT + METEO_TTL_MS + 1 });
  assert.equal(fetchFn.calls.length, 2, 'через 10 минут — заново');
});

test('без страницы сайта (чужой Origin или его нет) — 403 и без обращения к Open-Meteo', async () => {
  clearMeteoCache();
  const { env } = await makeEnv();
  for (const origin of ['https://evil.example', null]) {
    const r = await get(env, SITE.weather, { origin });
    assert.equal(r.status, 403);
    assert.equal(r.fetchFn.calls.length, 0);
  }
});

test('ошибки источника: 429 передаётся как 429, недоступен — 502; ошибки не кэшируются', async () => {
  clearMeteoCache();
  const { env } = await makeEnv();
  assert.equal((await get(env, SITE.points, { fetchFn: fakeFetch(429, '{"error":true}') })).status, 429);
  assert.equal((await get(env, SITE.points, { fetchFn: fakeFetch('down') })).status, 502);
  const ok = await get(env, SITE.points, { fetchFn: fakeFetch(200, '[1]') });
  assert.deepEqual([ok.status, ok.body], [200, '[1]']);
  assert.equal((await get(env, '?latitude=68&longitude=33')).status, 400);
});
