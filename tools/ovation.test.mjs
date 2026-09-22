// NOAA OVATION: вероятность сияния над точкой и в поле зрения, карточка, частота запросов.
// Запуск: node --test tools/ovation.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadApp } from './app-sandbox.mjs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const core = loadApp([['core.js', read('core.js')]], {}).AuroraCore;

const NOW = Date.parse('2026-12-15T22:00:00Z');
const MIN = 60000;

/** Сетка как у NOAA: [долгота 0..359, широта −90..90, вероятность]; value(lon, lat) → %. */
function ovation(value, { observed = NOW - 5 * MIN, forecast = NOW + 40 * MIN } = {}) {
  const coordinates = [];
  for (let lon = 0; lon < 360; lon++) {
    for (let lat = -90; lat <= 90; lat++) coordinates.push([lon, lat, value(lon, lat)]);
  }
  return {
    'Observation Time': new Date(observed).toISOString().slice(0, 19) + 'Z',
    'Forecast Time': new Date(forecast).toISOString().slice(0, 19) + 'Z',
    'Data Format': '[Longitude, Latitude, Aurora]',
    coordinates
  };
}

const murmansk = { id: 'murmansk', lat: 68.9678, lon: 33.0992 };

test('над точкой — ближайшая клетка сетки (округление координат)', () => {
  const s = core.ovationSummary(ovation((lon, lat) => (lon === 33 && lat === 69 ? 42 : 1)), [murmansk], NOW);
  assert.equal(s.points.murmansk.overhead, 42);
});

test('в поле зрения — максимум до 5° к северу и ±3° по долготе; южнее и дальше не считается', () => {
  const at = (dLon, dLat, v = 60) => (lon, lat) => (lon === 33 + dLon && lat === 69 + dLat ? v : 5);
  assert.equal(core.ovationSummary(ovation(at(0, 5)), [murmansk], NOW).points.murmansk.view, 60, '5° к северу');
  assert.equal(core.ovationSummary(ovation(at(3, 2)), [murmansk], NOW).points.murmansk.view, 60, '3° к востоку');
  assert.equal(core.ovationSummary(ovation(at(-3, 0)), [murmansk], NOW).points.murmansk.view, 60, '3° к западу');
  assert.equal(core.ovationSummary(ovation(at(0, 6)), [murmansk], NOW).points.murmansk.view, 5, '6° к северу — за горизонтом');
  assert.equal(core.ovationSummary(ovation(at(4, 0)), [murmansk], NOW).points.murmansk.view, 5, '4° по долготе — уже нет');
  assert.equal(core.ovationSummary(ovation(at(0, -1)), [murmansk], NOW).points.murmansk.view, 5, 'южнее точки не берём');
});

test('долгота переходит через 0°: точка у Гринвича видит клетки 358–359°', () => {
  const point = { id: 'g', lat: 69, lon: 0.4 };
  const s = core.ovationSummary(ovation((lon, lat) => (lon === 358 && lat === 70 ? 33 : 2)), [point], NOW);
  assert.equal(s.points.g.view, 33);
});

test('у полюса поле зрения не выходит за 90°', () => {
  const point = { id: 'n', lat: 88, lon: 10 };
  const s = core.ovationSummary(ovation(() => 7), [point], NOW);
  assert.equal(s.points.n.view, 7);
});

test('все семь точек за один проход; времена наблюдения и прогноза', () => {
  const s = core.ovationSummary(ovation((lon, lat) => lat), core.POINTS, NOW);
  assert.deepEqual([...Object.keys(s.points)].sort(), [...core.POINTS.map(p => p.id)].sort());
  assert.equal(s.points.murmansk.overhead, 69);
  assert.equal(s.points.murmansk.view, 74);
  assert.equal(s.forecast.getTime(), NOW + 40 * MIN);
});

test('негодные данные — null: не объект, без сетки, пустая сетка, устаревшее наблюдение', () => {
  assert.equal(core.ovationSummary(null, [murmansk], NOW), null);
  assert.equal(core.ovationSummary({}, [murmansk], NOW), null);
  assert.equal(core.ovationSummary({ 'Observation Time': new Date(NOW).toISOString(), coordinates: [] }, [murmansk], NOW), null);
  assert.equal(core.ovationSummary(ovation(() => 50, { observed: NOW - 2 * 60 * MIN }), [murmansk], NOW), null, 'два часа назад');
  assert.ok(core.ovationSummary(ovation(() => 50, { observed: NOW - 60 * MIN }), [murmansk], NOW), 'час назад — ещё годится');
});

test('мусор в клетках не ломает расчёт, значения зажаты в 0–100', () => {
  const data = ovation(() => 3);
  data.coordinates.push([33, 70, 'x'], null, [33], [33, 71, 250], [33, 72, -5]);
  const s = core.ovationSummary(data, [murmansk], NOW);
  assert.equal(s.points.murmansk.view, 100);
});

/* ---------------- страница ---------------- */

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

function page(fetchImpl, clock = { now: NOW }) {
  const elements = new Map();
  const getElement = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const calls = [];
  const fetch = url => { calls.push(String(url)); return fetchImpl(url); };
  const ctx = loadApp(
    [['config.js', read('config.js')], ['core.js', read('core.js')], ['push.js', read('push.js')], ['app.js', read('app.js')]],
    { clock, getElement, createElement: () => element(), fetch });
  ctx.state.point = ctx.findPoint('murmansk');
  return { ctx, el: getElement, calls };
}

const ok = body => () => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
const offline = () => Promise.reject(new TypeError('Failed to fetch'));

test('карточка: вероятность в поле зрения, подпись по уровню, над точкой и время прогноза', async () => {
  const { ctx, el } = page(ok(ovation((lon, lat) => (lat >= 69 && lat <= 74 ? lat - 30 : 5))));
  await ctx.loadOvation(false);
  assert.equal(el('ov-value').textContent, '44%');
  assert.equal(el('ov-caption').textContent, 'Сияние в поле зрения вероятно.');
  assert.equal(el('ov-facts').textContent, 'прямо над точкой 39% · прогноз на 01:40');
  assert.equal(el('ov-card').attrs['data-state'], 'ok');

  ctx.setLang('en');
  ctx.renderOvation();
  assert.equal(el('ov-caption').textContent, 'Aurora within view is likely.');
  assert.equal(el('ov-facts').textContent, 'directly overhead 39% · forecast for 01:40');
});

test('уровни и пороги: 50 — яркое, 30 — вероятно, 10 — слабая дуга, ниже — почти нет', () => {
  const { ctx } = page(offline);
  assert.deepEqual([50, 49, 30, 29, 10, 9, 0].map(v => ctx.ovationLevel(v)), ['high', 'mid', 'mid', 'low', 'low', 'none', 'none']);
});

test('смена точки: значение берётся из уже загруженного, без нового запроса', async () => {
  const { ctx, el, calls } = page(ok(ovation((lon, lat) => (lat >= 70 ? 60 : 3))));
  await ctx.loadOvation(false);
  assert.equal(el('ov-value').textContent, '60%');
  ctx.state.point = ctx.findPoint('kandalaksha');     // 67°: поле зрения до 72° — там 60
  ctx.renderOvation();
  assert.equal(el('ov-facts').textContent.startsWith('прямо над точкой 3%'), true);
  assert.equal(calls.length, 1);
});

test('файл большой: пока сохранённому меньше 15 минут, сеть не трогаем; «Повторить» запрашивает всегда', async () => {
  const clock = { now: NOW };
  const { ctx, calls } = page(ok(ovation(() => 20)), clock);
  await ctx.loadOvation(false);
  assert.equal(calls.length, 1);

  clock.now = NOW + 10 * MIN;
  await ctx.loadOvation(false);
  assert.equal(calls.length, 1, 'через 10 минут — из сохранённого');
  assert.equal(ctx.state.ov.stale, null, 'и оно считается свежим');

  await ctx.loadOvation(true);
  assert.equal(calls.length, 2, 'кнопка «Повторить»');

  clock.now = NOW + 26 * MIN;
  await ctx.loadOvation(false);
  assert.equal(calls.length, 3, 'через 16 минут после последнего — снова в сеть');
});

test('в кэш кладутся только числа по точкам, а не сетка Земли', async () => {
  const { ctx } = page(ok(ovation(() => 20)));
  await ctx.loadOvation(false);
  const saved = ctx.localStorage.getItem('aurora.ovation');
  assert.ok(saved.length < 2000, 'длина записи ' + saved.length);
  assert.doesNotMatch(saved, /coordinates/);
});

test('нет связи: сохранённое с пометкой возраста; без сохранённого — ошибка с причиной', async () => {
  const clock = { now: NOW };
  const first = page(ok(ovation(() => 20)), clock);
  await first.ctx.loadOvation(false);
  const saved = first.ctx.localStorage.getItem('aurora.ovation');

  clock.now = NOW + 40 * MIN;
  const second = page(offline, clock);
  second.ctx.localStorage.setItem('aurora.ovation', saved);
  const ov = await second.ctx.loadOvation(false);
  assert.ok(ov);
  assert.equal(second.el('ov-card').attrs['data-state'], 'stale');

  const empty = page(offline);
  assert.equal(await empty.ctx.loadOvation(false), null);
  assert.equal(empty.el('ov-error').textContent, 'Модель OVATION недоступна: нет соединения.');

  const old = page(ok(ovation(() => 20, { observed: NOW - 3 * 60 * MIN })));
  assert.equal(await old.ctx.loadOvation(false), null);
  assert.equal(old.el('ov-error').textContent, 'Модель OVATION недоступна: модель давно не обновлялась.');
});

test('обновление страницы и кнопка «Повторить» подключены', () => {
  const app = read('app.js');
  assert.match(app, /var tasks = \[[^\]]*loadOvation\(false\)[^\]]*\];/);
  assert.match(app, /if \(what === 'ov'\)\s+loadOvation\(true\);/);
  assert.equal((read('index.html').match(/data-retry="ov"/g) || []).length, 2);
});
