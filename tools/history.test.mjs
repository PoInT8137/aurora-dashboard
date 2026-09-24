// «Прошлые ночи»: разбор измеренного Kp, выделение ночей, оценка по правилам окна наблюдения,
// загрузка, кэш и отображение. Запуск: node --test tools/history.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadApp } from './app-sandbox.mjs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const HOUR = 3600000;
// 24 сентября 2026, 12:00 UTC: в Мурманске день, позади три полные ночи данных
const NOW = Date.parse('2026-09-24T12:00:00Z');
const START = Date.parse('2026-09-21T00:00:00Z');   // данные начинаются ночью — эта ночь обрезана

const element = () => ({
  textContent: '', hidden: false, className: '',
  style: { props: {}, setProperty(k, v) { this.props[k] = v; } },
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

const json = body => new Response(JSON.stringify(body), { status: 200 });

/** Облачность по часам: cloudAt(ms) → %. */
const cloudResponse = cloudAt => {
  const time = [], low = [], mid = [], high = [], total = [];
  for (let t = START; t < START + 4 * 24 * HOUR; t += HOUR) {
    const c = cloudAt(t);
    time.push(new Date(t).toISOString().slice(0, 16));
    low.push(c); mid.push(0); high.push(0); total.push(c);
  }
  return { hourly: { time, cloud_cover: total, cloud_cover_low: low, cloud_cover_mid: mid, cloud_cover_high: high } };
};
/** Измеренный Kp NOAA: трёхчасовки, kpAt(ms) → значение. */
const kpResponse = kpAt => {
  const rows = [];
  for (let t = START - 3 * 3 * HOUR; t < NOW; t += 3 * HOUR) rows.push({ time_tag: new Date(t).toISOString().slice(0, 19), Kp: kpAt(t), a_running: 5, station_count: 8 });
  return rows;
};

function page({ now = NOW, cloudAt = () => 10, kpAt = () => 1, fail = false } = {}) {
  const elements = new Map();
  const getElement = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const calls = [];
  const fetch = async url => {
    calls.push(String(url));
    if (fail) throw new TypeError('Failed to fetch');
    if (String(url).includes('noaa-planetary-k-index.json')) return json(kpResponse(kpAt));
    if (String(url).includes('past_days=7')) return json(cloudResponse(cloudAt));
    return new Promise(() => {});
  };
  const ctx = loadApp([['config.js', read('config.js')], ['core.js', read('core.js')], ['push.js', read('push.js')], ['app.js', read('app.js')]],
    { now, getElement, createElement: () => element(), fetch });
  ctx.state.point = ctx.findPoint('murmansk');
  return { ctx, el: getElement, calls };
}

test('измеренный Kp NOAA: объекты с Kp и временем, по возрастанию', () => {
  const { ctx } = page();
  const rows = ctx.readKpHistory([{ time_tag: '2026-09-17T03:00:00', Kp: 1.67 }, { time_tag: '2026-09-17T00:00:00', Kp: 3 }, { time_tag: 'мусор', Kp: 2 }]);
  assert.deepEqual(rows.map(r => [r.time.toISOString(), r.value]), [['2026-09-17T00:00:00.000Z', 3], ['2026-09-17T03:00:00.000Z', 1.67]]);
});

test('ночи: только завершившиеся и целиком попавшие в данные, новые сверху', () => {
  const { ctx } = page();
  const hours = ctx.readHourlyCloud(cloudResponse(() => 10));
  const kp = ctx.readKpHistory(kpResponse(() => 1));
  const nights = ctx.computePastNights(hours, kp, ctx.findPoint('murmansk'), NOW);
  // 21.09 00:00 UTC — середина ночи: обрезана. Полные — вечера 21, 22 и 23 сентября.
  assert.equal(nights.length, 3);
  assert.ok(nights[0].from > nights[1].from, 'новые сверху');
  for (const n of nights) {
    assert.ok(n.to.getTime() <= NOW);
    assert.ok(n.to - n.from >= 8 * HOUR && n.to - n.from <= 14 * HOUR, 'осенняя ночь: ' + (n.to - n.from) / HOUR + ' ч');
  }

  // сейчас — середина ночи: идущая ночь не прошлое
  const midnight = ctx.computePastNights(hours, kp, ctx.findPoint('murmansk'), Date.parse('2026-09-23T23:00:00Z'));
  assert.equal(midnight.length, 2);
});

test('оценка — по правилам окна наблюдения: Kp и облака по часам; лучший уровень и его часы', () => {
  const { ctx } = page();
  const night22 = t => t >= Date.parse('2026-09-22T18:00:00Z') && t < Date.parse('2026-09-23T06:00:00Z');
  // 22-го: Kp 4 и ясно с полуночи до 02:00 UTC; в остальные ночи — Kp 1 и сплошные облака
  const clear = t => t >= Date.parse('2026-09-23T00:00:00Z') && t < Date.parse('2026-09-23T03:00:00Z');
  const hours = ctx.readHourlyCloud(cloudResponse(t => (clear(t) ? 5 : 95)));
  const kp = ctx.readKpHistory(kpResponse(t => (night22(t) ? 4 : 1)));
  const [n23, n22, n21] = ctx.computePastNights(hours, kp, ctx.findPoint('murmansk'), NOW);
  assert.equal(n22.level, 2, 'высокий');
  assert.equal(n22.bestHours, 2, 'в 02:00 UTC уже сумерки — высокий не ставится, как в окне наблюдения');
  assert.equal(n22.bestFrom.toISOString(), '2026-09-23T00:00:00.000Z');
  assert.equal(n22.kpMax, 4);
  assert.equal(n22.cloudMin, 5);
  assert.equal(n23.level, 0);
  assert.equal(n21.level, 0);
});

test('белые ночи: темноты не было — ни одной ночи и честная подпись', async () => {
  const { ctx, el } = page({ now: Date.parse('2026-06-24T12:00:00Z') });
  ctx.state.history = { pointId: 'murmansk', hours: ctx.readHourlyCloud(cloudResponse(() => 10)).map(h => ({ ...h, time: h.time.replace('2026-09', '2026-06') })), kp: [], loadedAt: Date.now(), stale: null };
  ctx.renderHistory();
  assert.equal(el('history-summary').textContent, 'Белые ночи: за последние дни здесь не было темноты — сияние не разглядеть.');
  assert.equal(el('history-list').children.length, 0);
});

test('загрузка: два запроса (Kp NOAA и облака за 7 суток той же моделью), строки с оценкой, итог по-русски', async () => {
  const clear = t => t >= Date.parse('2026-09-23T00:00:00Z') && t < Date.parse('2026-09-23T03:00:00Z');
  const { ctx, el, calls } = page({ cloudAt: t => (clear(t) ? 5 : 95), kpAt: () => 3 });
  await ctx.loadHistory(false);
  assert.equal(calls.length, 2);
  const cloudUrl = new URL(calls.find(u => u.includes('open-meteo')));
  assert.equal(cloudUrl.searchParams.get('models'), ctx.CONFIG.weatherModel);
  assert.equal(cloudUrl.searchParams.get('past_days'), '7');

  assert.equal(el('history-title-point').textContent, 'Мурманск');
  assert.equal(el('history-summary').textContent, 'Из последних 3 ночей шанс был хотя бы средним в 1 ночь.');
  const rows = el('history-list').children;
  assert.equal(rows.length, 3);
  assert.equal(rows[1].children[1].textContent, 'Высокий шанс');
  assert.match(rows[1].children[2].textContent, /^Kp до 3,0 · облачность от 5% · лучше всего с 03:00, 2 часа$/);
  assert.equal(rows[1].style.props['--tone'], 'var(--ok)');
  assert.equal(el('history-card').attrs['data-state'], 'ok');
  assert.ok(ctx.localStorage.getItem('aurora.history-murmansk'), 'в кэше');

  await ctx.loadHistory(false);
  assert.equal(calls.length, 2, 'не чаще раза в час');
});

test('нет сети: с кэшем — показываем сохранённое с пометкой; без кэша — ошибка с «Повторить»', async () => {
  const ok = page();
  await ok.ctx.loadHistory(false);
  const saved = ok.ctx.localStorage.getItem('aurora.history-murmansk');

  const offline = page({ fail: true });
  offline.ctx.localStorage.setItem('aurora.history-murmansk', JSON.stringify({ ...JSON.parse(saved), savedAt: NOW - 30 * 60000 }));
  await offline.ctx.loadHistory(false);
  assert.equal(offline.el('history-list').children.length, 3);
  assert.equal(offline.el('history-card').attrs['data-state'], 'stale');

  const none = page({ fail: true });
  await none.ctx.loadHistory(false);
  assert.equal(none.el('history-card').attrs['data-state'], 'error');
  assert.match(read('app.js'), /if \(what === 'history'\)\s+loadHistory\(true\);/);
});

test('данные — своей точки: сменили точку — старые строки не показываются, грузятся новые', async () => {
  const { ctx, el, calls } = page();
  await ctx.loadHistory(false);
  ctx.state.point = ctx.findPoint('teriberka');
  ctx.renderHistory();
  assert.equal(el('history-title-point').textContent, 'Мурманск', 'чужие данные не перерисовываются как свои');
  await ctx.loadHistory(false);
  assert.equal(calls.length, 4);
  assert.equal(el('history-title-point').textContent, 'Териберка');
  assert.match(read('js/page.js'), /if \(state\.tab === 'tonight'\) loadHistory\(false\);/);
});

test('разметка: карточка на вкладке «Куда ехать», файл в оболочке', () => {
  const html = read('index.html');
  const tonight = html.slice(html.indexOf('id="tab-tonight"'), html.indexOf('id="tab-map"'));
  assert.match(tonight, /id="history-card"/);
  assert.match(read('sw.js'), /'js\/history\.js'/);
});

/* ---------------- насколько сбывается прогноз ---------------- */

function accuracyPage(stats) {
  const elements = new Map();
  const getElement = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const calls = [];
  const fetch = async url => { calls.push(String(url)); return stats === 'fail' ? Promise.reject(new TypeError('offline')) : json(stats); };
  const ctx = loadApp([['config.js', read('config.js')], ['core.js', read('core.js')], ['push.js', read('push.js')], ['app.js', read('app.js')]],
    { now: NOW, getElement, createElement: () => element(), fetch });
  return { ctx, el: getElement, calls };
}

test('точность: итог по-русски — доля совпадений, промахи и что было при обещанном высоком', async () => {
  const { ctx, el, calls } = accuracyPage({ nights: 23, total: 150, exact: 111, offByOne: 34, offByTwo: 5,
    promised: { high: { n: 12, high: 7, mid: 3, low: 2 }, mid: { n: 0, high: 0, mid: 0, low: 0 }, low: { n: 0, high: 0, mid: 0, low: 0 } } });
  await ctx.loadAccuracy(false);
  assert.equal(calls[0], 'https://aurora-push.aurora-murmansk.workers.dev/verify');
  assert.equal(el('accuracy-card').hidden, false);
  assert.equal(el('accuracy-text').textContent,
    'За 23 ночи по семи точкам прогноз на ночь совпал с тем, что было, в 74% случаев (111 из 150); ошибся на одну ступень — 34, на две — 5. ' +
    'Когда обещали высокий шанс, он оказался высоким или средним в 10 из 12.');
  await ctx.loadAccuracy(false);
  assert.equal(calls.length, 1, 'не чаще раза в час');
});

test('точность: меньше пяти ночей — «статистика копится», без процентов; сервер недоступен — карточки нет', async () => {
  const few = accuracyPage({ nights: 2, total: 14, exact: 14, offByOne: 0, offByTwo: 0, promised: {} });
  await few.ctx.loadAccuracy(false);
  assert.equal(few.el('accuracy-text').textContent,
    'Статистика копится: сервер каждый вечер записывает прогноз на ночь, а утром сверяет его с тем, что было. Сверено ночей: 2; цифры появятся после 5.');
  assert.doesNotMatch(few.el('accuracy-text').textContent, /%/);

  const down = accuracyPage('fail');
  await down.ctx.loadAccuracy(false);
  assert.equal(down.el('accuracy-card').hidden, true);
  assert.match(read('js/page.js'), /loadAccuracy\(false\)/);
});
