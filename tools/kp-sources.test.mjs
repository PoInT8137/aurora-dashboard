// Два разных Kp на странице: в карточке минутная оценка NOAA, в прогнозе и ночном графике
// значение за трёхчасовку с пометкой NOAA (измерено, оценка, прогноз). Когда числа заметно
// расходятся, под прогнозом есть строка, которая это объясняет.
// Запуск: node --test tools/kp-sources.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadApp } from './app-sandbox.mjs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const NOW = Date.parse('2026-10-24T23:10:00Z');

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

// Так выглядит ответ NOAA 24.10.2026 около 23:10 UTC
const NOAA = [
  { time_tag: '2026-10-24T18:00:00', kp: 1.67, observed: 'observed' },
  { time_tag: '2026-10-24T21:00:00', kp: 1.33, observed: 'estimated' },
  { time_tag: '2026-10-25T00:00:00', kp: 2, observed: 'predicted' }
];

test('прогноз помнит пометку NOAA у каждой трёхчасовки', () => {
  const { ctx } = page();
  const rows = ctx.buildForecastRows(NOAA);
  assert.deepEqual(JSON.parse(JSON.stringify(rows.map(r => [r.status, r.current]))), [['estimated', true], ['predicted', false]]);
  assert.equal(ctx.buildForecastRows([{ time_tag: '2026-10-24T21:00:00', kp: 1, observed: 'чепуха' }])[0].status, null);
});

test('минутная 0,3 против трёхчасовой 1,3: под прогнозом объяснение; разница меньше 0,5 — строки нет', () => {
  const { ctx, el } = page();
  ctx.state.forecast = ctx.buildForecastRows(NOAA);
  ctx.state.kp = { value: 0.33, time: new Date(NOW), stale: null };
  ctx.renderKpNote();
  assert.equal(el('forecast-kp-note').hidden, false);
  assert.equal(el('forecast-kp-note').textContent,
    'Сейчас за трёхчасовку Kp 1,3 (оценка NOAA). В карточке Kp 0,3: это оценка за последнюю минуту, поэтому числа отличаются.');

  ctx.state.kp.value = 1.0;
  ctx.renderKpNote();
  assert.equal(el('forecast-kp-note').hidden, true);

  ctx.state.kp = { value: 0.33, stale: 3600000 };   // сохранённое значение: сравнивать нечестно
  ctx.renderKpNote();
  assert.equal(el('forecast-kp-note').hidden, true);
});

test('подписи: карточка Kp называет число минутной оценкой; тексты на трёх языках без длинных тире', () => {
  for (const lang of ['ru', 'en', 'zh']) {
    const dict = read('lang/' + lang + '.js');
    for (const key of ['kp.measured', 'forecast.kp_note', 'forecast.status.observed', 'forecast.status.estimated', 'forecast.status.predicted', 'hour.kp3']) {
      const line = dict.split('\n').find(l => l.startsWith(`  '${key}':`));
      assert.ok(line, lang + ' ' + key);
      assert.doesNotMatch(line, /—/, lang + ' ' + key);
    }
  }
  assert.match(read('lang/ru.js'), /'kp\.measured': 'Минутная оценка NOAA в \{time\}/);
  assert.match(read('index.html'), /<p class="card__meta" id="forecast-kp-note" hidden><\/p>/);
});
