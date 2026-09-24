// Отметки «Вижу сияние» на странице: сводка очевидцев, кнопка и выбор силы, темнота и частота,
// своё место, ошибки сервера, отсутствие сервера. Сервер — worker/test/reports.test.mjs.
// Запуск: node --test tools/reports.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadApp } from './app-sandbox.mjs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const NIGHT = '2026-12-15T19:00:00Z';   // 22:00 МСК, полярная ночь
const DAY = '2026-06-21T09:00:00Z';

const element = () => ({
  textContent: '', hidden: false, disabled: false, className: '', value: '',
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

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function page({ now = NIGHT, reports = { window: 60, total: 0, points: {} }, post = () => json({ ok: true }), config = true } = {}) {
  const elements = new Map();
  const getElement = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/reports')) return typeof reports === 'function' ? reports() : json(reports);
    if (String(url).endsWith('/report')) return post(JSON.parse(init.body));
    return new Promise(() => {});
  };
  const cfg = config ? read('config.js') : 'var AURORA_CONFIG = { pushApi: "", vapidPublicKey: "" };';
  const ctx = loadApp([['config.js', cfg], ['core.js', read('core.js')], ['push.js', read('push.js')], ['app.js', read('app.js')]],
    { now: Date.parse(now), getElement, createElement: () => element(), fetch });
  ctx.state.point = ctx.findPoint('murmansk');
  return { ctx, el: getElement, calls };
}

test('нет отметок — приглашение отметить; кнопка доступна ночью', async () => {
  const { ctx, el, calls } = page();
  ctx.initReports();
  await ctx.loadReports(true);
  assert.equal(calls[0].url, 'https://aurora-push.aurora-murmansk.workers.dev/reports');
  assert.equal(el('reports-card').hidden, false);
  assert.equal(el('reports-summary').textContent, 'За последний час отметок нет. Видите сияние — отметьте: это поможет другим.');
  assert.equal(el('report-btn').disabled, false);
  assert.equal(el('report-note').textContent, '');
});

test('сводка: у своей точки подробно, с числом людей по-русски и яркими; остальные — списком', async () => {
  const at = Date.parse(NIGHT) - 5 * 60000;
  const { ctx, el } = page({ reports: { window: 60, total: 6, points: {
    murmansk: { count: 3, bright: 1, last: at }, teriberka: { count: 2, bright: 2, last: at }, kirovsk: { count: 1, bright: 0, last: at }
  } } });
  await ctx.loadReports(true);
  assert.equal(el('reports-summary').textContent,
    'За последний час сияние у точки «Мурманск» отметили 3 человека. Ярким — 1. Последняя отметка — в 21:55. Ещё отметки: Териберка — 2, Кировск — 1.');
  assert.equal(el('reports-card').style.props['--tone'], 'var(--ok)', 'есть отметки рядом — зелёная полоса');

  ctx.state.point = ctx.findPoint('lovozero');
  ctx.renderReports();
  assert.equal(el('reports-summary').textContent, 'Здесь отметок нет, но сияние видели: Мурманск — 3, Териберка — 2, Кировск — 1.');
  assert.equal(el('reports-card').style.props['--tone'], null);

  const one = page({ reports: { window: 60, total: 5, points: { murmansk: { count: 5, bright: 0, last: at } } } });
  await one.ctx.loadReports(true);
  assert.match(one.el('reports-summary').textContent, /отметили 5 человек\./);
  one.ctx.setLang('en');
  one.ctx.renderReports();
  assert.match(one.el('reports-summary').textContent, /^In the last hour 5 people reported the aurora at Murmansk\./);
});

test('отметка: выбор силы, запрос с точкой и силой, благодарность, кнопка ждёт 30 минут', async () => {
  const sent = [];
  const { ctx, el } = page({ post: body => { sent.push(body); return json({ ok: true, point: body.point }); } });
  el('report-choice').hidden = true;   // как в разметке
  ctx.initReports();
  await ctx.loadReports(true);
  el('report-btn').listeners.click();
  assert.equal(el('report-choice').hidden, false);
  await ctx.sendReport('bright');
  assert.deepEqual(sent, [{ point: 'murmansk', strength: 'bright' }]);
  assert.equal(el('report-status').textContent, 'Спасибо! Отметку увидят все, кто смотрит прогноз.');
  assert.equal(el('report-btn').disabled, true);
  assert.equal(el('report-note').textContent, 'Следующая отметка — после 22:30.');
  assert.equal(el('report-choice').hidden, true);
});

test('днём отметить нельзя — кнопка выключена и объяснено почему', async () => {
  const { ctx, el } = page({ now: DAY });
  await ctx.loadReports(true);
  assert.equal(el('report-btn').disabled, true);
  assert.equal(el('report-note').textContent, 'Отметить можно, когда у точки стемнеет.');
});

test('своё место: сводка и отметка — у ближайшей точки области, и это сказано', async () => {
  const sent = [];
  const { ctx, el } = page({ post: body => { sent.push(body); return json({ ok: true }); } });
  ctx.localStorage.setItem('aurora.places', JSON.stringify([{ id: 'my-1', name: 'У Хибин', lat: 67.7, lon: 33.6 }]));
  ctx.state.point = ctx.pointById('my-1');
  await ctx.loadReports(true);
  assert.equal(el('report-note').textContent, 'Отметка ставится у ближайшей точки области — «Кировск».');
  await ctx.sendReport('faint');
  assert.deepEqual(sent, [{ point: 'kirovsk', strength: 'faint' }]);
});

test('ошибки сервера: слишком часто, «не темно», сбой — понятный текст, кнопка снова доступна', async () => {
  for (const [status, error, text] of [
    [429, 'too_often', 'Отмечать можно не чаще раза в 30 минут.'],
    [400, 'not_dark', 'Отметить можно, когда у точки стемнеет.'],
    [500, null, 'Не удалось отправить отметку — проверьте связь и попробуйте ещё раз.']
  ]) {
    const { ctx, el } = page({ post: () => json(error ? { error } : {}, status) });
    await ctx.loadReports(true);
    await ctx.sendReport('faint');
    assert.equal(el('report-status').textContent, text, error);
    assert.equal(ctx.state.reportBusy, false);
    assert.equal(el('report-btn').disabled, false, 'отметки не было — можно попробовать снова');
  }
});

test('сводка не загрузилась — тихий текст, кнопка работает; сервер не настроен — карточки нет и запросов нет', async () => {
  const broken = page({ reports: () => json({ nope: 1 }) });
  await broken.ctx.loadReports(true);
  assert.equal(broken.el('reports-summary').textContent, 'Не удалось загрузить отметки очевидцев.');
  assert.equal(broken.el('report-btn').disabled, false);

  const none = page({ config: false });
  none.ctx.initReports();
  await none.ctx.loadReports(true);
  assert.equal(none.el('reports-card').hidden, true);
  assert.equal(none.calls.length, 0);
});

test('сводка кэшируется на 2 минуты; «Обновить» запрашивает заново', async () => {
  const { ctx, calls } = page();
  await ctx.loadReports(false);
  await ctx.loadReports(false);
  assert.equal(calls.filter(c => c.url.endsWith('/reports')).length, 1);
  await ctx.loadReports(true);
  assert.equal(calls.filter(c => c.url.endsWith('/reports')).length, 2);
  assert.match(read('js/page.js'), /loadReports\(true\)\]/, 'входит в общее обновление');
});

test('разметка: карточка скрыта до проверки сервера, выбор силы — группа кнопок, файл в оболочке', () => {
  const html = read('index.html');
  assert.match(html, /<section class="card card--wide reports" id="reports-card" hidden>/);
  assert.match(html, /id="report-choice" role="group"[^>]*hidden>/);
  assert.match(html, /data-strength="faint"/);
  assert.match(html, /data-strength="bright"/);
  assert.match(read('sw.js'), /'js\/reports\.js'/);
});
