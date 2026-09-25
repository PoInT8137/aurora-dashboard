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

test('прямой запрос к Open-Meteo — одна попытка с коротким ожиданием, без повтора', async () => {
  const { ctx, calls } = page(url => (url.startsWith('https://api.open-meteo.com') ? Promise.reject(new TypeError('Failed to fetch')) : json({ ok: 1 })));
  await ctx.fetchJson(ctx.weatherUrl(ctx.findPoint('murmansk')));
  assert.equal(calls.filter(u => u.startsWith('https://api.open-meteo.com')).length, 1, 'без повтора перед запасным путём');
  assert.ok(ctx.METEO_DIRECT_TIMEOUT_MS <= 6000, 'ждём недолго: повисший запрос не должен держать карточку полминуты');
  assert.match(read('js/base.js'), /timeoutMs \|\| CONFIG\.timeoutMs/);
});

test('сервер выручил — это помнится сутки и между сеансами; не отвечает сервер — пробуем напрямую', async () => {
  const first = page(url => (url.startsWith('https://api.open-meteo.com') ? Promise.reject(new TypeError('x')) : json({ ok: 1 })));
  await first.ctx.fetchJson(first.ctx.weatherUrl(first.ctx.findPoint('murmansk')));
  const saved = first.ctx.localStorage.getItem('aurora.meteoViaServer');
  assert.ok(Number(saved) > 0);

  // новый сеанс: сразу через сервер
  const next = page(() => json({ ok: 2 }));
  next.ctx.localStorage.setItem('aurora.meteoViaServer', saved);
  await next.ctx.fetchJson(next.ctx.weatherUrl(next.ctx.findPoint('murmansk')));
  assert.ok(next.calls[0].startsWith('https://aurora-push.aurora-murmansk.workers.dev/meteo'));
  assert.equal(next.calls.length, 1);

  // сервер не отвечает — прямой путь как запасной
  const serverDown = page(url => (url.includes('/meteo') ? json({ error: 1 }, 502) : json({ direct: true })));
  serverDown.ctx.localStorage.setItem('aurora.meteoViaServer', saved);
  const data = await serverDown.ctx.fetchJson(serverDown.ctx.weatherUrl(serverDown.ctx.findPoint('murmansk')));
  assert.equal(data.direct, true);

  // через сутки — снова сначала напрямую
  const later = page(() => json({ ok: 3 }));
  later.ctx.localStorage.setItem('aurora.meteoViaServer', String(Date.parse('2026-09-24T11:00:00Z')));
  await later.ctx.fetchJson(later.ctx.weatherUrl(later.ctx.findPoint('murmansk')));
  assert.ok(later.calls[0].startsWith('https://api.open-meteo.com'));
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
