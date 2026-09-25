// Запасной путь к Open-Meteo через сервер уведомлений: когда прямой запрос не проходит.
// Запуск: node --test tools/meteo-fallback.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadApp } from './app-sandbox.mjs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const API = 'https://aurora-push.aurora-murmansk.workers.dev';

function page(handler, config = true) {
  const calls = [];
  const fetch = async (url, init) => { calls.push(String(url)); return handler(String(url), init); };
  const cfg = config ? read('config.js') : 'var AURORA_CONFIG = { pushApi: "", vapidPublicKey: "" };';
  const ctx = loadApp([['config.js', cfg], ['core.js', read('core.js')], ['push.js', read('push.js')], ['app.js', read('app.js')]],
    { now: Date.parse('2026-09-25T12:00:00Z'), fetch });
  ctx.state.point = ctx.findPoint('murmansk');
  return { ctx, calls };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('адрес запасного пути — те же параметры на сервере уведомлений; не Open-Meteo — без запасного пути', () => {
  const { ctx } = page(() => json({}));
  const url = ctx.weatherUrl(ctx.findPoint('murmansk'));
  assert.equal(ctx.meteoFallbackUrl(url), API + '/meteo' + url.slice('https://api.open-meteo.com/v1/forecast'.length));
  for (const u of [ctx.allPointsWeatherUrl(), ctx.historyCloudUrl(ctx.findPoint('kirovsk')), ctx.cloudGridUrl(ctx.cloudGridCells())]) {
    assert.ok(ctx.meteoFallbackUrl(u).startsWith(API + '/meteo?latitude='), u.slice(0, 60));
  }
  assert.equal(ctx.meteoFallbackUrl('https://services.swpc.noaa.gov/json/planetary_k_index_1m.json'), null);
  assert.equal(page(() => json({}), false).ctx.meteoFallbackUrl(url), null, 'сервер не настроен');
});

test('прямой запрос «нет соединения» — данные через сервер, и дальше в этом сеансе сразу через сервер', async () => {
  const { ctx, calls } = page(url => (url.startsWith('https://api.open-meteo.com') ? Promise.reject(new TypeError('Failed to fetch')) : json({ current: { cloud_cover: 42 } })));
  const url = ctx.weatherUrl(ctx.findPoint('murmansk'));
  const data = await ctx.fetchJson(url);
  assert.equal(data.current.cloud_cover, 42);
  assert.equal(ctx.state.meteoViaServer, true);
  calls.length = 0;
  await ctx.fetchJson(url);
  assert.deepEqual(calls.map(u => u.slice(0, API.length + 6)), [API + '/meteo'], 'сразу через сервер, без прямой попытки');
});

test('прямой путь работает — сервер не трогается', async () => {
  const { ctx, calls } = page(() => json({ current: { cloud_cover: 7 } }));
  await ctx.fetchJson(ctx.weatherUrl(ctx.findPoint('murmansk')));
  assert.equal(calls.length, 1);
  assert.ok(calls[0].startsWith('https://api.open-meteo.com'));
  assert.equal(ctx.state.meteoViaServer, false);
});

test('не помог и сервер — показывается исходная причина, а не ошибка сервера', async () => {
  const { ctx } = page(url => (url.startsWith('https://api.open-meteo.com') ? Promise.reject(new TypeError('Failed to fetch')) : json({ error: 'upstream' }, 502)));
  await assert.rejects(ctx.fetchJson(ctx.weatherUrl(ctx.findPoint('murmansk'))), e => e.code === 'offline');
  assert.equal(ctx.state.meteoViaServer, false);
});

test('облачность на «Сейчас» при недоступном Open-Meteo загружается через сервер', async () => {
  const hourly = { time: ['2026-09-25T12:00'], cloud_cover: [30], cloud_cover_low: [20], cloud_cover_mid: [10], cloud_cover_high: [0] };
  const body = { current: { time: '2026-09-25T12:00', cloud_cover: 30, cloud_cover_low: 20, cloud_cover_mid: 10, cloud_cover_high: 0, temperature_2m: 9 }, hourly };
  const { ctx } = page(url => (url.startsWith('https://api.open-meteo.com') ? Promise.reject(new TypeError('Failed to fetch')) : json(body)));
  const cloud = await ctx.loadCloud();
  assert.ok(cloud && cloud.value >= 0, JSON.stringify(cloud));
});
