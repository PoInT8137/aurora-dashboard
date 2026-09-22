// График ночи в карточке «Лучшее время этой ночью»: столбец на час — шанс, облака, Kp, Луна, время.
// Запуск: node --test tools/night-chart.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadApp } from './app-sandbox.mjs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');

const element = () => ({
  textContent: '', hidden: false, disabled: false, className: '', type: '', tabIndex: 0,
  style: { setProperty(k, v) { this[k] = v; } },
  children: [], attrs: {}, listeners: {}, focused: false,
  setAttribute(k, v) { this.attrs[k] = String(v); },
  getAttribute(k) { return this.attrs[k] ?? null; },
  addEventListener(type, fn) { this.listeners[type] = fn; },
  querySelector(sel) {
    const m = /\[data-time="(\d+)"\]/.exec(sel);
    const cols = this.children[1] ? this.children[1].children : [];
    return m ? cols.find(c => c.attrs['data-time'] === m[1]) || null : element();
  },
  querySelectorAll() { return this.children[1] ? this.children[1].children : []; },
  getBoundingClientRect() { return { height: 0 }; },
  focus() { this.focused = true; },
  appendChild(child) { this.children.push(child); return child; },
  set innerHTML(value) { if (value === '') this.children = []; },
  get innerHTML() { return ''; }
});

// Луна почти полная и над горизонтом (взошла в 14:55, зайдёт в 05:15 UTC), Солнце глубоко внизу.
const NOW = '2026-09-26T21:30:00Z';

function page({ now = NOW, cloud = () => 10, kp = 4.3 } = {}) {
  const elements = new Map();
  const getElement = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const ctx = loadApp(
    [['config.js', read('config.js')], ['core.js', read('core.js')], ['push.js', read('push.js')], ['app.js', read('app.js')]],
    { now: Date.parse(now), getElement, createElement: () => element() });
  ctx.state.point = ctx.findPoint('murmansk');

  const start = Date.parse(now) - 60 * 60000;
  const hours = [];
  for (let h = 0; h < 30; h++) hours.push({ time: new Date(start + h * 3600000).toISOString().slice(0, 16), cloud: cloud(h) });
  ctx.state.cloud = { hours, conflict: false, stale: null };
  ctx.state.forecast = kp === null ? null : [{ time: new Date(start - 3 * 3600000), value: kp, current: true }];
  ctx.state.kp = kp === null ? null : { value: kp, stale: null };
  return { ctx, el: getElement };
}

const columns = el => el('window-hours').children[1].children;
const win = ctx => ctx.computeNightWindow(ctx.state.cloud, ctx.state.forecast, ctx.state.kp ? ctx.state.kp.value : null);

test('по столбцу на каждый час ночи, слева подписи четырёх рядов', () => {
  const { ctx, el } = page();
  ctx.renderWindow();
  const w = win(ctx);
  assert.equal(columns(el).length, w.night.length);
  const labels = el('window-hours').children[0].children.map(c => c.textContent);
  assert.deepEqual(labels, ['Шанс', 'Облака', 'Kp', 'Луна']);
  assert.equal(el('window-hours').children[1].style['--cols'], String(w.night.length));
});

test('лучшее окно в рамке, сумерки светлее, цвет шанса — по уровню часа', () => {
  const { ctx, el } = page({ cloud: h => (h < 3 ? 90 : 10) });
  ctx.renderWindow();
  const w = win(ctx);
  columns(el).forEach((col, i) => {
    const h = w.night[i];
    const inWindow = h.time >= w.from && h.time < w.to;
    assert.equal(/ncol--best/.test(col.className), inWindow, 'окно ' + i);
    assert.equal(/ncol--twilight/.test(col.className), h.alt > ctx.DARK_FULL, 'сумерки ' + i);
    assert.equal(col.children[0].style['--tone'], ctx.levelTone(h.level));
  });
  assert.ok(columns(el).some(c => !/ncol--best/.test(c.className)), 'облачные часы — вне окна');
});

test('столбики: облачность в процентах высоты, Kp — доля шкалы 0–9 (не ниже 4%); без прогноза Kp — пусто', () => {
  const { ctx, el } = page({ cloud: h => [5, 40, 100, 0][h % 4] });
  ctx.renderWindow();
  const w = win(ctx);
  columns(el).forEach((col, i) => {
    assert.equal(col.children[1].children[0].style.height, w.night[i].cloud + '%');
    assert.equal(col.children[2].children[0].style.height, (4.3 / 9 * 100) + '%');
  });

  const noKp = page({ kp: null });
  noKp.ctx.renderWindow();
  assert.ok(columns(noKp.el).every(col => col.children[2].children[0].style.height === '0%'));
});

test('Луна: отмечена в часы, когда она над горизонтом, яркость — по освещённости', () => {
  const { ctx, el } = page();
  ctx.renderWindow();
  const w = win(ctx);
  columns(el).forEach((col, i) => {
    const mid = new Date(w.night[i].time.getTime() + 30 * 60000);
    const up = ctx.moonAltitude(mid, 68.9678, 33.0992) > ctx.MOON_HORIZON;
    assert.equal(/ncol__moon--up/.test(col.children[3].className), up, 'час ' + i);
    if (up) assert.ok(Number(col.children[3].style['--moon']) > 0.95, 'почти полнолуние — яркая отметка');
  });
  assert.ok(columns(el).every(c => /ncol__moon--up/.test(c.children[3].className)), 'в ночь на 27 сентября Луна стоит всю ночь');

  // 22 сентября по эталону USNO Луна над горизонтом 16:51–20:57 UTC — в первой половине ночи
  const early = page({ now: '2026-09-22T17:30:00Z' });
  early.ctx.renderWindow();
  const marks = columns(early.el).map(c => /ncol__moon--up/.test(c.children[3].className));
  assert.ok(marks[0], 'вечером Луна видна');
  assert.ok(!marks[marks.length - 1], 'к утру зашла');
  assert.equal(marks.lastIndexOf(true) + 1, marks.indexOf(false), 'зашла один раз и больше не всходила');
});

test('подробности часа: по умолчанию — начало лучшего окна; то же для скринридера', () => {
  const { ctx, el } = page();
  ctx.renderWindow();
  const w = win(ctx);
  const first = columns(el).find(c => c.attrs['aria-pressed'] === 'true');
  assert.equal(Number(first.attrs['data-time']), w.from.getTime());
  assert.equal(el('window-detail').textContent, first.attrs['aria-label']);
  assert.match(el('window-detail').textContent,
    /^\d\d:\d\d–\d\d:\d\d · (Высокий|Средний|Низкий) шанс · облачность 10% · Kp 4,3 · (полная|неполная) темнота · Луна \d+%, (над|под) горизонтом$/);
  assert.equal(first.tabIndex, 0);
  assert.ok(columns(el).filter(c => c !== first).every(c => c.tabIndex === -1), 'в порядке Tab — только выбранный час');
});

test('нажатие на час выбирает его; стрелки листают часы и переносят фокус', () => {
  const { ctx, el } = page();
  ctx.initNightChart();
  ctx.renderWindow();
  const cols = () => columns(el);
  const target = cols()[cols().length - 1];
  el('window-hours').listeners.click({ target: { closest: () => target } });
  assert.equal(cols()[cols().length - 1].attrs['aria-pressed'], 'true');
  assert.equal(el('window-detail').textContent, cols()[cols().length - 1].attrs['aria-label']);

  let prevented = false;
  el('window-hours').listeners.keydown({ key: 'ArrowLeft', preventDefault() { prevented = true; } });
  assert.ok(prevented);
  assert.equal(cols()[cols().length - 2].attrs['aria-pressed'], 'true');
  assert.equal(cols()[cols().length - 2].focused, true);

  el('window-hours').listeners.keydown({ key: 'ArrowRight', preventDefault() {} });
  el('window-hours').listeners.keydown({ key: 'ArrowRight', preventDefault() {} });
  assert.equal(cols()[cols().length - 1].attrs['aria-pressed'], 'true', 'у края дальше не уходит');

  el('window-hours').listeners.keydown({ key: 'Enter', preventDefault() { throw new Error('не наша клавиша'); } });
});

test('выбранный час, которого больше нет в ночи, сбрасывается на начало окна', () => {
  const { ctx, el } = page();
  ctx.state.nightHour = Date.parse('2026-01-01T00:00:00Z');
  ctx.renderWindow();
  assert.equal(Number(columns(el).find(c => c.attrs['aria-pressed'] === 'true').attrs['data-time']), win(ctx).from.getTime());
});

test('подписи времени — через шаг, чтобы не налезали друг на друга', () => {
  const { ctx } = page();
  assert.deepEqual([4, 8, 9, 14, 15, 20, 21].map(n => ctx.timeLabelStep(n)), [1, 1, 2, 2, 3, 3, 4]);

  const long = page({ now: '2026-12-15T13:00:00Z' });   // полярная ночь — длинная
  long.ctx.renderWindow();
  const cols = columns(long.el);
  const step = long.ctx.timeLabelStep(cols.length);
  assert.ok(cols.length > 12, 'ночь ' + cols.length + ' ч');
  cols.forEach((col, i) => assert.equal(/ncol__time--hidden/.test(col.children[4].className), i % step !== 0));
});

test('на английском — свои подписи рядов и подробностей', () => {
  const { ctx, el } = page();
  ctx.setLang('en');
  ctx.renderWindow();
  assert.deepEqual(el('window-hours').children[0].children.map(c => c.textContent), ['Chance', 'Clouds', 'Kp', 'Moon']);
  assert.match(el('window-detail').textContent, / · cloud cover 10% · Kp 4\.3 · /);
});

test('полярный день: график и подробности убраны, а не остались от прошлой ночи', () => {
  const { ctx, el } = page();
  ctx.renderWindow();
  assert.ok(columns(el).length > 0);
  const summer = page({ now: '2026-06-21T09:00:00Z' });
  summer.el('window-hours').children = [element(), element()];
  summer.el('window-detail').textContent = 'старое';
  summer.ctx.renderWindow();
  assert.equal(summer.el('window-hours').children.length, 0);
  assert.equal(summer.el('window-detail').textContent, '');
});

test('Луна берётся в середине часа: утром 26 сентября зашла в 03:14 UTC — в часе 03:00–04:00 её уже нет', () => {
  const { ctx } = page();
  const murmansk = ctx.findPoint('murmansk');
  assert.equal(ctx.hourMoon(new Date('2026-09-26T02:00:00Z'), murmansk).up, true);
  assert.equal(ctx.hourMoon(new Date('2026-09-26T03:00:00Z'), murmansk).up, false, 'в 03:00 ещё над горизонтом, но большую часть часа — нет');
});
