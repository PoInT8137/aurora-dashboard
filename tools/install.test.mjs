// Подсказка «Добавьте на экран „Домой“»: когда показывать и что предлагать.
// Запуск: node --test tools/install.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadApp } from './app-sandbox.mjs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const DAY = 24 * 3600 * 1000;

function app() {
  return loadApp([['config.js', read('config.js')], ['core.js', read('core.js')], ['push.js', read('push.js')], ['app.js', read('app.js')]],
    { now: Date.parse('2026-12-15T18:00:00Z') });
}

test('когда предлагать: iPhone — инструкция, Chrome с разрешённой установкой — кнопка, остальные — ничего', () => {
  const ctx = app();
  const base = { standalone: false, firstVisit: false, dismissedAt: 0, now: 100 * DAY, ios: false, canPrompt: false };
  assert.equal(ctx.installMode({ ...base, ios: true }), 'ios');
  assert.equal(ctx.installMode({ ...base, canPrompt: true }), 'prompt');
  assert.equal(ctx.installMode(base), null, 'браузер не умеет устанавливать — молчим');
});

test('не показываем: в установленном приложении, при первом визите (заставка) и 30 дней после «Не сейчас»', () => {
  const ctx = app();
  const base = { standalone: false, firstVisit: false, dismissedAt: 0, now: 100 * DAY, ios: true, canPrompt: false };
  assert.equal(ctx.installMode({ ...base, standalone: true }), null);
  assert.equal(ctx.installMode({ ...base, firstVisit: true }), null);
  assert.equal(ctx.installMode({ ...base, dismissedAt: 100 * DAY - 29 * DAY }), null);
  assert.equal(ctx.installMode({ ...base, dismissedAt: 100 * DAY - 31 * DAY }), 'ios', 'через месяц — снова');
});

test('разметка и подключение: не модальная карточка, скрыта по умолчанию, файл в оболочке service worker, тексты на трёх языках', () => {
  const html = read('index.html');
  assert.match(html, /<aside class="install" id="install" role="dialog"[^>]*hidden>/);
  assert.match(html, /<script src="js\/install\.js"><\/script>/);
  assert.match(read('sw.js'), /'js\/install\.js'/);
  for (const lang of ['ru', 'en', 'zh']) {
    const dict = read('lang/' + lang + '.js');
    for (const key of ['install.title', 'install.ios', 'install.text', 'install.go', 'install.later']) assert.ok(dict.includes(`'${key}'`), lang + ' ' + key);
  }
  assert.match(read('styles.css'), /prefers-reduced-motion: reduce\) \{\s*\.install \{ animation: none; \}/);
});
