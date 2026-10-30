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

const CLOUD = { current: { cloud_cover: 42 }, hourly: { cloud_cover: [42] } };

test('Open-Meteo, сначала через сервер: сервер ответил: прямой запрос не уходит', async () => {
  const { ctx, calls } = page(() => json(CLOUD));
  const data = await ctx.fetchJson(ctx.weatherUrl(ctx.findPoint('murmansk')));
  assert.equal(data.current.cloud_cover, 42);
  assert.deepEqual(calls.map(u => u.slice(0, API.length + 6)), [API + '/meteo']);
});

test('сервер ответил ошибкой: данные напрямую из Open-Meteo', async () => {
  const { ctx, calls } = page(url => (url.includes('/meteo') ? json({ error: 1 }, 502) : json({ ...CLOUD, direct: true })));
  const data = await ctx.fetchJson(ctx.weatherUrl(ctx.findPoint('murmansk')));
  assert.equal(data.direct, true);
  assert.equal(calls.filter(u => u.startsWith('https://api.open-meteo.com')).length, 1, 'прямой: одна попытка, без повтора');
  assert.ok(ctx.METEO_DIRECT_TIMEOUT_MS <= 6000, 'ждём недолго: повисший запрос не должен держать карточку полминуты');
});

test('пустой ответ модели, сбой: берётся другой путь, а не «нет облачности»', async () => {
  const empty = { current: { cloud_cover: null }, hourly: { cloud_cover: [null] } };
  const { ctx } = page(url => (url.includes('/meteo') ? json(empty) : json({ ...CLOUD, direct: true })));
  const data = await ctx.fetchJson(ctx.weatherUrl(ctx.findPoint('murmansk')));
  assert.equal(data.direct, true);
  assert.equal(ctx.meteoHasCloud(empty), false);
  assert.equal(ctx.meteoHasCloud([empty, { hourly: { cloud_cover: [null, 5] } }]), true, 'хоть одна точка с облачностью');
});

test('не помог ни сервер, ни прямой путь: ошибка, а не пустые данные', async () => {
  const { ctx } = page(url => (url.startsWith('https://api.open-meteo.com') ? Promise.reject(new TypeError('Failed to fetch')) : json({ error: 'upstream' }, 502)));
  await assert.rejects(ctx.fetchJson(ctx.weatherUrl(ctx.findPoint('murmansk'))), e => e.code === 'http' || e.code === 'offline');
});

test('облачность на «Сейчас» при недоступном прямом Open-Meteo загружается через сервер', async () => {
  const hourly = { time: ['2026-09-25T12:00'], cloud_cover: [30], cloud_cover_low: [20], cloud_cover_mid: [10], cloud_cover_high: [0] };
  const body = { current: { time: '2026-09-25T12:00', cloud_cover: 30, cloud_cover_low: 20, cloud_cover_mid: 10, cloud_cover_high: 0, temperature_2m: 9 }, hourly };
  const { ctx } = page(url => (url.startsWith('https://api.open-meteo.com') ? Promise.reject(new TypeError('Failed to fetch')) : json(body)));
  const cloud = await ctx.loadCloud();
  assert.ok(cloud && cloud.value >= 0, JSON.stringify(cloud));
});

test('сбой пути, в журнал владельцу (reportProblem): что именно и каким путём; отменённый проигравший: нет', async () => {
  const notes = [];
  const { ctx } = page(url => (url.includes('/meteo') ? json({ error: 1 }, 429) : json(CLOUD)));
  ctx.reportProblem = msg => notes.push(msg);
  await ctx.fetchJson(ctx.weatherUrl(ctx.findPoint('murmansk')));
  assert.deepEqual(notes, ['Open-Meteo через сервер: rate_limit']);

  // сервер ответил быстро: прямой запрос не уходил и в журнал не попал
  const quiet = [];
  const ok = page(() => json(CLOUD));
  ok.ctx.reportProblem = msg => quiet.push(msg);
  await ok.ctx.fetchJson(ok.ctx.weatherUrl(ok.ctx.findPoint('murmansk')));
  assert.deepEqual(quiet, []);

  // пустой ответ модели называется прямо
  const empty = [];
  const e = page(url => (url.includes('/meteo') ? json({ current: { cloud_cover: null } }) : json(CLOUD)));
  e.ctx.reportProblem = msg => empty.push(msg);
  await e.ctx.fetchJson(e.ctx.weatherUrl(e.ctx.findPoint('murmansk')));
  assert.deepEqual(empty, ['Open-Meteo через сервер: no_cloud']);
});

test('версия в подвале совпадает с версией кэша service worker; новая версия перезагружает страницу один раз', () => {
  const { ctx } = page(() => json({}));
  const sw = /CACHE_VERSION = '([^']+)'/.exec(read('sw.js'))[1];
  assert.equal(ctx.APP_VERSION, sw, 'поднимаешь версию в sw.js — подними и APP_VERSION в js/base.js');
  const app = read('app.js');
  assert.match(app, /var hadController = !!navigator\.serviceWorker\.controller;/);
  assert.match(app, /if \(!hadController \|\| reloaded\) return;\s*reloaded = true;\s*location\.reload\(\);/, 'первая установка без перезагрузки, и не больше одной');
  assert.match(read('sw.js'), /self\.skipWaiting\(\)/);
  assert.match(read('sw.js'), /self\.clients\.claim\(\)/);
});

test('резервная модель сервера (MET Norway) — подпись в карточке облачности честная, облачность — по общей', async () => {
  const body = { generator: 'MET Norway', current: { time: '2026-09-25T12:00', cloud_cover: 64, cloud_cover_low: null, cloud_cover_mid: null, cloud_cover_high: null, temperature_2m: 9 },
    hourly: { time: ['2026-09-25T12:00'], cloud_cover: [64], cloud_cover_low: [null], cloud_cover_mid: [null], cloud_cover_high: [null] } };
  const elements = new Map();
  const make = () => ({ textContent: '', hidden: false, className: '', attrs: {}, children: [], style: { setProperty() {} },
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; }, removeAttribute() {},
    appendChild(c) { this.children.push(c); return c; }, querySelector() { return make(); }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { height: 0 }; }, set innerHTML(v) { this.children = []; }, get innerHTML() { return ''; } });
  const el = id => { if (!elements.has(id)) elements.set(id, make()); return elements.get(id); };
  const calls = [];
  const ctx = loadApp([['config.js', read('config.js')], ['core.js', read('core.js')], ['push.js', read('push.js')], ['app.js', read('app.js')]],
    { now: Date.parse('2026-09-25T12:00:00Z'), fetch: async u => { calls.push(u); return json(body); }, getElement: el, rawFetch: true });
  ctx.state.point = ctx.findPoint('murmansk');
  const cloud = await ctx.loadCloud();
  assert.equal(cloud.value, 64);
  assert.equal(cloud.byLayers, false);
  assert.equal(cloud.model, 'MET Norway');
  assert.equal(el('cloud-model').textContent, 'Модель прогноза: MET Norway');
});
