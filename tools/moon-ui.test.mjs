// Луна в интерфейсе: тексты, вердикт, окно наблюдения, вкладка «Куда ехать».
// Сам расчёт Луны проверяется в moon.test.mjs; здесь — что с ним делает страница.
// Запуск: node --test tools/moon-ui.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadApp } from './app-sandbox.mjs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');

/** Элемент страницы, запоминающий текст и потомков. */
const element = () => ({
  textContent: '', hidden: false, disabled: false, className: '', style: { setProperty() {} },
  children: [], attrs: {},
  setAttribute(k, v) { this.attrs[k] = String(v); },
  getAttribute(k) { return this.attrs[k] ?? null; },
  addEventListener() {},
  querySelector() { return element(); },
  appendChild(child) { this.children.push(child); return child; },
  set innerHTML(value) { if (value === '') this.children = []; },
  get innerHTML() { return ''; }
});

function page(nowIso) {
  const elements = new Map();
  const getElement = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const ctx = loadApp(
    [['config.js', read('config.js')], ['core.js', read('core.js')], ['push.js', read('push.js')], ['app.js', read('app.js')]],
    { now: Date.parse(nowIso), getElement, createElement: () => element() });
  ctx.state.point = ctx.findPoint('murmansk');
  return { ctx, el: getElement, elements };
}

// Момент, когда Луна полная и над горизонтом в Мурманске (взошла в 14:55, зайдёт в 05:15 по UTC),
// а Солнце глубоко под горизонтом.
const FULL_NIGHT = '2026-09-26T22:00:00Z';
// Новолуние, тоже тёмная ночь.
const NEW_NIGHT = '2026-09-11T22:00:00Z';

const verdictFor = (ctx, kp, cloud) =>
  ctx.computeVerdict({ value: kp, stale: null }, { value: cloud, conflict: false, stale: null });

test('фактор в вердикте: освещённость и положение', () => {
  const { ctx } = page(FULL_NIGHT);
  assert.equal(ctx.moonFactor({ illumination: 0.923, up: true }), 'Луна: 92%, над горизонтом');
  assert.equal(ctx.moonFactor({ illumination: 0.031, up: false }), 'Луна: 3%, под горизонтом');
  assert.equal(ctx.moonFactor({ illumination: 1, up: true }), 'Луна: 100%, над горизонтом');
  assert.equal(ctx.moonFactor({ illumination: 0, up: false }), 'Луна: 0%, под горизонтом');
});

test('пояснение появляется только при заметной и сильной помехе', () => {
  const { ctx } = page(FULL_NIGHT);
  assert.match(ctx.moonHint('strong'), /Яркая Луна.*выцветать.*спиной к Луне/);
  assert.match(ctx.moonHint('moderate'), /заметно подсвечивает/);
  assert.equal(ctx.moonHint('weak'), '');
  assert.equal(ctx.moonHint('none'), '');
  assert.equal(ctx.moonHint(undefined), '');
});

test('строка про Луну в окне наблюдения: всю ночь, зайдёт, взойдёт, нет', () => {
  const { ctx } = page(FULL_NIGHT);
  const at = iso => new Date(iso);
  assert.equal(ctx.moonWindowText({ illumination: 0.5, upShare: 0, rise: null, set: null }), 'Луна 50%, под горизонтом');
  assert.equal(ctx.moonWindowText({ illumination: 0.5, upShare: 1, rise: null, set: null }), 'Луна 50%, над горизонтом');
  // 05:14 по UTC — это 08:14 по Москве, время в интерфейсе московское
  assert.equal(ctx.moonWindowText({ illumination: 1, upShare: 0.8, rise: null, set: at('2026-09-27T05:14:00Z') }), 'Луна 100%, зайдёт в 08:14');
  assert.equal(ctx.moonWindowText({ illumination: 0.2, upShare: 0.4, rise: at('2026-09-27T01:00:00Z'), set: null }), 'Луна 20%, взойдёт в 04:00');
  // и восход, и заход внутри окна: называется интервал целиком, а не одно из событий
  assert.equal(ctx.moonWindowText({ illumination: 0.6, upShare: 0.5, rise: at('2026-09-27T01:00:00Z'), set: at('2026-09-27T02:00:00Z') }), 'Луна 60%, над горизонтом 04:00–05:00');
  assert.equal(ctx.moonWindowText({ illumination: 0.6, upShare: 0.5, rise: at('2026-09-27T02:00:00Z'), set: at('2026-09-27T01:00:00Z') }), 'Луна 60%, зайдёт в 04:00, взойдёт в 05:00');
});

test('живой случай: 22 сентября вечером Луна и всходит, и заходит в окне — по эталону USNO 16:51 и 20:57', () => {
  const { ctx } = page(FULL_NIGHT);
  const p = ctx.findPoint('murmansk');
  const text = ctx.moonWindowText(ctx.moonSummary(new Date('2026-09-22T16:00:00Z'), new Date('2026-09-22T23:00:00Z'), p.lat, p.lon));
  // 16:50 и 20:57 по UTC — это 19:50 и 23:57 по Москве
  assert.equal(text, 'Луна 85%, над горизонтом 19:50–23:57');
});

test('вердикт при полной Луне: фактор и пояснение, когда небо стоит смотреть', () => {
  const { ctx } = page(FULL_NIGHT);
  const v = verdictFor(ctx, 4.3, 10);
  assert.equal(v.level, 'high');
  assert.ok(v.factors.includes('Луна: 100%, над горизонтом'), v.factors.join(' | '));
  assert.match(v.hint, /Яркая Луна над горизонтом/);
  // порядок факторов: первые три остаются теми, что попадают в уведомление
  assert.match(v.factors[0], /^Kp /);
  assert.match(v.factors[1], /^Облачность /);
  assert.equal(v.factors[2], 'Тёмное небо');
});

test('вердикт при новолунии: фактор есть, лишних слов нет', () => {
  const { ctx } = page(NEW_NIGHT);
  const v = verdictFor(ctx, 4.3, 10);
  assert.equal(v.level, 'high');
  assert.ok(v.factors.some(f => /^Луна: [01]%, под горизонтом$/.test(f)), v.factors.join(" | "));
  assert.doesNotMatch(v.hint, /Луна/);
});

test('Луна не меняет уровень вердикта: то же Kp и облачность дают одно и то же при полной Луне и при новолунии', () => {
  const full = page(FULL_NIGHT).ctx, fresh = page(NEW_NIGHT).ctx;
  for (const kp of [0.3, 1.7, 2.7, 4.3, 7]) {
    for (const cloud of [5, 30, 60, 90]) {
      assert.equal(verdictFor(full, kp, cloud).level, verdictFor(fresh, kp, cloud).level, `Kp ${kp}, облачность ${cloud}`);
    }
  }
});

test('при низком уровне пояснение про Луну не добавляется (смотреть всё равно нечего)', () => {
  const { ctx } = page(FULL_NIGHT);
  const v = verdictFor(ctx, 0.3, 95);
  assert.equal(v.level, 'low');
  assert.doesNotMatch(v.hint, /Яркая Луна/);
  assert.ok(v.factors.some(f => /^Луна:/.test(f)), 'но фактор показан');
});

test('днём (полярный день) Луна не мешает пояснением: сияния всё равно не видно', () => {
  const { ctx } = page('2026-06-21T09:00:00Z');
  const v = verdictFor(ctx, 4.3, 10);
  assert.equal(v.level, 'low');
  assert.doesNotMatch(v.hint, /Яркая Луна|заметно подсвечивает/);
});

test('окно наблюдения: строка про Луну попадает в подсказку карточки', () => {
  const { ctx, el } = page(FULL_NIGHT);
  const start = Date.parse(FULL_NIGHT);
  const hours = [];
  for (let h = 0; h < 30; h++) {
    hours.push({ time: new Date(start + h * 3600000).toISOString().slice(0, 16), cloud: 10 });
  }
  ctx.state.cloud = { hours, conflict: false, stale: null };
  ctx.state.forecast = [
    { time: new Date(start - 3 * 3600000), value: 4.3, current: true },
    { time: new Date(start + 6 * 3600000), value: 4.3, current: false }
  ];
  ctx.state.kp = { value: 4.3, stale: null };

  ctx.renderWindow();
  const hint = el('window-hint').textContent;
  assert.match(hint, /Луна \d+%/, hint);
  assert.match(hint, /(зайдёт в \d\d:\d\d|над горизонтом|под горизонтом)/, hint);
});

test('вкладка «Куда ехать»: чип про Луну среди факторов лучшей точки', () => {
  const { ctx, elements } = page(FULL_NIGHT);
  const point = ctx.findPoint('teriberka');
  const from = new Date('2026-09-26T21:00:00Z'), to = new Date('2026-09-27T00:00:00Z');

  ctx.renderBest([{ point, window: { polarDay: false, level: 2, from, to, cloudMin: 10, cloudMax: 20, kpMax: 4.3, fullDark: true, point } }]);

  const chips = elements.get('best-factors').children.map(c => c.textContent);
  assert.ok(chips.some(c => /^Луна \d+%/.test(c)), 'чипы: ' + chips.join(' | '));
  assert.ok(chips.some(c => /^Засветка:/.test(c)), 'прежние чипы на месте');
});
