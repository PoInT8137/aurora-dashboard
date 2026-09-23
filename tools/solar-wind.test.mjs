// Солнечный ветер: разбор ряда NOAA RTSW, оценка ближайшего часа, карточка, подсказка в вердикте.
// Запуск: node --test tools/solar-wind.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { loadApp, appSource } from './app-sandbox.mjs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const core = loadApp([['core.js', read('core.js')]], {}).AuroraCore;

const NOW = Date.parse('2026-12-15T22:00:00Z');   // полярная ночь, в Мурманске 01:00
const MIN = 60000;

/**
 * Ряд в формате rtsw_mag_1m.json: новые сверху, как у NOAA. bzAt(минутНазад) → Bz.
 * extra — записи других спутников или с пропусками.
 */
function rtsw(bzAt, { minutes = 180, now = NOW, extra = [], every = 1 } = {}) {
  const rows = [];
  for (let m = 0; m < minutes; m += every) {
    const bz = bzAt(m);
    if (bz === undefined) continue;
    rows.push({ time_tag: new Date(now - m * MIN).toISOString().slice(0, 19), active: true, source: 'SOLAR1', bt: Math.abs(bz) + 2, bz_gsm: bz });
  }
  return rows.concat(extra);
}

test('уровни: сильный южный, устойчиво южный, слабо южный, северный', () => {
  assert.equal(core.solarWindSummary(rtsw(() => -12), NOW).level, 'strong');
  assert.equal(core.solarWindSummary(rtsw(() => -6), NOW).level, 'south');
  assert.equal(core.solarWindSummary(rtsw(() => -2), NOW).level, 'weak');
  assert.equal(core.solarWindSummary(rtsw(() => 3), NOW).level, 'north');
  assert.equal(core.solarWindSummary(rtsw(() => 0), NOW).level, 'north', 'ноль — не южный');
  // граница «сильного» — ровно −10 в среднем за 15 минут
  assert.equal(core.solarWindSummary(rtsw(() => -10), NOW).level, 'strong');
  assert.equal(core.solarWindSummary(rtsw(() => -9), NOW).level, 'south');
});

test('«устойчиво» значит устойчиво: короткий провал на юг — лишь «слабо южный», а не рост', () => {
  // последние 5 минут −8, до этого северный: среднее за 20 минут выше −5
  const brief = core.solarWindSummary(rtsw(m => (m < 5 ? -8 : 4)), NOW);
  assert.equal(brief.level, 'weak');
  assert.equal(brief.southMinutes, 4);
  // 25 минут подряд −6 — устойчиво
  const steady = core.solarWindSummary(rtsw(m => (m < 25 ? -6 : 4)), NOW);
  assert.equal(steady.level, 'south');
  assert.equal(steady.southMinutes, 24);
  // только что повернул на север после долгого юга: сейчас северный, но среднее ещё южное
  const turned = core.solarWindSummary(rtsw(m => (m < 3 ? 2 : -9)), NOW);
  assert.equal(turned.southMinutes, 0);
  assert.equal(turned.level, 'south', 'среднее за 20 минут всё ещё −8');
});

test('текущий Bz — среднее за 5 минут, округлённое до десятых; Bt — последний известный', () => {
  const s = core.solarWindSummary(rtsw(m => (m < 5 ? [-4, -6, -5, -7, -3][m] : 1)), NOW);
  assert.equal(s.bz, -5);
  assert.equal(s.bt, 6);
  assert.equal(s.time.getTime(), NOW);
});

test('берётся только основной поток (active), неактивные спутники и мусор игнорируются', () => {
  const extra = [
    { time_tag: new Date(NOW).toISOString().slice(0, 19), active: false, source: 'ACE', bt: 30, bz_gsm: -25 },
    { time_tag: 'не время', active: true, bz_gsm: -25 },
    { time_tag: new Date(NOW).toISOString().slice(0, 19), active: true, bz_gsm: null },
    { time_tag: new Date(NOW + 60 * MIN).toISOString().slice(0, 19), active: true, bz_gsm: -25 },   // из будущего
    null
  ];
  const s = core.solarWindSummary(rtsw(() => 2, { extra }), NOW);
  assert.equal(s.level, 'north');
  assert.equal(s.bz, 2);
});

test('ряд обрезан до двух часов и упорядочен по времени, как бы ни шёл в файле', () => {
  const s = core.solarWindSummary(rtsw(() => -1, { minutes: 24 * 60 }).reverse(), NOW);
  assert.ok(s.series.length <= 121);
  assert.ok(NOW - s.series[0].time <= 2 * 60 * MIN);
  for (let i = 1; i < s.series.length; i++) assert.ok(s.series[i].time > s.series[i - 1].time);
});

test('нет свежих данных — null: пусто, не массив, последний отсчёт старше получаса', () => {
  assert.equal(core.solarWindSummary([], NOW), null);
  assert.equal(core.solarWindSummary(null, NOW), null);
  assert.equal(core.solarWindSummary({ error: 1 }, NOW), null);
  assert.equal(core.solarWindSummary(rtsw(m => (m >= 40 ? -12 : undefined)), NOW), null, 'спутник молчит 40 минут');
  assert.ok(core.solarWindSummary(rtsw(m => (m >= 20 ? -12 : undefined)), NOW), '20 минут тишины — ещё годится');
});

test('пропуски в данных не ломают оценку: отсчёты раз в 3 минуты', () => {
  const s = core.solarWindSummary(rtsw(() => -7, { every: 3 }), NOW);
  assert.equal(s.level, 'south');
});

test('время в пути от L1: 1,5 млн км при 400 км/с — около час; нефизичная скорость — не считаем', () => {
  assert.equal(core.solarWindLeadMinutes(400), 63);
  assert.equal(core.solarWindLeadMinutes(800), 31);
  assert.equal(core.solarWindLeadMinutes('500'), 50);
  for (const bad of [null, undefined, 0, -400, 50, 9999, 'быстро']) assert.equal(core.solarWindLeadMinutes(bad), null, String(bad));
});

test('настоящий формат NOAA: строка времени без Z читается как UTC', () => {
  const rows = [{ time_tag: '2026-12-15T21:58:00', active: true, source: 'SOLAR1', bt: 3.2, bx_gse: 2.2, bz_gsm: -2.29 }];
  const s = core.solarWindSummary(rows, NOW);
  assert.equal(s.time.toISOString(), '2026-12-15T21:58:00.000Z');
  assert.equal(s.bz, -2.3);
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

function page({ fetch } = {}) {
  const elements = new Map();
  const getElement = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const ctx = loadApp(
    [['config.js', read('config.js')], ['core.js', read('core.js')], ['push.js', read('push.js')], ['app.js', read('app.js')]],
    { now: NOW, getElement, createElement: () => element(), fetch });
  ctx.state.point = ctx.findPoint('murmansk');
  return { ctx, el: getElement };
}

const json = body => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
const world = (mag, speed = [{ proton_speed: 450, time_tag: '2026-12-15T21:59:00Z' }]) => url =>
  (String(url).includes('rtsw_mag') ? (mag instanceof Error ? Promise.reject(mag) : json(mag))
    : String(url).includes('solar-wind-speed') ? (speed instanceof Error ? Promise.reject(speed) : json(speed))
      : Promise.reject(new TypeError('Failed to fetch')));

test('карточка: Bz с настоящим минусом, прогноз на час, скорость и время в пути, график из 24 столбиков', async () => {
  const { ctx, el } = page({ fetch: world(rtsw(m => (m < 30 ? -7 : 2))) });
  await ctx.loadSolarWind();

  assert.equal(el('sw-value').textContent, '−7,0 нТл');
  assert.equal(el('sw-caption').textContent, 'Bz устойчиво южный уже 29 минут — активность, скорее всего, вырастет в ближайший час.');
  assert.equal(el('sw-facts').textContent, 'сила поля 9,0 нТл · скорость 450 км/с · дойдёт до Земли примерно через 56 минут');
  assert.equal(el('sw-meta').textContent, 'Спутники NOAA в точке L1 · данные на 01:00');
  assert.equal(el('sw-card').attrs['data-state'], 'ok');

  const bars = el('sw-chart').children;
  assert.equal(bars.length, 24);
  assert.match(bars[23].className, /swbar--south/);
  assert.match(bars[0].className, /swbar--north/);
  assert.equal(bars[23].children[0].style.height, String(7 / 10 * 50) + '%', 'шкала не меньше ±10 нТл');
});

test('карточка на английском и китайском', async () => {
  const { ctx, el } = page({ fetch: world(rtsw(() => -12)) });
  ctx.setLang('en');
  await ctx.loadSolarWind();
  assert.equal(el('sw-value').textContent, '−12.0 nT');
  assert.match(el('sw-caption').textContent, /^Strongly southward Bz/);
  assert.match(el('sw-facts').textContent, /reaches Earth in about 56 minutes$/);

  ctx.setLang('zh');
  ctx.renderSolarWind(ctx.state.sw);
  assert.match(el('sw-caption').textContent, /^Bz 强烈向南/);
  assert.match(el('sw-facts').textContent, /约56分钟后到达地球$/);
});

test('без скорости карточка работает, просто без времени в пути', async () => {
  const { ctx, el } = page({ fetch: world(rtsw(() => 3), new TypeError('Failed to fetch')) });
  await ctx.loadSolarWind();
  assert.equal(el('sw-value').textContent, '+3,0 нТл');
  assert.equal(el('sw-facts').textContent, 'сила поля 5,0 нТл');
});

test('спутники молчат больше получаса — ошибка с понятной причиной, а не «северный»', async () => {
  const { ctx, el } = page({ fetch: world(rtsw(m => (m > 45 ? -12 : undefined))) });
  const result = await ctx.loadSolarWind();
  assert.equal(result, null);
  assert.equal(el('sw-card').attrs['data-state'], 'error');
  assert.equal(el('sw-error').textContent, 'Данные солнечного ветра недоступны: спутники не передавали данные больше получаса.');
});

test('нет связи — показываем сохранённое с пометкой возраста; без сохранённого — ошибка', async () => {
  const first = page({ fetch: world(rtsw(() => -6)) });
  await first.ctx.loadSolarWind();
  const saved = first.ctx.localStorage.getItem('aurora.sw');
  assert.ok(saved);

  const offline = page({ fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
  offline.ctx.localStorage.setItem('aurora.sw', saved);
  const sw = await offline.ctx.loadSolarWind();
  assert.equal(sw.level, 'south');
  assert.equal(offline.el('sw-card').attrs['data-state'], 'stale');

  const empty = page({ fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
  assert.equal(await empty.ctx.loadSolarWind(), null);
  assert.equal(empty.el('sw-error').textContent, 'Данные солнечного ветра недоступны: нет соединения.');
});

const verdict = (ctx, kp, cloud) =>
  ctx.computeVerdict({ value: kp, stale: null }, { value: cloud, conflict: false, stale: null });

test('вердикт: южный ветер добавляет подсказку «ждите роста», но уровень не меняет', () => {
  const { ctx } = page();
  const base = verdict(ctx, 1.3, 20);
  assert.doesNotMatch(base.hint, /Солнечный ветер/);

  for (const level of ['strong', 'south']) {
    ctx.state.sw = { level, stale: null, southMinutes: 30 };
    const v = verdict(ctx, 1.3, 20);
    assert.equal(v.level, base.level, 'уровень от ветра не зависит');
    assert.match(v.hint, /Солнечный ветер обещает рост активности в ближайший час/);
  }
  for (const level of ['weak', 'north']) {
    ctx.state.sw = { level, stale: null, southMinutes: 0 };
    assert.doesNotMatch(verdict(ctx, 1.3, 20).hint, /Солнечный ветер/, level);
  }
});

test('вердикт: подсказки о ветре нет, когда она бесполезна — уже высокий шанс, сплошные облака, светло, данные устарели', () => {
  const { ctx } = page();
  ctx.state.sw = { level: 'strong', stale: null, southMinutes: 30 };
  assert.equal(verdict(ctx, 5, 5).level, 'high');
  assert.doesNotMatch(verdict(ctx, 5, 5).hint, /Солнечный ветер/, 'уже высокий');
  assert.doesNotMatch(verdict(ctx, 1.3, 95).hint, /Солнечный ветер/, 'небо закрыто');

  ctx.state.sw = { level: 'strong', stale: 40 * MIN, southMinutes: 30 };
  assert.doesNotMatch(verdict(ctx, 1.3, 20).hint, /Солнечный ветер/, 'сохранённые данные — не «ближайший час»');

  const day = loadApp([['config.js', read('config.js')], ['core.js', read('core.js')], ['push.js', read('push.js')], ['app.js', read('app.js')]],
    { now: Date.parse('2026-06-21T09:00:00Z') });
  day.state.point = day.findPoint('murmansk');
  day.state.sw = { level: 'strong', stale: null, southMinutes: 30 };
  assert.doesNotMatch(verdict(day, 1.3, 20).hint, /Солнечный ветер/, 'полярный день');
});

test('обновление запрашивает и солнечный ветер; кнопка «Повторить» в карточке перезапрашивает его', () => {
  const app = appSource();
  assert.match(app, /var tasks = \[[^\]]*loadSolarWind\(\)[^\]]*\];/);
  assert.match(app, /if \(what === 'sw'\)\s+loadSolarWind\(\)\.then\(renderDerived\);/);
  const html = read('index.html');
  assert.equal((html.match(/data-retry="sw"/g) || []).length, 2);
});

test('старые адреса NOAA products/solar-wind не используются: они отвечают 404', () => {
  assert.doesNotMatch(appSource(), /'https:[^']*products\/solar-wind\//);
});

test('график: в бурю шкала растягивается до самого сильного отсчёта — столбик не выходит за край', async () => {
  const { ctx, el } = page({ fetch: world(rtsw(m => (m < 10 ? -25 : -5))) });
  await ctx.loadSolarWind();
  const bars = el('sw-chart').children;
  assert.equal(bars[23].children[0].style.height, '50%');
  assert.equal(bars[0].children[0].style.height, String(5 / 25 * 50) + '%');
});
