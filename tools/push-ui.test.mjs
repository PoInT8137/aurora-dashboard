// Карточка уведомлений: заметная подсказка для iPhone и проверка запуска с экрана «Домой»,
// инструкция при заблокированных уведомлениях под браузер, порог в подсказке, пояс только при
// тихих часах. Запуск: node --test tools/push-ui.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadApp } from './app-sandbox.mjs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  oldIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
};

function page(ua, { standalone = false } = {}) {
  const elements = new Map();
  const element = () => ({ textContent: '', className: '', hidden: false, disabled: false, children: [], attrs: {}, style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; } });
  const el = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const ctx = loadApp([['config.js', read('config.js')], ['core.js', read('core.js')], ['push.js', read('push.js')], ['app.js', read('app.js')]],
    { now: Date.parse('2026-10-25T20:00:00Z'), getElement: el });
  ctx.navigator.userAgent = ua;
  ctx.navigator.platform = /iPhone/.test(ua) ? 'iPhone' : 'Win32';
  ctx.navigator.standalone = standalone;
  if (ctx.window && ctx.window.navigator) ctx.window.navigator.standalone = standalone;
  return { ctx, el };
}

test('версия iOS и поддержка push: с 16.4', () => {
  assert.deepEqual([...page(UA.iphone).ctx.iosVersion()], [17, 5]);
  assert.equal(page(UA.iphone).ctx.iosPushCapable(), true);
  assert.equal(page(UA.oldIphone).ctx.iosPushCapable(), false);
  assert.equal(page(UA.chrome).ctx.iosVersion(), null);
});

test('iPhone в Safari: шаги «на экран Домой» и честное «сейчас открыт в браузере»', () => {
  const { ctx, el } = page(UA.iphone);
  ctx.renderIosPush();
  assert.equal(el('push-ios').hidden, false);
  assert.equal(el('push-ios-steps').hidden, false);
  assert.equal(el('push-ios-state').textContent, 'Сейчас сайт открыт в браузере, а не как приложение, поэтому включить уведомления нельзя.');
  assert.equal(el('push-ios').attrs['data-ok'], 'false');
});

test('iPhone, сайт открыт с экрана «Домой»: шагов нет, сказано, что можно включать', () => {
  const { ctx, el } = page(UA.iphone, { standalone: true });
  ctx.renderIosPush();
  assert.equal(el('push-ios-steps').hidden, true);
  assert.equal(el('push-ios-state').textContent, 'Сайт открыт как приложение с экрана «Домой»: уведомления можно включить.');
  assert.equal(el('push-ios').attrs['data-ok'], 'true');

  const old = page(UA.oldIphone, { standalone: true });
  old.ctx.renderIosPush();
  assert.match(old.el('push-ios-state').textContent, /^Нужна iOS 16\.4 или новее/);
});

test('не iPhone — блока нет', () => {
  const { ctx, el } = page(UA.android);
  ctx.renderIosPush();
  assert.equal(el('push-ios').hidden, true);
});

test('уведомления заблокированы: инструкция под браузер', () => {
  assert.equal(page(UA.iphone).ctx.deniedGuideKey(), 'push.denied.ios');
  assert.equal(page(UA.android).ctx.deniedGuideKey(), 'push.denied.android');
  assert.equal(page(UA.firefox).ctx.deniedGuideKey(), 'push.denied.firefox');
  assert.equal(page(UA.safari).ctx.deniedGuideKey(), 'push.denied.safari');
  assert.equal(page(UA.chrome).ctx.deniedGuideKey(), 'push.denied.chrome');
  const { ctx } = page(UA.chrome);
  assert.match(ctx.t('push.hint.denied', { how: ctx.t('push.denied.chrome') }),
    /^Уведомления для этого сайта запрещены в браузере\. Как разрешить: нажмите значок слева от адреса сайта/);
});

test('подсказка называет выбранный порог; кнопка отключения называется «Отписаться»', () => {
  const { ctx } = page(UA.chrome);
  assert.match(ctx.t('push.hint.on', { name: 'Мурманск', level: ctx.t('push.level.mid') }), /когда шанс станет средним или высоким, не чаще раза в 3 часа/);
  assert.equal(ctx.t('push.toggle.off'), 'Отписаться');
});

test('пояс уходит на сервер только при включённых тихих часах', () => {
  const { ctx } = page(UA.chrome);
  assert.equal(ctx.pushPreferences().tz, null);
  ctx.setSetting('quiet', '23-07');
  assert.equal(typeof ctx.pushPreferences().tz, 'string');
});

test('тексты: раз в 5 минут, что хранит сервер, три языка без длинных тире; сервер по расписанию раз в 5 минут', () => {
  const keys = ['push.lead', 'push.tip.privacy', 'push.hint.denied', 'push.hint.on', 'push.denied.chrome', 'push.denied.ios',
    'push.ios.title', 'push.ios.step2', 'push.ios.browser', 'push.ios.app', 'push.ios.old', 'push.toggle.off'];
  for (const lang of ['ru', 'en', 'zh']) {
    const dict = read('lang/' + lang + '.js');
    for (const key of keys) {
      const line = dict.split('\n').find(l => l.startsWith(`  '${key}':`));
      assert.ok(line, lang + ' ' + key);
      assert.doesNotMatch(line, /—/, lang + ' ' + key);
    }
  }
  assert.match(read('lang/ru.js'), /'push\.lead': 'Сервер проверяет условия раз в 5 минут/);
  assert.match(read('lang/ru.js'), /Тихие часы и часовой пояс хранятся, только если тихие часы включены/);
  assert.match(read('worker/wrangler.toml'), /crons = \["\*\/5 \* \* \* \*"/);
});
