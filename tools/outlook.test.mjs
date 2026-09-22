// Прогноз NOAA на 27 дней: разбор таблицы, дни для точки, лучшие даты, карточка «Когда ехать».
// Запуск: node --test tools/outlook.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadApp } from './app-sandbox.mjs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const core = loadApp([['core.js', read('core.js')]], {}).AuroraCore;
const plain = v => JSON.parse(JSON.stringify(v));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Таблица в формате text/27-day-outlook.txt; kps — наибольший Kp по дням начиная с first. */
function table(first, kps, issued = first) {
  const d0 = new Date(first + 'T00:00:00Z');
  const fmt = d => `${d.getUTCFullYear()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, '0')}`;
  const lines = [
    ':Product: 27-day Space Weather Outlook Table 27DO.txt',
    `:Issued: ${fmt(new Date(issued + 'T00:00:00Z'))} 0317 UTC`,
    '# Prepared by the US Dept. of Commerce, NOAA, Space Weather Prediction Center',
    '#   UTC      Radio Flux   Planetary   Largest',
    '#  Date       10.7 cm      A Index    Kp Index'
  ];
  kps.forEach((kp, i) => {
    const d = new Date(d0.getTime() + i * 86400000);
    lines.push(`${fmt(d)}     105           ${kp * 4}          ${kp}`);
  });
  return lines.join('\n') + '\n';
}

test('разбор настоящего формата: дата выпуска, дни, поток, индекс A, наибольший Kp', () => {
  const text = `:Product: 27-day Space Weather Outlook Table 27DO.txt
:Issued: 2026 Sep 21 0317 UTC
# Prepared by the US Dept. of Commerce, NOAA, Space Weather Prediction Center
#   UTC      Radio Flux   Planetary   Largest
#  Date       10.7 cm      A Index    Kp Index
2026 Sep 21     105           5          2
2026 Sep 24     100          20          4
2026 Oct 01     115           5          2
`;
  const o = core.parseOutlook27(text);
  assert.equal(o.issued.toISOString(), '2026-09-21T03:17:00.000Z');
  assert.deepEqual(plain(o.days), [
    { date: '2026-09-21', flux: 105, a: 5, kp: 2 },
    { date: '2026-09-24', flux: 100, a: 20, kp: 4 },
    { date: '2026-10-01', flux: 115, a: 5, kp: 2 }
  ]);
});

test('разбор: мусор и чужие строки пропускаются, без строк данных — null', () => {
  assert.equal(core.parseOutlook27(''), null);
  assert.equal(core.parseOutlook27(null), null);
  assert.equal(core.parseOutlook27('<html>404 Not Found</html>'), null);
  const o = core.parseOutlook27('2026 Foo 01  100  5  2\n2026 Oct 02  100  5  12\n2026 Oct 03  100  5  3\n');
  assert.deepEqual(plain(o.days).map(d => d.date), ['2026-10-03'], 'неизвестный месяц и Kp > 9 отброшены');
  assert.equal(o.issued, null);
});

const murmansk = core.POINTS.find(p => p.id === 'murmansk');
const kandalaksha = core.POINTS.find(p => p.id === 'kandalaksha');

test('дни с сегодняшнего по UTC; уровень — по порогам точки', () => {
  const o = core.parseOutlook27(table('2026-10-01', [2, 3, 4, 2, 3]));
  const now = Date.parse('2026-10-02T10:00:00Z');
  const m = core.outlookDays(o, murmansk, now);
  assert.deepEqual(plain(m.map(d => d.date)), ['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']);
  assert.deepEqual(plain(m.map(d => d.level)), ['high', 'high', 'mid', 'high'], 'Мурманск: высокий от Kp 3');
  const k = core.outlookDays(o, kandalaksha, now);
  assert.deepEqual(plain(k.map(d => d.level)), ['mid', 'high', 'low', 'mid'], 'Кандалакша южнее: высокий от Kp 3,8');
});

test('тёмная ночь и Луна — в местную полночь: полярный день летом, полнолуние отмечено', () => {
  const summer = core.outlookDays(core.parseOutlook27(table('2026-06-20', [4, 4])), murmansk, Date.parse('2026-06-20T00:00:00Z'));
  assert.ok(summer.every(d => !d.dark), 'в июне ночи светлые');
  const autumn = core.outlookDays(core.parseOutlook27(table('2026-10-10', [4])), murmansk, Date.parse('2026-10-10T00:00:00Z'));
  assert.equal(autumn[0].dark, true);
  // 26 сентября 2026 — полнолуние (эталон USNO в moon.test.mjs)
  const full = core.outlookDays(core.parseOutlook27(table('2026-09-26', [3])), murmansk, Date.parse('2026-09-26T00:00:00Z'));
  assert.ok(full[0].moon > 0.95);
  assert.equal(full[0].moonOk, false, 'Kp 3 при полной Луне — помеха');
});

test('лучшие даты: подряд идущие высокие тёмные дни без яркой Луны, сильнейшие отрезки, по порядку дат', () => {
  const day = (date, kp, extra = {}) => ({ date, kp, level: kp >= 3 ? 'high' : 'mid', dark: true, moon: 0.2, moonOk: true, ...extra });
  const days = [
    day('2026-10-01', 3), day('2026-10-02', 3), day('2026-10-03', 2),
    day('2026-10-04', 4), day('2026-10-05', 5, { moon: 0.99, moonOk: true }),
    day('2026-10-06', 3, { moon: 0.9, moonOk: false }),
    day('2026-10-07', 3, { dark: false }),
    day('2026-10-08', 3), day('2026-10-10', 4)
  ];
  const all = plain(core.outlookBestRanges(days, 10));
  assert.deepEqual(all, [
    { from: '2026-10-01', to: '2026-10-02', kp: 3 },
    { from: '2026-10-04', to: '2026-10-05', kp: 5 },
    { from: '2026-10-08', to: '2026-10-08', kp: 3 },
    { from: '2026-10-10', to: '2026-10-10', kp: 4 }
  ]);
  assert.deepEqual(plain(core.outlookBestRanges(days, 2)), [
    { from: '2026-10-04', to: '2026-10-05', kp: 5 },
    { from: '2026-10-10', to: '2026-10-10', kp: 4 }
  ], 'из четырёх — два сильнейших, но по порядку дат');
  assert.deepEqual(plain(core.outlookBestRanges([], 3)), []);
});

test('сильная буря видна и при полной Луне: на 2 выше порога «высокого» Луна не исключает день', () => {
  const o = core.parseOutlook27(table('2026-09-26', [4, 5]));
  const days = core.outlookDays(o, murmansk, Date.parse('2026-09-26T00:00:00Z'));
  assert.deepEqual(plain(days.map(d => d.moonOk)), [false, true]);
  assert.deepEqual(plain(core.outlookBestRanges(days, 3)), [{ from: '2026-09-27', to: '2026-09-27', kp: 5 }]);
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

const NOW = Date.parse('2026-10-01T09:00:00Z');
const HOUR = 3600000;

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

const text = body => () => Promise.resolve(new Response(body, { status: 200 }));
const offline = () => Promise.reject(new TypeError('Failed to fetch'));
// с 1 октября: две сильные ночи 4–5, потом тихо
const OCT = table('2026-10-01', [2, 2, 2, 4, 4, 2, 2], '2026-09-28');

test('карточка: по дню на ячейку, лучшие даты для точки, дата выпуска', async () => {
  const { ctx, el } = page(text(OCT));
  await ctx.loadOutlook(false);
  const cells = el('outlook-grid').children;
  assert.equal(cells.length, 7);
  assert.equal(cells[3].children[0].textContent, 'вс 4 окт.');
  assert.equal(cells[3].children[1].textContent, 'Kp 4');
  assert.equal(el('outlook-best').textContent, 'Лучшие даты для точки «Мурманск»: 4 октября — 5 октября.');
  assert.equal(el('outlook-meta').textContent, 'NOAA SWPC, выпуск от 28 сентября');
  assert.equal(el('outlook-card').attrs['data-state'], 'ok');
});

test('карточка на английском и китайском; смена точки пересчитывает без запроса', async () => {
  const { ctx, el, calls } = page(text(OCT));
  ctx.setLang('en');
  await ctx.loadOutlook(false);
  assert.equal(el('outlook-best').textContent, 'Best dates for “Murmansk”: 4 October – 5 October.');
  ctx.setLang('zh');
  ctx.state.point = ctx.findPoint('kandalaksha');
  ctx.renderOutlook();
  assert.equal(el('outlook-best').textContent, '“坎达拉克沙”的最佳日期：10月4日至10月5日。');
  assert.equal(calls.length, 1);
});

test('светлые ночи и яркая Луна подписаны в ячейке', async () => {
  const summer = page(text(table('2026-06-20', [4, 4])), { now: Date.parse('2026-06-20T09:00:00Z') });
  await summer.ctx.loadOutlook(false);
  assert.equal(summer.el('outlook-grid').children[0].children[2].textContent, 'светлая ночь');
  assert.match(summer.el('outlook-grid').children[0].className, /oday--light/);
  assert.equal(summer.el('outlook-best').textContent, 'Ближайшие 4 недели ночи светлые — сияние не увидеть при любой активности.');

  const full = page(text(table('2026-09-26', [2])), { now: Date.parse('2026-09-26T09:00:00Z') });
  await full.ctx.loadOutlook(false);
  assert.match(full.el('outlook-grid').children[0].children[2].textContent, /^Луна (9\d|100)%$/);
  assert.match(full.el('outlook-best').textContent, /^В ближайшие 4 недели NOAA не ждёт/);
});

test('таблица выходит раз в неделю: сохранённому меньше 6 часов — сеть не трогаем; «Повторить» — всегда', async () => {
  const clock = { now: NOW };
  const { ctx, calls } = page(text(OCT), clock);
  await ctx.loadOutlook(false);
  clock.now = NOW + 5 * HOUR;
  await ctx.loadOutlook(false);
  assert.equal(calls.length, 1);
  await ctx.loadOutlook(true);
  assert.equal(calls.length, 2);
  clock.now = NOW + 12 * HOUR;
  await ctx.loadOutlook(false);
  assert.equal(calls.length, 3);
});

test('одновременные открытия вкладки не дублируют запрос', async () => {
  const { ctx, calls } = page(text(OCT));
  await Promise.all([ctx.loadOutlook(true), ctx.loadOutlook(true)]);
  assert.equal(calls.length, 1);
});

test('нет связи: сохранённое держится до 8 дней с пометкой возраста; без него — ошибка с причиной', async () => {
  const clock = { now: NOW };
  const first = page(text(OCT), clock);
  await first.ctx.loadOutlook(false);
  const saved = first.ctx.localStorage.getItem('aurora.outlook');

  clock.now = NOW + 2 * 24 * HOUR;
  const second = page(offline, clock);
  second.ctx.localStorage.setItem('aurora.outlook', saved);
  assert.ok(await second.ctx.loadOutlook(false));
  assert.equal(second.el('outlook-card').attrs['data-state'], 'stale');

  clock.now = NOW + 9 * 24 * HOUR;
  const third = page(offline, clock);
  third.ctx.localStorage.setItem('aurora.outlook', saved);
  assert.equal(await third.ctx.loadOutlook(false), null, 'старше 8 дней — уже не годится');

  const broken = page(text('<html>oops</html>'));
  assert.equal(await broken.ctx.loadOutlook(false), null);
  assert.equal(broken.el('outlook-error').textContent, 'Прогноз на 27 дней недоступен: не удалось разобрать таблицу NOAA.');
});

test('все дни сохранённого прогноза уже в прошлом — честное сообщение вместо пустой карточки', async () => {
  const clock = { now: NOW };
  const first = page(text(OCT), clock);
  await first.ctx.loadOutlook(false);
  clock.now = NOW + 7 * 24 * HOUR + HOUR;
  first.ctx.renderOutlook();
  assert.equal(first.el('outlook-card').attrs['data-state'], 'error');
  assert.equal(first.el('outlook-error').textContent, 'Сохранённый прогноз уже в прошлом — нужен свежий.');
});

test('карточка — на вкладке «Куда ехать», запрос — при её открытии, кнопка «Повторить» подключена', () => {
  const html = read('index.html');
  const tonight = html.slice(html.indexOf('id="tab-tonight"'), html.indexOf('id="tab-settings"'));
  assert.ok(tonight.includes('id="outlook-card"'));
  const app = read('app.js');
  assert.match(app, /if \(id === 'tonight'\) loadOutlook\(false\);/);
  assert.match(app, /if \(what === 'outlook'\)\s+loadOutlook\(true\);/);
});
