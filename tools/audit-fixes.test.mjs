// Исправления по аудиту 25.10.2026: проверяются настоящим путём данных, а не подложенным состоянием.
// Запуск: node --test tools/audit-fixes.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadApp, appSource } from './app-sandbox.mjs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const NOW = Date.parse('2026-12-15T22:00:00Z');   // полярная ночь, в Мурманске 01:00
const MIN = 60000;

const element = () => ({
  textContent: '', hidden: false, disabled: false, className: '', style: { setProperty() {} },
  children: [], attrs: {}, listeners: {},
  setAttribute(k, v) { this.attrs[k] = String(v); },
  getAttribute(k) { return this.attrs[k] ?? null; },
  addEventListener(type, fn) { this.listeners[type] = fn; },
  querySelector() { return element(); },
  querySelectorAll() { return []; },
  appendChild(child) { this.children.push(child); return child; },
  set innerHTML(value) { if (value === '') this.children = []; },
  get innerHTML() { return ''; }
});

function page(fetch) {
  const elements = new Map();
  const getElement = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const ctx = loadApp(
    [['config.js', read('config.js')], ['core.js', read('core.js')], ['push.js', read('push.js')], ['app.js', read('app.js')]],
    { now: NOW, getElement, createElement: () => element(), fetch });
  ctx.state.point = ctx.findPoint('murmansk');
  return ctx;
}

const json = body => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
const iso = ms => new Date(ms).toISOString().slice(0, 19);

test('пороги Kp у Кировска и Апатитов: значения NOAA 1,67 / 2,67 / 3,67 не ниже порога', () => {
  const core = loadApp([['core.js', read('core.js')]], {}).AuroraCore;
  for (const id of ['kirovsk', 'apatity']) {
    const t = core.kpThresholds(core.findPoint(id));
    assert.deepEqual([t.low, t.mid, t.high], [1.67, 2.67, 3.67], id);
    assert.equal(core.activityScore({ kp: 2.67 }, core.findPoint(id)).score, 2, id + ': 2,67 — средняя активность');
    assert.equal(core.activityScore({ kp: 3.67 }, core.findPoint(id)).score, 3, id + ': 3,67 — высокая');
  }
});

test('солнечный ветер: mean60 доходит до вердикта, слабо южный час «копит энергию»', async () => {
  const rows = [];
  for (let m = 0; m < 180; m++) rows.push({ time_tag: iso(NOW - m * MIN), active: true, source: 'SOLAR1', bt: 4, bz_gsm: -2.5 });
  const ctx = page(url => (String(url).includes('rtsw_mag') ? json(rows)
    : String(url).includes('solar-wind-speed') ? json([{ proton_speed: 400, time_tag: iso(NOW) }])
      : Promise.reject(new TypeError('Failed to fetch'))));
  await ctx.loadSolarWind();
  assert.equal(ctx.state.sw.mean60, -2.5);
  assert.equal(ctx.state.sw.source, 'SOLAR1');
  assert.equal(ctx.state.sw.fallback, false);
  assert.equal(ctx.bzActivity(ctx.state.sw), 'loading');
});

const kpRows = (ageMin, value) => [{ time_tag: iso(NOW - ageMin * MIN), estimated_kp: value, kp: String(value) }];

test('Kp: свежая минутная оценка — не устаревшая', async () => {
  const ctx = page(url => (String(url).includes('planetary_k_index_1m') ? json(kpRows(2, 3)) : Promise.reject(new TypeError('x'))));
  const kp = await ctx.loadKp();
  assert.equal(kp.value, 3);
  assert.equal(kp.stale, null);
});

test('Kp: замерший минутный ряд не выдаётся за «сейчас», берётся трёхчасовой', async () => {
  const calls = [];
  const ctx = page(url => {
    calls.push(String(url));
    if (String(url).includes('planetary_k_index_1m')) return json(kpRows(6 * 60, 7));
    if (String(url).includes('noaa-planetary-k-index.json')) return json([{ time_tag: iso(NOW - 120 * MIN), Kp: 2 }]);
    return Promise.reject(new TypeError('x'));
  });
  const kp = await ctx.loadKp();
  assert.ok(calls.some(u => u.includes('noaa-planetary-k-index.json')), 'запрошен трёхчасовой ряд');
  assert.equal(kp.value, 2);
  assert.equal(kp.stale, null);
});

test('Kp старше 4 часов помечен устаревшим: без «за час» в вердикте и без уведомлений', async () => {
  const ctx = page(url => (String(url).includes('planetary_k_index_1m') ? json(kpRows(6 * 60, 7))
    : String(url).includes('noaa-planetary-k-index.json') ? json([{ time_tag: iso(NOW - 330 * MIN), Kp: 7 }])
      : Promise.reject(new TypeError('x'))));
  const kp = await ctx.loadKp();
  assert.ok(kp.stale > 4 * 60 * MIN);
  assert.equal(ctx.activityInput(kp).kpHour, null);
  // и после перезагрузки возраст считается по времени значения, а не по моменту сохранения
  const restored = ctx.restoreKp(ctx.cacheLoad('kp'), false);
  assert.ok(restored.stale > 4 * 60 * MIN);
});

test('серверные уведомления для своего места оформляются на ближайшую точку области', () => {
  const src = appSource();
  assert.doesNotMatch(src, /pushSubscribe\(currentPoint\(\)/);
  assert.match(src, /pushSubscribe\(pushPoint\(\)\.id\)/);
});

test('запасная копия сервера (X-Stale) уступает прямому запросу к NOAA, но выручает, если он не ответил', async () => {
  const KP = 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json';
  const make = direct => loadApp(
    [['config.js', read('config.js')], ['core.js', read('core.js')], ['push.js', read('push.js')], ['app.js', read('app.js')]],
    {
      now: NOW, rawFetch: true, getElement: () => element(), createElement: () => element(),
      fetch: async url => (String(url).includes('/noaa/kp')
        ? new Response('[{"v":"stale"}]', { status: 200, headers: { 'X-Stale': '1' } })
        : direct())
    });
  const fresh = make(async () => new Response('[{"v":"fresh"}]', { status: 200 }));
  assert.equal((await fresh.fetchJson(KP))[0].v, 'fresh');
  const down = make(async () => { throw new TypeError('Failed to fetch'); });
  assert.equal((await down.fetchJson(KP))[0].v, 'stale');
});

test('координаты: «68,35» в поле широты — одна координата, а не пара 68 и 35', () => {
  const ctx = page(() => Promise.reject(new TypeError('x')));
  assert.equal(ctx.parseCoordPair('68,35'), null);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.parseCoordPair('68.97, 33.10'))), { lat: 68.97, lon: 33.1 });
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.parseCoordPair('68,97 33,10'))), { lat: 68.97, lon: 33.1 });
});

test('имя своего места по умолчанию не повторяется после удаления', () => {
  const ctx = page(() => Promise.reject(new TypeError('x')));
  ctx.addPlace('', 68.5, 33.5);
  ctx.addPlace('', 68.6, 33.6);
  ctx.removePlace(ctx.userPlaces()[0].id);
  ctx.addPlace('', 68.7, 33.7);
  const names = ctx.userPlaces().map(p => p.name);
  assert.equal(new Set(names).size, names.length, names.join(' / '));
});

test('страхующий запрос: упали оба, один с лимитом — показываем лимит, а не «нет соединения»', async () => {
  const ctx = page(() => Promise.reject(new TypeError('x')));
  const offline = () => Promise.reject(ctx.appError('offline'));
  const limited = () => Promise.reject(ctx.appError('rate_limit'));
  await assert.rejects(ctx.hedgeFetch(offline, limited, 10), err => err.code === 'rate_limit');
});

test('скорость солнечного ветра старше получаса не идёт в «дойдёт через N минут»', () => {
  const ctx = page(() => Promise.reject(new TypeError('x')));
  assert.equal(ctx.readSpeed([{ proton_speed: 400, time_tag: iso(NOW - 2 * MIN) }]), 400);
  assert.equal(ctx.readSpeed([{ proton_speed: 400, time_tag: iso(NOW - 3 * 60 * MIN) }]), null);
});
