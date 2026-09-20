// Тесты интерфейсных функций app.js, которые не зависят от вёрстки:
// тексты ошибок уведомлений и поведение кнопок при сбоях.
// Запуск: node --test tools/app-ui.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { loadApp } from './app-sandbox.mjs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');

/** Элемент страницы: свойства пишутся и читаются как в DOM, чего заглушка не умеет. */
const element = () => ({
  textContent: '', hidden: false, disabled: false, style: { setProperty() {} },
  attrs: {}, listeners: {},
  setAttribute(k, v) { this.attrs[k] = String(v); },
  getAttribute(k) { return this.attrs[k] ?? null; },
  addEventListener(type, fn) { this.listeners[type] = fn; },
  querySelector() { return element(); },
  appendChild() {}
});

function app() {
  const elements = new Map();
  const getElement = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const ctx = loadApp(
    [['config.js', read('config.js')], ['core.js', read('core.js')], ['push.js', read('push.js')], ['app.js', read('app.js')]],
    { now: Date.UTC(2026, 8, 19, 18), getElement });
  return { ctx, el: getElement };
}

const text = (ctx, error) => ctx.pushErrorText(error);

test('тексты ошибок: настоящие DOMException, у которых поле code числовое, не роняют функцию', () => {
  const { ctx } = app();
  // Эта функция когда-то падала на code.indexOf: у AbortError code равен 20.
  assert.equal(new DOMException('x', 'AbortError').code, 20);

  assert.match(text(ctx, new DOMException('push service error', 'AbortError')), /не смог связаться со своим сервисом push/);
  assert.match(text(ctx, new DOMException('denied', 'NotAllowedError')), /Разрешение на уведомления не выдано/);
  assert.match(text(ctx, new DOMException('x', 'InvalidStateError')), /Не получилось: x/);
});

test('тексты ошибок: коды нашего кода и сети', () => {
  const { ctx } = app();
  const coded = code => Object.assign(new Error(code), { code });

  assert.match(text(ctx, coded('permission_denied')), /Разрешение на уведомления не выдано/);
  assert.match(text(ctx, coded('permission_default')), /Разрешение на уведомления не выдано/);
  assert.match(text(ctx, coded('subscribe_timeout')), /не отвечает на подписку/);
  assert.match(text(ctx, coded('no_service_worker')), /обновите страницу/);
  assert.match(text(ctx, coded('limit')), /не принимает новые подписки/);
  assert.match(text(ctx, coded('too_often')), /подождите 20 секунд/);
  assert.match(text(ctx, coded('not_subscribed')), /выключите и включите/);
  assert.match(text(ctx, new TypeError('Failed to fetch')), /Сервер уведомлений недоступен/);
  // прерванный запрос к серверу (наш таймаут): AbortError, но со строковым кодом или без него
  assert.match(text(ctx, Object.assign(new Error('t'), { name: 'AbortError', code: 'x' })), /Сервер уведомлений недоступен/);
  assert.match(text(ctx, undefined), /Не получилось/);
  assert.match(text(ctx, null), /Не получилось/);
});

test('кнопка не залипает: при ошибке действия показывается понятный текст и кнопки разблокируются', async () => {
  const { ctx, el } = app();
  vm.runInContext("AURORA_CONFIG.pushApi = 'https://x.example'; AURORA_CONFIG.vapidPublicKey = 'AAAA';", ctx);

  // Браузер с поддержкой push и без запрета: иначе кнопка и должна быть заблокирована.
  vm.runInContext("navigator.serviceWorker = {}; window.PushManager = function () {}; " +
    "Notification = window.Notification = { permission: 'default' };", ctx);

  await ctx.runPushAction('Включаем…', () => Promise.reject(new DOMException('push service error', 'AbortError')), () => {});

  assert.equal(ctx.state.pushBusy, false);
  assert.match(el('push-status').textContent, /не смог связаться со своим сервисом push/);
  assert.equal(el('push-toggle').disabled, false);
});

test('кнопка не залипает: ошибка в самом обработчике успеха тоже не оставляет «Включаем…»', async () => {
  const { ctx, el } = app();
  vm.runInContext("AURORA_CONFIG.pushApi = 'https://x.example'; AURORA_CONFIG.vapidPublicKey = 'AAAA';", ctx);

  await ctx.runPushAction('Включаем…', () => Promise.resolve('ок'), () => { throw new Error('сбой в обработчике'); });

  assert.equal(ctx.state.pushBusy, false);
  assert.match(el('push-status').textContent, /Не получилось: сбой в обработчике/);
});

test('успешное действие: обработчик вызывается, занятость снимается', async () => {
  const { ctx } = app();
  vm.runInContext("AURORA_CONFIG.pushApi = 'https://x.example'; AURORA_CONFIG.vapidPublicKey = 'AAAA';", ctx);

  let got;
  await ctx.runPushAction('Проверяем…', () => Promise.resolve({ ok: true }), r => { got = r; });
  assert.deepEqual({ ...got }, { ok: true });
  assert.equal(ctx.state.pushBusy, false);
});

test('карточка серверных уведомлений скрыта, пока не настроен адрес сервера', () => {
  const { ctx, el } = app();
  // Настоящий config.js уже заполнен боевыми значениями, а тест проверяет именно пустую
  // настройку, поэтому обнуляем её сам, а не полагаемся на содержимое файла.
  vm.runInContext("AURORA_CONFIG.pushApi = ''; AURORA_CONFIG.vapidPublicKey = '';", ctx);
  ctx.renderPushCard();
  assert.equal(el('push-card').hidden, true);

  vm.runInContext("AURORA_CONFIG.pushApi = 'https://x.example'; AURORA_CONFIG.vapidPublicKey = 'AAAA';", ctx);
  ctx.renderPushCard();
  assert.equal(el('push-card').hidden, false);
});

test('пока включены серверные уведомления, страница свои не шлёт', () => {
  const { ctx } = app();
  vm.runInContext("AURORA_CONFIG.pushApi = 'https://x.example'; AURORA_CONFIG.vapidPublicKey = 'AAAA';", ctx);

  const shown = [];
  ctx.showAppNotification = (title) => { shown.push(title); return Promise.resolve(); };
  ctx.Notification = { permission: 'granted' };
  vm.runInContext("window.Notification = Notification; document.hasFocus = () => false;", ctx);
  ctx.localStorage.setItem('aurora.notify', 'on');

  const verdict = level => ({ level, stale: false, factors: ['Kp 4,3', 'Облачность 12%', 'Тёмное небо'] });
  ctx.state.point = ctx.findPoint('murmansk');

  // серверные выключены: переход mid → high уведомляет страница
  ctx.state.lastLevel = { pointId: 'murmansk', level: 'mid' };
  ctx.checkHighChance(verdict('high'));
  assert.equal(shown.length, 1);

  // серверные включены: та же ситуация — страница молчит, чтобы не было двух уведомлений
  ctx.localStorage.removeItem('aurora.notified.murmansk');
  ctx.localStorage.setItem('aurora.push', 'on');
  ctx.state.lastLevel = { pointId: 'murmansk', level: 'mid' };
  ctx.checkHighChance(verdict('high'));
  assert.equal(shown.length, 1);
});
