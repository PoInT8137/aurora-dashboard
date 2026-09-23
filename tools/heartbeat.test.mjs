// Пульс сервера уведомлений на странице: разбор /health, строка диагностики, строка в карточке.
// Запуск: node --test tools/heartbeat.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { loadApp } from './app-sandbox.mjs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const NOW = Date.parse('2026-12-15T22:00:00Z');
const MIN = 60000;

const element = () => ({
  textContent: '', hidden: false, disabled: false, style: { setProperty() {} },
  children: [], attrs: {}, listeners: {},
  setAttribute(k, v) { this.attrs[k] = String(v); },
  getAttribute(k) { return this.attrs[k] ?? null; },
  addEventListener(type, fn) { this.listeners[type] = fn; },
  querySelector() { return element(); },
  querySelectorAll() { return []; },
  appendChild(child) { this.children.push(child); return child; },
  set innerHTML(v) { if (v === '') this.children = []; },
  get innerHTML() { return ''; }
});

function page(fetch) {
  const elements = new Map();
  const getElement = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const ctx = loadApp(
    [['config.js', read('config.js')], ['core.js', read('core.js')], ['push.js', read('push.js')], ['app.js', read('app.js')]],
    { now: NOW, getElement, createElement: () => element(), fetch });
  vm.runInContext("AURORA_CONFIG.pushApi = 'https://x.example'; AURORA_CONFIG.vapidPublicKey = 'AAAA';", ctx);
  ctx.state.point = ctx.findPoint('murmansk');
  return { ctx, el: getElement };
}

const reply = (body, status = 200) => () => Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
const plain = v => JSON.parse(JSON.stringify(v));

test('pushStatus: пульс из /health; сервер старой версии и мусор — без пульса; недоступен — ok: false', async () => {
  assert.deepEqual(plain(await page(reply({ ok: true, lastCheck: NOW - 4 * MIN, outcome: 'ok' })).ctx.pushStatus()),
    { ok: true, lastCheck: NOW - 4 * MIN, outcome: 'ok' });
  assert.deepEqual(plain(await page(reply({ ok: true })).ctx.pushStatus()), { ok: true, lastCheck: null, outcome: null }, 'старый сервер');
  assert.deepEqual(plain(await page(reply({ ok: true, lastCheck: 'вчера', outcome: 5 })).ctx.pushStatus()), { ok: true, lastCheck: null, outcome: null });
  assert.deepEqual(plain(await page(reply('не json')).ctx.pushStatus()), { ok: true, lastCheck: null, outcome: null });
  assert.deepEqual(plain(await page(reply({}, 503)).ctx.pushStatus()), { ok: false, lastCheck: null, outcome: null });
  assert.deepEqual(plain(await page(() => Promise.reject(new TypeError('Failed to fetch'))).ctx.pushStatus()), { ok: false, lastCheck: null, outcome: null });
  assert.equal(await page(reply({ ok: true })).ctx.pushHealth(), true, 'pushHealth по-прежнему да/нет');
});

test('диагностика: свежий пульс — «в порядке» и когда проверял', () => {
  const { ctx } = page();
  const c = ctx.serverCheck({ ok: true, lastCheck: NOW - 4 * MIN, outcome: 'ok' });
  assert.equal(c.state, 'ok');
  assert.equal(c.title, 'Сервер уведомлений отвечает');
  assert.equal(c.detail, 'Последний раз проверял условия 4 минуты назад.');
});

test('диагностика: пропуск из-за данных — объяснение, но «в порядке»', () => {
  const { ctx } = page();
  assert.match(ctx.serverCheck({ lastCheck: NOW - 9 * MIN, outcome: 'no_kp' }).detail, /9 минут назад\. NOAA тогда не дал свежий Kp/);
  assert.match(ctx.serverCheck({ lastCheck: NOW - 9 * MIN, outcome: 'no_cloud' }).detail, /Open-Meteo тогда не ответил/);
  assert.match(ctx.serverCheck({ lastCheck: NOW - 9 * MIN, outcome: 'error' }).detail, /завершилась ошибкой/);
  assert.equal(ctx.serverCheck({ lastCheck: NOW - 9 * MIN, outcome: 'no_subs' }).detail, 'Последний раз проверял условия 9 минут назад.', 'без подписчиков — это норма');
  assert.equal(ctx.serverCheck({ lastCheck: NOW - 9 * MIN, outcome: 'no_kp' }).state, 'ok');
});

test('диагностика: больше 30 минут без проверок — предупреждение; ровно 30 — ещё нет', () => {
  const { ctx } = page();
  const stale = ctx.serverCheck({ lastCheck: NOW - 95 * MIN, outcome: 'ok' });
  assert.equal(stale.state, 'warn');
  assert.equal(stale.title, 'Сервер отвечает, но давно не проверял условия');
  assert.equal(stale.detail, 'Последняя проверка — 1 час 35 минут назад. Пока это так, уведомления о сиянии могут не прийти.');
  assert.equal(ctx.serverCheck({ lastCheck: NOW - 30 * MIN, outcome: 'ok' }).state, 'ok');
  assert.equal(ctx.serverCheck({ lastCheck: NOW - 31 * MIN, outcome: 'ok' }).state, 'warn');
});

test('диагностика: сервер без пульса (старая версия) — просто «отвечает», без выдуманных подробностей', () => {
  const { ctx } = page();
  assert.deepEqual(plain(ctx.serverCheck({ ok: true, lastCheck: null, outcome: null })), { state: 'ok', title: 'Сервер уведомлений отвечает' });
  assert.deepEqual(plain(ctx.serverCheck(null)), { state: 'ok', title: 'Сервер уведомлений отвечает' });
});

test('проверка сервера на вкладке: статус и пульс попадают в диагностику и в карточку', async () => {
  const { ctx, el } = page(reply({ ok: true, lastCheck: NOW - 4 * MIN, outcome: 'ok' }));
  ctx.refreshPushHealth();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(ctx.state.pushHealth, true);
  assert.equal(el('push-heartbeat').textContent, 'Сервер проверял условия 4 минуты назад.');
  const server = Array.from(ctx.notifyChecks()).find(c => /Сервер уведомлений/.test(c.title));
  assert.equal(server.detail, 'Последний раз проверял условия 4 минуты назад.');

  ctx.setLang('en');
  ctx.renderPushHeartbeat();
  assert.equal(el('push-heartbeat').textContent, 'The server checked conditions 4 minutes ago.');
});

test('сервер недоступен — строка пульса пустая, диагностика — «не отвечает»', async () => {
  const { ctx, el } = page(() => Promise.reject(new TypeError('Failed to fetch')));
  ctx.refreshPushHealth();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(ctx.state.pushHealth, false);
  assert.equal(el('push-heartbeat').textContent, '');
  assert.ok(Array.from(ctx.notifyChecks()).some(c => c.title === 'Сервер уведомлений не отвечает'));
});
