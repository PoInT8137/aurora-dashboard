// Три ближайшие ночи по тем же правилам, что и ближайшая: разбиение на ночи, Kp только из
// прогноза (за его концом неизвестен), лучшая ночь, «ближайшая ночь с шансом».
// Запуск: node --test tools/nights.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadApp } from './app-sandbox.mjs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const NOW = Date.parse('2026-10-25T12:00:00Z');   // 15:00 МСК, светло
const H = 3600000;

function page() {
  const elements = new Map();
  const element = () => ({ textContent: '', className: '', hidden: false, children: [], attrs: {}, style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, querySelector: () => null,
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; },
    appendChild(c) { this.children.push(c); return c; },
    set innerHTML(v) { this.children = []; }, get innerHTML() { return ''; } });
  const el = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const ctx = loadApp([['config.js', read('config.js')], ['core.js', read('core.js')], ['push.js', read('push.js')], ['app.js', read('app.js')]],
    { now: NOW, getElement: el, createElement: () => element() });
  return { ctx, el };
}

/** Почасовая облачность на 4 суток вперёд: cloudFn(часы от NOW) → %. */
function hours(cloudFn, count = 96) {
  const out = [];
  for (let h = 0; h < count; h++) out.push({ time: new Date(NOW + h * H).toISOString().slice(0, 16), cloud: cloudFn(h) });
  return out;
}

/** Прогноз Kp трёхчасовками на days суток от начала дня NOW. */
function kpRows(value, days = 3) {
  const start = Date.parse('2026-10-25T00:00:00Z');
  const rows = [];
  for (let i = 0; i < days * 8; i++) rows.push({ time: new Date(start + i * 3 * H), value: typeof value === 'function' ? value(i) : value });
  return rows;
}

test('Kp за концом прогноза неизвестен: последнее значение вперёд не тянется', () => {
  const { ctx } = page();
  const rows = kpRows(4, 1);
  assert.equal(ctx.kpAt(new Date(Date.parse('2026-10-25T22:00:00Z')), rows, null), 4);
  assert.equal(ctx.kpAt(new Date(Date.parse('2026-10-26T01:00:00Z')), rows, null), null);
  assert.equal(ctx.kpAt(new Date(Date.parse('2026-10-26T01:00:00Z')), rows, 2), 2, 'запасное значение работает как раньше');
});

test('три ночи подряд: у каждой свои часы, Kp текущий только в первой', () => {
  const { ctx } = page();
  const point = ctx.findPoint('murmansk');
  const nights = ctx.computeNights({ hours: hours(() => 10), conflict: false }, kpRows(3), 0.5, point);
  assert.equal(nights.length, 3);
  assert.deepEqual([...nights.map(n => n.index)], [0, 1, 2]);
  for (let i = 1; i < 3; i++) assert.ok(nights[i].start - nights[i - 1].start > 18 * H, 'ночи разные');
  assert.equal(nights[0].window.level, 2, 'чистое небо и Kp 3: высокий');
  assert.equal(nights[2].window.noKp, false);

  // прогноза Kp на третью ночь нет: судим только по облакам, текущий Kp туда не подставляем
  const short = ctx.computeNights({ hours: hours(() => 10), conflict: false }, kpRows(3, 2), 0.5, point);
  assert.equal(short[2].window.noKp, true);
  assert.equal(short[2].window.kpMax, null);
});

test('ближайшая ночь совпадает с прежним расчётом окна', () => {
  const { ctx } = page();
  const point = ctx.findPoint('murmansk');
  const cloud = { hours: hours(h => (h % 7) * 12), conflict: false };
  const one = ctx.computeNightWindow(cloud, kpRows(2.3), 1, point);
  const first = ctx.computeNights(cloud, kpRows(2.3), 1, point)[0].window;
  assert.equal(first.from.getTime(), one.from.getTime());
  assert.equal(first.to.getTime(), one.to.getTime());
  assert.equal(first.level, one.level);
});

function withNights(ctx, cloudByNight, kp = 3, count = 96) {
  ctx.state.forecast = kpRows(kp);
  ctx.state.kp = { value: 0.3 };
  ctx.state.tonight = {
    stale: null,
    rows: ctx.allPoints().map(p => ({ id: p.id, hours: hours(h => cloudByNight(Math.floor(h / 24), p.id), count) }))
  };
}

test('лучшая ночь: наибольший шанс, при равенстве более ранняя; сегодня некуда, значит, говорим, когда', () => {
  const { ctx, el } = page();
  // первая ночь затянута везде, вторая ясная в Териберке, третья ясная везде
  withNights(ctx, (night, id) => night === 0 ? 100 : night === 1 ? (id === 'teriberka' ? 5 : 100) : 5);
  const nights = ctx.computeAllNights();
  assert.equal(nights.length, 3);
  const best = ctx.bestNight(nights);
  assert.equal(best.night.index, 1, 'при равном шансе берём более раннюю ночь');
  assert.equal(best.top.point.id, 'teriberka');

  ctx.renderNights();
  assert.match(el('nights-value').textContent, /^\S+ \d+ \S+, \d\d:\d\d–\d\d:\d\d$/);
  assert.match(el('nights-why').textContent, /^Териберка: высокий шанс, облачность 5%, Kp до 3,0\.$/);
  assert.equal(el('nights-list').children.length, 3);
  assert.equal(el('nights-list').children[0].children[0].textContent, 'Эта ночь');
  assert.equal(el('nights-list').children[0].children[1].textContent, 'низкий шанс во всех точках');

  assert.match(ctx.nextNightText(), /^Ближайшая ночь с шансом: \S+ \d+ \S+, \d\d:\d\d–\d\d:\d\d, Териберка\.$/);
});

test('три ночи без шанса — честно: низкий везде; облака при активности названы; данных мало — прогноза дальше нет', () => {
  const { ctx, el } = page();
  withNights(ctx, () => 100, 0.3);   // поле спокойное
  ctx.renderNights();
  assert.equal(el('nights-value').textContent, 'Шанс низкий');
  assert.equal(el('nights-why').textContent, 'В ближайшие три ночи шанс низкий во всех точках.');
  assert.equal(ctx.nextNightText(), 'В ближайшие три ночи шанс низкий во всех точках.');

  withNights(ctx, () => 100, 4);     // 25.10.2026: Kp до 4, а везде сплошные облака
  ctx.renderNights();
  assert.equal(el('nights-why').textContent,
    'Активность будет (Kp до 4,0), но все ближайшие ночи во всех точках сплошная облачность. Облака иногда расходятся неожиданно: следите за прогнозом.');

  // данные кончаются в полночь третьей ночи (60 часов от полудня)
  withNights(ctx, () => 100, 0.3, 60);
  ctx.renderNights();
  assert.equal(el('nights-why').textContent, 'В ближайшие ночи шанс низкий во всех точках. Дальше прогноза пока нет.');
  assert.match(el('nights-list').children[2].children[1].textContent, /данные кончаются посреди ночи/);

  ctx.state.tonight = null;
  assert.equal(ctx.computeAllNights(), null);
  assert.equal(ctx.nextNightText(), 'Прогноза на следующие ночи пока нет.');
});

test('разметка и тексты: блок на главной, предупреждение о надёжности облачности, три языка без длинных тире', () => {
  const html = read('index.html');
  const now = html.slice(html.indexOf('id="tab-now"'), html.indexOf('id="tab-tonight"'));
  assert.ok(now.includes('id="nights-card"'));
  assert.match(read('js/base.js'), /&forecast_days=4&timezone=UTC/);
  const keys = ['nights.title', 'nights.note', 'nights.error', 'nights.first', 'nights.value', 'nights.why', 'nights.none',
    'nights.none_short', 'nights.no_kp', 'best.next', 'best.next_none', 'best.next_unknown'];
  for (const lang of ['ru', 'en', 'zh']) {
    const dict = read('lang/' + lang + '.js');
    for (const key of keys) {
      const line = dict.split('\n').find(l => l.startsWith(`  '${key}':`));
      assert.ok(line, lang + ' ' + key);
      assert.doesNotMatch(line, /—/, lang + ' ' + key);
    }
  }
});
