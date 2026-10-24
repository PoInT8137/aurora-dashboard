// track.js: посещение раз за загрузку и после неё, ошибки страницы — без мусора и не больше пяти.
// Запуск: node --test tools/track.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const code = fs.readFileSync(new URL('../track.js', import.meta.url), 'utf8');

function run({ ready = 'loading', store = {}, standalone = false, nav = {} } = {}) {
  const listeners = {};
  const posts = [];
  const timers = [];
  const window = { addEventListener: (type, fn) => { listeners[type] = fn; }, matchMedia: q => ({ matches: q.includes('standalone') ? standalone : q.includes('coarse') }) };
  const sandbox = {
    window, location: { protocol: 'https:', hash: '#map' }, screen: { width: 390, height: 844 }, navigator: nav,
    document: { readyState: ready, referrer: 'https://yandex.ru/search', documentElement: { lang: 'ru' } },
    localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
    setTimeout: fn => timers.push(fn),
    fetch: (url, init) => { posts.push({ path: url.replace('https://api.test', ''), body: JSON.parse(init.body), type: init.headers['Content-Type'] }); return Promise.resolve(); },
    AURORA_CONFIG: { pushApi: 'https://api.test' }, APP_VERSION: 'v62', getLang: () => 'en'
  };
  vm.runInNewContext(code, sandbox);
  window.target = window;
  return { listeners, posts, timers, window, store };
}

test('посещение — после загрузки и паузы, один раз; первый визит отмечается', () => {
  const t = run();
  assert.equal(t.posts.length, 0);
  t.listeners.load();
  assert.equal(t.posts.length, 0, 'ждёт паузу');
  t.timers.forEach(fn => fn());
  assert.deepEqual(t.posts[0], { path: '/hit', type: 'text/plain', body: { lang: 'en', v: 'v62', fresh: true, mobile: true, pwa: false, ref: 'https://yandex.ru/search' } });
  assert.ok(t.store['aurora.seen']);

  const again = run({ ready: 'complete', store: t.store, standalone: true });
  again.timers.forEach(fn => fn());
  assert.equal(again.posts[0].body.fresh, false);
  assert.equal(again.posts[0].body.pwa, true);
});

test('ошибки: текст, файл, стек и вкладка; повторы, расширения, «Script error.» и сеть — не отправляются', () => {
  const t = run();
  const err = { name: 'TypeError', message: 'x is null', stack: 'TypeError: x is null\n at js/now.js:5:1' };
  const fire = (e) => t.listeners.error({ target: t.window, ...e });
  fire({ error: err, message: 'x is null', filename: 'https://auroramurmansk.ru/js/now.js', lineno: 5, colno: 1 });
  fire({ error: err, message: 'x is null', filename: 'https://auroramurmansk.ru/js/now.js', lineno: 5, colno: 1 });
  fire({ message: 'Script error.', filename: '', lineno: 0 });
  fire({ message: 'boom', filename: 'chrome-extension://abc/content.js', lineno: 1 });
  t.listeners.error({ target: { nodeType: 1 }, message: '' });   // картинка не загрузилась
  t.listeners.unhandledrejection({ reason: { name: 'TypeError', message: 'Failed to fetch' } });
  t.listeners.unhandledrejection({ reason: { name: 'AbortError', message: 'aborted' } });
  t.listeners.unhandledrejection({ reason: { name: 'RangeError', message: 'bad', stack: 'RangeError: bad' } });

  assert.equal(t.posts.length, 2);
  assert.deepEqual(t.posts[0].body, { msg: 'TypeError: x is null', src: 'https://auroramurmansk.ru/js/now.js', line: 5, col: 1, stack: err.stack, v: 'v62', page: '#map' });
  assert.equal(t.posts[1].body.msg, 'Promise: RangeError: bad');

  for (let i = 0; i < 10; i++) fire({ message: 'e' + i, filename: 'app.js', lineno: i });
  assert.equal(t.posts.filter(p => p.path === '/bug').length, 5, 'не больше пяти за загрузку');
});

test('робот поисковика и автоматизированный браузер — ни посещения, ни ошибок', () => {
  for (const nav of [{ userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/136.0 Safari/537.36' }, { webdriver: true, userAgent: 'Chrome/136' }]) {
    const t = run({ ready: 'complete', nav });
    t.timers.forEach(fn => fn());
    assert.equal(t.posts.length, 0);
    assert.equal(t.listeners.error, undefined);
  }
});
