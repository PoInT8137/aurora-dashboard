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

test('досчёт числа: без requestAnimationFrame или при «уменьшить движение» — сразу итог; с ним — от прежнего к новому', () => {
  const src = read('js/base.js');
  const code = ['motionAllowed', 'tweenNumber'].map(n => new RegExp('function ' + n + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}').exec(src)[0]).join('\n');
  const run = (extra) => {
    const ctx = { document: { visibilityState: 'visible' }, window: { matchMedia: () => ({ matches: false }) }, ...extra };
    vm.runInNewContext(code, ctx);
    return ctx;
  };
  const plain = run({});
  const el = {};
  plain.tweenNumber(el, 4.3, x => x.toFixed(1));
  assert.equal(el.textContent, '4.3');

  const frames = [];
  const reduced = run({ requestAnimationFrame: fn => frames.push(fn), cancelAnimationFrame() {}, window: { matchMedia: () => ({ matches: true }) } });
  const el2 = {};
  reduced.tweenNumber(el2, 70, x => Math.round(x) + '%');
  assert.equal(el2.textContent, '70%');
  assert.equal(frames.length, 0);

  const anim = run({ requestAnimationFrame: fn => { frames.push(fn); return frames.length; }, cancelAnimationFrame() {} });
  const el3 = {};
  anim.tweenNumber(el3, 80, x => Math.round(x) + '%');
  frames.shift()(0);
  assert.equal(el3.textContent, '0%', 'первый кадр — от нуля');
  frames.shift()(350);
  const mid = parseInt(el3.textContent, 10);
  assert.ok(mid > 40 && mid < 80, el3.textContent);
  frames.shift()(700);
  assert.equal(el3.textContent, '80%');
  assert.equal(frames.length, 0, 'после итога кадров больше нет');
});

test('смена вкладки — появление только прозрачностью и без анимации при «уменьшить движение»', () => {
  const css = read('styles.css');
  assert.match(css, /\[role="tabpanel"\]:not\(\[hidden\]\) \{ animation: tab-in/);
  assert.doesNotMatch(/@keyframes tab-in \{[^}]*\}/.exec(css)[0], /transform/);
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
