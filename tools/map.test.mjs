// Вкладка «Карта»: схема из map.js, точки-кнопки, цвет по шансу, выбор точки и переход к её условиям.
// Запуск: node --test tools/map.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { loadApp } from './app-sandbox.mjs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const plain = v => JSON.parse(JSON.stringify(v));

const map = (() => {
  const ctx = vm.createContext({ Math });
  vm.runInContext(read('map.js'), ctx);
  return ctx;
})();
const core = loadApp([['core.js', read('core.js')]], {}).AuroraCore;

test('map.js: рамка и проекция — углы рамки в углах карты, север сверху', () => {
  const m = map.REGION_MAP;
  assert.deepEqual(plain(map.mapPosition(m.latMax, m.lonMin)), { x: 0, y: 0 });
  const far = map.mapPosition(m.latMin, m.lonMax);
  assert.ok(Math.abs(far.x - 1) < 1e-9 && Math.abs(far.y - 1) < 1e-9);
  assert.ok(map.mapPosition(69, 33).y < map.mapPosition(67, 33).y, 'север выше');
  assert.ok(map.mapPosition(68, 35).x > map.mapPosition(68, 33).x, 'восток правее');
});

test('map.js: все семь точек внутри карты с запасом от краёв', () => {
  for (const p of core.POINTS) {
    const { x, y } = map.mapPosition(p.lat, p.lon);
    assert.ok(x > 0.05 && x < 0.9 && y > 0.05 && y < 0.95, `${p.id}: ${x.toFixed(2)}, ${y.toFixed(2)}`);
  }
});

test('map.js: контуры области и озёр есть, файл лёгкий', () => {
  const m = map.REGION_MAP;
  // координаты могут быть чуть за краем: контуры отсекаются с запасом, чтобы край не был виден
  assert.match(m.region, /^M-?[\d.]+ -?[\d.]+L/);
  assert.match(m.lakes, /^M-?[\d.]+ -?[\d.]+L/);
  assert.ok(read('map.js').length < 30000, 'размер ' + read('map.js').length);
  assert.ok(Math.abs(m.width / m.height - 1) < 0.2, 'почти квадрат — удобно на телефоне');
});

/* ---------------- страница ---------------- */

const element = () => ({
  textContent: '', hidden: false, disabled: false, className: '', type: '', id: '',
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

function page(extra = {}) {
  const elements = new Map();
  const getElement = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const ctx = loadApp(
    [['config.js', read('config.js')], ['core.js', read('core.js')], ['push.js', read('push.js')], ['app.js', read('app.js')]],
    { now: Date.parse('2026-12-15T18:00:00Z'), getElement, createElement: () => element(), ...extra });
  ctx.state.point = ctx.findPoint('murmansk');
  return { ctx, el: getElement };
}

/** Окна по точкам: level по id; teriberka — высокий, murmansk — средний, остальные — низкий. */
function withWindows(ctx, levels = { teriberka: 2, murmansk: 1 }) {
  const from = new Date('2026-12-15T20:00:00Z'), to = new Date('2026-12-16T01:00:00Z');
  ctx.computeAllWindows = () => ctx.POINTS.map(point => ({
    point,
    window: point.id === 'kandalaksha' ? { polarDay: true } :
      { polarDay: false, level: levels[point.id] ?? 0, from, to, cloudMin: 10, cloudMax: 20, kpMax: 3, fullDark: true, point }
  }));
  ctx.state.tonight = { rows: [], stale: null };
}

const markers = el => el('map-markers').children;
const byId = (el, id) => markers(el).find(b => b.attrs['data-point'] === id);

test('на карте семь точек-кнопок на своих местах, с подписью на языке страницы', () => {
  const { ctx, el } = page();
  withWindows(ctx);
  ctx.renderMap();
  assert.equal(markers(el).length, 7);
  const teriberka = byId(el, 'teriberka');
  const pos = map.mapPosition(69.1609, 35.1453);
  assert.equal(teriberka.style.left, (pos.x * 100) + '%');
  assert.equal(teriberka.style.top, (pos.y * 100) + '%');
  assert.equal(teriberka.children[1].textContent, 'Териберка');
  ctx.setLang('zh');
  ctx.renderMap();
  assert.equal(byId(el, 'teriberka').children[1].textContent, '捷里别尔卡');
});

test('цвет точки — шанс на ночь; без темноты — «плохо»; подпись для скринридера', () => {
  const { ctx, el } = page();
  withWindows(ctx);
  ctx.renderMap();
  assert.equal(byId(el, 'teriberka').style['--tone'], 'var(--ok)');
  assert.equal(byId(el, 'murmansk').style['--tone'], 'var(--mid)');
  assert.equal(byId(el, 'lovozero').style['--tone'], 'var(--bad)');
  assert.equal(byId(el, 'kandalaksha').style['--tone'], 'var(--bad)');
  assert.equal(byId(el, 'teriberka').attrs['aria-label'], 'Териберка, Высокий шанс');
  assert.equal(byId(el, 'kandalaksha').attrs['aria-label'], 'Кандалакша, Нет темноты');
});

test('подписи Кировска и Апатитов разведены в разные стороны; текущая точка выделена', () => {
  const { ctx, el } = page();
  withWindows(ctx);
  ctx.renderMap();
  assert.match(byId(el, 'apatity').className, /mappt--left/);
  assert.doesNotMatch(byId(el, 'kirovsk').className, /mappt--left/);
  assert.match(byId(el, 'murmansk').className, /mappt--current/);
  assert.doesNotMatch(byId(el, 'teriberka').className, /mappt--current/);
});

test('нажатие на точку: она выбрана, под картой её подробности и кнопка перехода', () => {
  const { ctx, el } = page();
  withWindows(ctx);
  ctx.initMapTab();
  ctx.renderMap();
  assert.equal(byId(el, 'murmansk').attrs['aria-pressed'], 'true', 'по умолчанию — текущая точка');
  assert.equal(el('map-info').children[1].textContent, 'Смотреть условия в этой точке');

  el('map-markers').listeners.click({ target: { closest: () => ({ getAttribute: () => 'teriberka' }) } });
  assert.equal(byId(el, 'teriberka').attrs['aria-pressed'], 'true');
  assert.equal(byId(el, 'murmansk').attrs['aria-pressed'], 'false');
  const row = el('map-info').children[0];
  assert.equal(row.children[0].textContent, 'Териберка');
  assert.equal(row.children[1].textContent, 'Высокий шанс');
  assert.equal(el('map-info').children[1].textContent, 'Смотреть условия: Териберка');
});

test('«Смотреть условия»: точка становится точкой наблюдения, открывается «Сейчас»', () => {
  const { ctx, el } = page({ fetch: () => new Promise(() => {}) });
  withWindows(ctx);
  ctx.initMapTab();
  ctx.state.mapPoint = 'teriberka';
  ctx.renderMap();
  vm.runInContext('pushSync = function () { return Promise.resolve("off"); };', ctx);

  el('map-info').listeners.click({ target: { closest: () => ({ getAttribute: () => 'teriberka' }) } });
  assert.equal(ctx.state.point.id, 'teriberka');
  assert.equal(el('point').value, 'teriberka');
  assert.equal(ctx.localStorage.getItem('aurora.point'), 'teriberka');
  assert.equal(ctx.state.tab, 'now');
});

test('без данных по точкам: точки видны без оценки, статус объясняет, «Смотреть условия» работает', () => {
  const { ctx, el } = page();
  ctx.renderMap();
  assert.equal(markers(el).length, 7);
  assert.ok(markers(el).every(b => /mappt--nodata/.test(b.className)));
  assert.equal(el('map-status').textContent, 'Нет данных об облачности — точки показаны без оценки.');
  ctx.state.tonightLoading = true;
  ctx.renderMap();
  assert.equal(el('map-status').textContent, 'Загружаем облачность по точкам…');
  assert.equal(el('map-info').children[0].textContent, 'Мурманск');
});

test('сохранённые данные — статус с возрастом', () => {
  const { ctx, el } = page();
  withWindows(ctx);
  ctx.state.tonight.stale = 25 * 60000;
  ctx.renderMap();
  assert.equal(el('map-status').textContent, 'Расчёт по сохранённым данным: 25 минут назад');
});

test('открытие вкладки «Карта» запрашивает данные по точкам, как «Куда ехать»', () => {
  const calls = [];
  const { ctx } = page({ fetch: url => { calls.push(String(url)); return new Promise(() => {}); } });
  ctx.showTab('map', 'replace');
  assert.equal(ctx.state.tab, 'map');
  assert.ok(calls.some(u => u.includes('api.open-meteo.com') && u.includes(',')), 'запрос сразу по всем точкам');
});

test('разметка: вкладка «Карта» после «Куда ехать», map.js подключён и лежит в оболочке service worker', () => {
  const html = read('index.html');
  assert.match(html, /id="tab-btn-tonight"[\s\S]*id="tab-btn-map"[\s\S]*id="tab-btn-guide"/);
  assert.match(html, /<section class="wrap" id="tab-map" role="tabpanel" aria-labelledby="tab-btn-map" tabindex="0" hidden>/);
  assert.ok(html.indexOf('src="map.js"') < html.indexOf('src="app.js"'));
  assert.match(read('sw.js'), /'map\.js'/);
});

test('настройка «Открывать на вкладке» умеет открывать карту', () => {
  const { ctx } = page();
  ctx.setSetting('start', 'map');
  assert.equal(ctx.startTab('', 'now'), 'map');
});
