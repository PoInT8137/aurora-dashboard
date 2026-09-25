// Данные NOAA через сервер уведомлений (/noaa/<имя>), прямой запрос к NOAA — запасной путь.
// Запуск: node --test tools/noaa-server.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadApp, appSource } from './app-sandbox.mjs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const API = 'https://aurora-push.aurora-murmansk.workers.dev';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function page(handler, config = true) {
  const calls = [];
  const fetch = async (url, init) => { calls.push(String(url)); return handler(String(url), init); };
  const cfg = config ? read('config.js') : 'var AURORA_CONFIG = { pushApi: "", vapidPublicKey: "" };';
  const ctx = loadApp([['config.js', cfg], ['core.js', read('core.js')], ['push.js', read('push.js')], ['app.js', read('app.js')]],
    { now: Date.parse('2026-09-25T12:00:00Z'), fetch, rawFetch: true });
  return { ctx, calls };
}

test('все адреса NOAA, к которым ходит страница, есть на сервере — и в worker/src/noaa.js', () => {
  const { ctx } = page(() => json({}));
  const used = [...new Set([...appSource().matchAll(/'(https:\/\/services\.swpc\.noaa\.gov\/[^']+)'/g)].map(m => m[1]))];
  assert.ok(used.length >= 7);
  const worker = read('worker/src/noaa.js');
  for (const url of used) {
    const server = ctx.noaaServerUrl(url);
    assert.ok(server && server.startsWith(API + '/noaa/'), url);
    const key = server.slice((API + '/noaa/').length);
    const path = url.replace('https://services.swpc.noaa.gov/', '');
    assert.match(worker, new RegExp(`'${key}':\\s*\\{ path: '${path.replace(/[.]/g, '\\.')}'`), 'на сервере ' + key + ' → ' + path);
  }
  assert.equal(ctx.noaaServerUrl('https://api.open-meteo.com/v1/forecast?x=1'), null);
});

test('сначала сервер: прямого запроса к NOAA нет, если сервер ответил', async () => {
  const { ctx, calls } = page(() => json([{ proton_speed: 450 }]));
  const data = await ctx.fetchJson(ctx.URLS.swSpeed);
  assert.equal(data[0].proton_speed, 450);
  assert.deepEqual(calls, [API + '/noaa/sw-speed']);
});

test('сервер не ответил — напрямую к NOAA; текстовый прогноз на 27 дней — так же', async () => {
  const { ctx, calls } = page(url => (url.startsWith(API) ? json({ error: 1 }, 502) : new Response(':Issued: 2026 Sep 21 0000 UTC', { status: 200 })));
  const text = await ctx.fetchText(ctx.URLS.outlook);
  assert.match(text, /Issued/);
  assert.deepEqual(calls, [API + '/noaa/outlook', ctx.URLS.outlook]);
});

test('без настроенного сервера — напрямую, как раньше', async () => {
  const { ctx, calls } = page(() => json([{ kp: 1 }]), false);
  await ctx.fetchJson(ctx.URLS.kpForecast);
  assert.deepEqual(calls, [ctx.URLS.kpForecast]);
});
