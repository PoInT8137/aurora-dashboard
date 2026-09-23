// Слой облачности на карте: сетка узлов, запрос, разбор ответа, заливка между узлами,
// ползунок по часам, облачность в выбранной точке, кэш и отказ сети.
// Запуск: node --test tools/clouds.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { loadApp } from './app-sandbox.mjs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const plain = v => JSON.parse(JSON.stringify(v));
const NOW = Date.parse('2026-12-15T18:20:00Z');
const HOUR = 3600000;

const element = () => ({
  textContent: '', hidden: false, disabled: false, className: '', type: '', id: '', value: '', max: '',
  width: 0, height: 0,
  style: { setProperty(k, v) { this[k] = v; } },
  children: [], attrs: {}, listeners: {},
  setAttribute(k, v) { this.attrs[k] = String(v); },
  getAttribute(k) { return this.attrs[k] ?? null; },
  addEventListener(type, fn) { this.listeners[type] = fn; },
  querySelector() { return element(); },
  querySelectorAll() { return []; },
  getBoundingClientRect() { return { height: 0 }; },
  appendChild(child) { this.children.push(child); return child; },
  set innerHTML(value) { if (value === '') this.children = []; },
  get innerHTML() { return ''; }
});

/** Холст, запоминающий последнюю картинку. */
function canvasElement() {
  const el = element();
  el.getContext = () => ({
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData(image) { el.image = image; }
  });
  return el;
}

function page(extra = {}) {
  const elements = new Map([['map-clouds', canvasElement()]]);
  const getElement = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const ctx = loadApp(
    [['config.js', read('config.js')], ['core.js', read('core.js')], ['push.js', read('push.js')], ['app.js', read('app.js')]],
    { now: NOW, getElement, createElement: () => element(), ...extra });
  ctx.state.point = ctx.findPoint('murmansk');
  return { ctx, el: getElement };
}

/** Ответ Open-Meteo для всех узлов: cloud(node, hour) → ярусы { low, mid, high }. */
function response(ctx, cloud, hours = 24, start = Date.parse('2026-12-15T18:00:00Z')) {
  return ctx.cloudGridCells().map((cell, n) => {
    const time = [], low = [], mid = [], high = [], total = [];
    for (let h = 0; h < hours; h++) {
      const c = cloud(n, h, cell);
      time.push((start + h * HOUR) / 1000);
      low.push(c.low); mid.push('mid' in c ? c.mid : 0); high.push('high' in c ? c.high : 0); total.push('total' in c ? c.total : c.low);
    }
    return { latitude: cell.lat, longitude: cell.lon, hourly: { time, cloud_cover: total, cloud_cover_low: low, cloud_cover_mid: mid, cloud_cover_high: high } };
  });
}

test('сетка: 9 × 10 узлов по центрам ячеек рамки схемы, первый ряд — северный', () => {
  const { ctx } = page();
  const cells = plain(ctx.cloudGridCells());
  const m = ctx.REGION_MAP;
  assert.equal(cells.length, 90);
  assert.ok(cells.every(c => c.lat > m.latMin && c.lat < m.latMax && c.lon > m.lonMin && c.lon < m.lonMax));
  assert.ok(cells[0].lat > cells[89].lat, 'сверху — север');
  assert.ok(cells[0].lon < cells[8].lon, 'в ряду — с запада на восток');
  // узел ложится в центр своей ячейки на схеме
  const pos = ctx.mapPosition(cells[9 * 3 + 4].lat, cells[9 * 3 + 4].lon);
  assert.ok(Math.abs(pos.x - 4.5 / 9) < 1e-3 && Math.abs(pos.y - 3.5 / 10) < 1e-3, JSON.stringify(pos));
});

test('запрос один: все узлы в одном порядке, та же модель, что у точек, сутки вперёд, короткий адрес', () => {
  const { ctx } = page();
  const cells = ctx.cloudGridCells();
  const url = new URL(ctx.cloudGridUrl(cells));
  assert.equal(url.searchParams.get('latitude').split(',').length, 90);
  assert.deepEqual(url.searchParams.get('longitude').split(',').map(Number), plain(cells).map(c => c.lon));
  assert.equal(url.searchParams.get('models'), ctx.CONFIG.weatherModel);
  assert.equal(url.searchParams.get('forecast_hours'), '24');
  assert.match(url.searchParams.get('hourly'), /cloud_cover_low,cloud_cover_mid,cloud_cover_high/);
  assert.ok(url.href.length < 2000, 'длина адреса ' + url.href.length);
});

test('разбор: облачность по ярусам — как у точек (модель перекрытия), пробелы — null, чужая длина — ошибка', () => {
  const { ctx } = page();
  const data = response(ctx, (n, h) => (n === 5 && h === 2 ? { low: null, mid: null, high: null, total: null } : { low: 50, mid: 50, high: 0 }));
  const grid = ctx.readCloudGrid(data, 90);
  assert.equal(grid.times.length, 24);
  assert.equal(grid.times[0], Date.parse('2026-12-15T18:00:00Z'));
  assert.equal(grid.values[0][0], ctx.effectiveCloud({ low: 50, mid: 50, high: 0 }));
  assert.equal(grid.values[0][0], 70, '1 − 0,5 · 0,6');
  assert.equal(grid.values[2][5], null);
  assert.throws(() => ctx.readCloudGrid(data.slice(1), 90), e => e.code === 'points_count');
  assert.throws(() => ctx.readCloudGrid({ error: true }, 90), e => e.code === 'not_list');
  // узел с чужими часами не выдаёт чужое значение за своё
  data[7].hourly.time = data[7].hourly.time.map(s => s + 1800);
  assert.equal(ctx.readCloudGrid(data, 90).values[0][7], null);
});

test('прошедшие часы отбрасываются (данные из кэша); совсем старые — не показываются', () => {
  const { ctx } = page();
  const grid = { times: [0, 1, 2, 3].map(h => h * HOUR), values: [[1], [2], [3], [4]] };
  assert.deepEqual(plain(ctx.cloudGridFrom(grid, 0)).values, [[1], [2], [3], [4]]);
  assert.deepEqual(plain(ctx.cloudGridFrom(grid, 1.5 * HOUR)).values, [[2], [3], [4]], 'текущий час — первый');
  assert.equal(ctx.cloudGridFrom(grid, 4 * HOUR), null);
});

test('заливка между узлами: в узле — его значение, между — среднее, за краем — крайний узел, пустые не тянут к нулю', () => {
  const { ctx } = page();
  const values = new Array(90).fill(0);
  values[9 * 4 + 4] = 100;
  const at = (c, r) => ctx.cloudAt(values, (c + 0.5) / 9, (r + 0.5) / 10);
  assert.equal(at(4, 4), 100);
  assert.equal(at(3, 4), 0);
  assert.ok(Math.abs(ctx.cloudAt(values, 4 / 9, 4.5 / 10) - 50) < 1e-9, 'ровно посередине');
  const row = [30, 60, ...new Array(88).fill(0)];
  assert.equal(ctx.cloudAt(row, 0, 0), 30, 'угол = крайний узел');
  const gaps = new Array(90).fill(null);
  gaps[0] = 80;
  assert.equal(ctx.cloudAt(gaps, 1 / 9, 0.5 / 10), 80, 'пустые узлы не считаются нулём');
  assert.equal(ctx.cloudAt(new Array(90).fill(null), 0.5, 0.5), null);
});

test('непрозрачность: ясно — нет облаков, дальше растёт, сплошные не закрывают схему полностью', () => {
  const { ctx } = page();
  assert.equal(ctx.cloudAlpha(null), 0);
  assert.equal(ctx.cloudAlpha(5), 0);
  assert.equal(ctx.cloudAlpha(10), 0);
  let prev = 0;
  for (let v = 15; v <= 100; v += 5) { const a = ctx.cloudAlpha(v); assert.ok(a > prev, 'v=' + v); prev = a; }
  assert.ok(Math.abs(ctx.cloudAlpha(100) - 0.66) < 1e-9);
  assert.equal(ctx.cloudAlpha(150), ctx.cloudAlpha(100));
});

test('подпись часа: «Сейчас», дальше время и через сколько часов — на языке страницы', () => {
  const { ctx } = page();
  const times = [0, 1, 2, 5].map(h => Date.parse('2026-12-15T15:00:00Z') + h * HOUR);
  assert.equal(ctx.cloudHourLabel(times, 0), 'Сейчас');
  assert.equal(ctx.cloudHourLabel(times, 1), '19:00, через 1 час');
  assert.equal(ctx.cloudHourLabel(times, 3), '23:00, через 3 часа');
  ctx.setLang('en');
  assert.equal(ctx.cloudHourLabel(times, 1), '19:00, in 1 hour');
});

/** Загруженная сетка: запад (левые 4 столбца) закрыт, восток ясен; через 3 часа всё закрыто. */
function loaded(extra = {}) {
  let calls = 0;
  const holder = {};
  const p = page({
    fetch: async url => {
      calls++;
      holder.url = url;
      const body = response(holder.ctx, (n, h) => ({ low: h >= 3 || n % 9 < 4 ? 100 : 0 }));
      return new Response(JSON.stringify(body), { status: 200 });
    },
    ...extra
  });
  holder.ctx = p.ctx;
  return { ...p, calls: () => calls, holder };
}

test('открыли карту: сетка загружается, облака рисуются, ползунок включён, облачность у точки числом', async () => {
  const { ctx, el, calls } = loaded();
  ctx.initClouds();
  await ctx.loadCloudGrid(false);
  assert.equal(calls(), 1);
  const canvas = el('map-clouds');
  assert.equal(canvas.hidden, false);
  assert.equal(canvas.width, 9 * 12);
  // слева облака плотные, справа пусто
  const alphaAt = (x, y) => canvas.image.data[(y * canvas.width + x) * 4 + 3];
  assert.ok(alphaAt(5, 50) > 150, 'запад закрыт');
  assert.equal(alphaAt(canvas.width - 5, 50), 0, 'восток ясен');
  assert.equal(el('map-hour').disabled, false);
  assert.equal(el('map-hour').max, '23');
  assert.equal(el('map-hour-label').textContent, 'Сейчас');
  assert.match(el('map-clouds-here').textContent, /^Облачность у точки «Мурманск»: \d+ %$/);
  assert.equal(ctx.state.cloudGridError, false);
  // сохранено в кэш
  assert.ok(ctx.localStorage.getItem('aurora.cloudgrid'));
});

test('ползунок: через 3 часа — всё закрыто, подпись и значение для скринридера меняются', async () => {
  const { ctx, el } = loaded();
  ctx.initClouds();
  await ctx.loadCloudGrid(false);
  el('map-hour').value = '3';
  el('map-hour').listeners.input();
  assert.equal(ctx.state.cloudHour, 3);
  assert.equal(el('map-hour-label').textContent, '00:00, через 3 часа', 'сейчас 21:20 МСК');
  assert.equal(el('map-hour').attrs['aria-valuetext'], '00:00, через 3 часа');
  assert.equal(el('map-clouds-here').textContent, 'Облачность у точки «Мурманск»: 100 %');
});

test('облачность под текстом — у точки, выбранной на карте, а не только у текущей', async () => {
  const { ctx, el } = loaded();
  await ctx.loadCloudGrid(false);
  ctx.state.mapPoint = 'teriberka';
  ctx.renderClouds();
  assert.match(el('map-clouds-here').textContent, /^Облачность у точки «Териберка»: /);
});

test('кнопка «Показывать»: слой прячется, ползунок выключается, выбор запоминается', async () => {
  const { ctx, el } = loaded();
  ctx.initClouds();
  await ctx.loadCloudGrid(false);
  el('map-clouds-toggle').listeners.click();
  assert.equal(el('map-clouds-toggle').attrs['aria-pressed'], 'false');
  assert.equal(el('map-clouds').hidden, true);
  assert.equal(el('map-hour').disabled, true);
  assert.equal(ctx.localStorage.getItem('aurora.clouds'), 'off');
  el('map-clouds-toggle').listeners.click();
  assert.equal(el('map-clouds').hidden, false);
  assert.equal(ctx.localStorage.getItem('aurora.clouds'), 'on');
});

test('не чаще раза в час: повторное открытие карты не идёт в сеть, «Обновить» — идёт', async () => {
  const { ctx, calls } = loaded();
  await ctx.loadCloudGrid(false);
  await ctx.loadCloudGrid(false);
  assert.equal(calls(), 1);
  await ctx.loadCloudGrid(true);
  assert.equal(calls(), 2);
});

test('нет сети и нет кэша: слой скрыт, понятное сообщение; с кэшем — облака из кэша с пометкой возраста', async () => {
  const offline = page({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
  await offline.ctx.loadCloudGrid(false);
  assert.equal(offline.el('map-clouds').hidden, true);
  assert.equal(offline.el('map-hour').disabled, true);
  assert.equal(offline.el('map-clouds-status').textContent, 'Не удалось загрузить облака — точки показаны без них.');

  const withCache = page({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
  const grid = withCache.ctx.readCloudGrid(response(withCache.ctx, () => ({ low: 100 })), 90);
  withCache.ctx.localStorage.setItem('aurora.cloudgrid', JSON.stringify({ savedAt: NOW - 40 * 60000, payload: grid }));
  await withCache.ctx.loadCloudGrid(false);
  assert.equal(withCache.el('map-clouds').hidden, false);
  assert.match(withCache.el('map-clouds-status').textContent, /40/);
});

test('разметка: холст под точками и без нажатий, ползунок подписан, файл в оболочке service worker', () => {
  const html = read('index.html');
  const map = html.slice(html.indexOf('id="map"'), html.indexOf('id="map-markers"'));
  assert.match(map, /<canvas class="map__clouds" id="map-clouds" aria-hidden="true" hidden><\/canvas>/);
  assert.match(html, /<label class="clouds__hour" for="map-hour" id="map-hour-label"><\/label>/);
  assert.match(read('styles.css'), /\.map__clouds \{[^}]*pointer-events: none;/);
  assert.ok(html.indexOf('src="js/clouds.js"') > html.indexOf('src="js/map-tab.js"'));
  assert.match(read('sw.js'), /'js\/clouds\.js'/);
  // в светлой теме облака тёмные — иначе не видны на светлой суше
  assert.match(read('styles.css'), /\[data-theme="light"\] \.map \{ --map-cloud: 96, 108, 124; \}/);
});

test('данные грузятся только при открытии карты и обновляются вместе с остальными, если уже загружены', () => {
  const src = read('js/page.js');
  assert.match(src, /if \(id === 'map'\) \{ renderMap\(\); loadCloudGrid\(false\); \}/);
  assert.match(src, /if \(state\.cloudGrid\) tasks\.push\(loadCloudGrid\(true\)\);/);
  assert.doesNotMatch(read('app.js'), /loadCloudGrid/, 'не при старте');
});

test('береговые линии повторены поверх облаков и появляются только вместе с ними', () => {
  const html = read('index.html');
  assert.ok(html.indexOf('id="map-edges"') > html.indexOf('id="map-clouds"'), 'линии выше слоя облаков');
  assert.ok(html.indexOf('id="map-edges"') < html.indexOf('id="map-markers"'), 'но под точками');
  assert.match(read('styles.css'), /\.map__clouds\[hidden\] \+ \.map__edges \{ display: none; \}/);
  assert.match(read('js/map-tab.js'), /\$\('map-edge-land'\)\.setAttribute\('d', REGION_MAP\.region\)/);
});
