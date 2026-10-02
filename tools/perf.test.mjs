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

function hedgeCtx() {
  const src = read('js/base.js');
  const code = /function hedgeFetch\([^)]*\) \{[\s\S]*?\n\}/.exec(src)[0];
  const ctx = { setTimeout, clearTimeout, AbortController, Promise };
  vm.runInNewContext(code, ctx);
  return ctx;
}
const later = (ms, value, fail) => signal => new Promise((resolve, reject) => {
  const t = setTimeout(() => (fail ? reject(new Error(value)) : resolve(value)), ms);
  signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
});

test('страхующий запрос: быстрый основной — запасной не запускается', async () => {
  const { hedgeFetch } = hedgeCtx();
  let second = 0;
  const data = await hedgeFetch(later(10, 'main'), s => { second++; return later(10, 'backup')(s); }, 200);
  assert.equal(data, 'main');
  await new Promise(r => setTimeout(r, 250));
  assert.equal(second, 0);
});

test('страхующий запрос: основной висит — через паузу запасной, побеждает первый ответ, висящий отменяется', async () => {
  const { hedgeFetch } = hedgeCtx();
  let aborted = false, won = false;
  const hang = signal => new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }));
  const t0 = Date.now();
  const data = await hedgeFetch(hang, later(10, 'backup'), 50, () => { won = true; });
  assert.equal(data, 'backup');
  assert.ok(Date.now() - t0 < 1000, 'не ждём таймаут основного');
  assert.equal(aborted, true);
  assert.equal(won, true);
});

test('страхующий запрос: основной упал сразу — запасной без паузы; упали оба — ошибка основного', async () => {
  const { hedgeFetch } = hedgeCtx();
  const t0 = Date.now();
  assert.equal(await hedgeFetch(later(5, 'down', true), later(5, 'backup'), 5000), 'backup');
  assert.ok(Date.now() - t0 < 1000);
  await assert.rejects(hedgeFetch(later(5, 'main down', true), later(5, 'backup down', true), 5000), /main down/);
});

test('обновление: вердикт не ждёт второстепенного (отметки очевидцев, OVATION); сводка отметок — короткое ожидание без повтора', () => {
  const page = read('js/page.js');
  const refresh = /function refreshAll\(\) \{[\s\S]*?\n\}/.exec(page)[0];
  assert.match(refresh, /var core = \[loadKp\(\), loadCloud\(\), loadForecast\(\), loadSolarWind\(\)\]\.map\(function \(task\) \{\s*return task\.then\(renderDerived, renderDerived\);/);
  assert.doesNotMatch(/var core = \[[^\]]*\]/.exec(refresh)[0], /loadReports|loadOvation/);
  const reports = read('js/reports.js');
  assert.match(reports, /fetchJsonDirect\(AURORA_CONFIG\.pushApi \+ '\/reports', CONFIG\.retries, 'json', REPORTS\.timeoutMs\)/);
  assert.match(reports, /timeoutMs: 6000/);
});

test('service worker регистрируется после первого обновления данных, а не одновременно с ним', () => {
  const app = read('app.js');
  assert.doesNotMatch(app, /addEventListener\('load', registerServiceWorker\)/);
  assert.match(app, /state\.refreshing/);
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
