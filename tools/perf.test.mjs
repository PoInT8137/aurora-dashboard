// Скорость: соединения с источниками данных открываются заранее, скрытая вкладка не обновляется.
// Запуск: node --test tools/perf.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');

test('preconnect к серверу и Open-Meteo в <head>, адрес сервера совпадает с config.js', () => {
  const html = read('index.html');
  const head = html.slice(0, html.indexOf('</head>'));
  const ctx = {};
  vm.runInNewContext(read('config.js').replace(/\bvar AURORA_CONFIG\b/, 'this.AURORA_CONFIG'), ctx);
  const api = ctx.AURORA_CONFIG.pushApi;
  // запросы идут через fetch в режиме CORS — без crossorigin браузер открыл бы другое соединение
  assert.ok(head.includes('<link rel="preconnect" href="' + api + '" crossorigin>'), api);
  assert.ok(head.includes('<link rel="preconnect" href="https://api.open-meteo.com" crossorigin>'));
  assert.ok(head.indexOf('rel="preconnect"') < head.indexOf('rel="stylesheet"'), 'раньше стилей');
});

test('карточки без backdrop-filter: под ними движется фон, размытие пересчитывалось бы каждый кадр', () => {
  const card = /\n\.card \{[^}]*\}/.exec(read('styles.css'))[0];
  assert.doesNotMatch(card, /backdrop-filter:/);
});

test('автообновление пропускает скрытую вкладку и идёт снова, когда её открыли', () => {
  const src = read('js/settings.js');
  const armRefresh = /function armRefresh\(\) \{[\s\S]*?\n\}/.exec(src)[0];
  let tick = null;
  let calls = 0;
  const ctx = {
    state: { timer: null },
    document: { visibilityState: 'hidden' },
    refreshMs: () => 60000,
    refreshAll: () => { calls++; },
    setInterval: fn => { tick = fn; return 1; },
    clearInterval: () => {}
  };
  vm.runInNewContext(armRefresh + '; armRefresh();', ctx);
  tick();
  assert.equal(calls, 0);
  ctx.document.visibilityState = 'visible';
  tick();
  assert.equal(calls, 1);
});
