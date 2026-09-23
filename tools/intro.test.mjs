// Анимация запуска: раз за сеанс, никогда при «уменьшить движение», ничего не блокирует.
// Запуск: node --test tools/intro.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const html = read('index.html');
const css = read('styles.css');

const introScript = (() => {
  const all = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const found = all.find(s => /classList\.add\('intro'\)/.test(s));
  assert.ok(found, 'встроенный скрипт анимации есть в <head>');
  return found;
})();

/** Запуск скрипта в окружении с подменённым хранилищем, matchMedia и таймером. */
function run({ seen = false, reduced = false, storageThrows = false } = {}) {
  const store = new Map(seen ? [['aurora.intro', '1']] : []);
  const classes = new Set();
  const timers = [];
  const sessionStorage = {
    getItem: k => { if (storageThrows) throw new Error('заблокировано'); return store.get(k) ?? null; },
    setItem: (k, v) => { if (storageThrows) throw new Error('заблокировано'); store.set(k, v); }
  };
  vm.runInContext(introScript, vm.createContext({
    sessionStorage,
    matchMedia: q => ({ matches: q.includes('reduce') && reduced }),
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    document: { documentElement: { classList: { add: c => classes.add(c), remove: c => classes.delete(c) } } }
  }));
  return { classes, timers, store };
}

test('первый запуск за сеанс: класс intro ставится и снимается через 2,6 с, сеанс запоминается', () => {
  const { classes, timers, store } = run();
  assert.ok(classes.has('intro'));
  assert.equal(store.get('aurora.intro'), '1');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 2600);
  timers[0].fn();
  assert.ok(!classes.has('intro'), 'после анимации класс снят — страница как обычно');
});

test('повторно в том же сеансе анимации нет', () => {
  const { classes, timers } = run({ seen: true });
  assert.ok(!classes.has('intro'));
  assert.equal(timers.length, 0);
});

test('«уменьшить движение» в системе — анимации нет и сеанс не помечается', () => {
  const { classes, store } = run({ reduced: true });
  assert.ok(!classes.has('intro'));
  assert.equal(store.size, 0);
});

test('хранилище недоступно — без анимации, без ошибки', () => {
  assert.doesNotThrow(() => run({ storageThrows: true }));
  assert.ok(!run({ storageThrows: true }).classes.has('intro'));
});

test('скрипт анимации идёт после скрипта темы: тот должен быть первым (на это опирается его тест)', () => {
  const first = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  assert.match(first, /data-theme/);
  assert.ok(html.indexOf(introScript) > html.indexOf(first));
});

test('слой с занавесами скрыт от скринридеров, не ловит нажатия и лежит под содержимым', () => {
  assert.match(html, /<div class="intro-sky" aria-hidden="true">(<span><\/span>){5}<\/div>/);
  const layer = /\.intro-sky \{[^}]*\}/.exec(css)[0];
  assert.match(layer, /display: none;/, 'без класса intro слоя нет вовсе');
  assert.match(layer, /pointer-events: none;/);
  assert.match(layer, /z-index: 0;/);
  assert.match(css, /html\.intro \.intro-sky \{ display: block; \}/);
});

test('анимации короче, чем живёт класс intro: ничего не обрывается на середине', () => {
  const seconds = [...css.matchAll(/html\.intro[^{]*\{[^}]*animation(?:-delay)?:[^;]*?([\d.]+)s[^;]*;/g)];
  assert.ok(seconds.length > 0);
  // занавес: 2,3 с + задержка до 0,3 с; волна: 0,7 с + до 0,72 с; заголовок: 1,8 с + 0,2 с
  const longest = Math.max(2.3 + 0.3, 0.7 + 0.72, 1.8 + 0.2);
  assert.ok(longest <= 2.6, 'самая длинная ' + longest + ' с');
  assert.match(css, /animation: intro-curtain 2\.3s/);
  for (const d of [...css.matchAll(/\.intro-sky span:nth-child\(\d\)[^}]*animation-delay: ([\d.]+)s/g)].map(m => Number(m[1]))) {
    assert.ok(d <= 0.3, 'задержка занавеса ' + d);
  }
});

test('на случай «уменьшить движение» после запуска — CSS тоже всё выключает', () => {
  const blocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map(m => m[1]).join('\n');
  assert.match(blocks, /html\.intro \.intro-sky \{ display: none; \}/);
  assert.match(blocks, /html\.intro \.topbar, html\.intro \.tabs, html\.intro \.wrap > \*, html\.intro \.topbar h1 \{ animation: none; \}/);
});
