// Ярлыки установленного приложения (manifest.json → shortcuts) и ?theme=night для «Ночного зрения».
// Запуск: node --test tools/shortcuts.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { loadApp } from './app-sandbox.mjs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const html = read('index.html');

test('ярлыки: три, внутри области приложения, короткие подписи, значки есть в репозитории', () => {
  const list = manifest.shortcuts;
  assert.equal(list.length, 3);
  for (const s of list) {
    assert.ok(s.url.startsWith(manifest.scope), s.url);
    assert.ok(s.short_name.length <= 14, 'короткая подпись под значком: ' + s.short_name);
    assert.ok(s.name && s.description);
    for (const icon of s.icons) assert.ok(fs.existsSync(new URL('../' + icon.src, import.meta.url)), icon.src);
  }
});

test('ярлыки ведут на существующие вкладки; адрес вкладки важнее стартовой настройки', () => {
  const tabs = [...html.matchAll(/data-tab="(\w+)"/g)].map(m => m[1]);
  for (const s of manifest.shortcuts) {
    const hash = s.url.split('#')[1];
    assert.ok(tabs.includes(hash), hash);
  }
  const { ctx } = page();
  ctx.setSetting('start', 'now');
  assert.equal(ctx.startTab('map', 'now'), 'map');
});

function page(search = '') {
  const elements = new Map();
  const replaced = [];
  const ctx = loadApp([['config.js', read('config.js')], ['core.js', read('core.js')], ['push.js', read('push.js')], ['app.js', read('app.js')]],
    { now: Date.parse('2026-12-15T19:00:00Z'), getElement: id => { if (!elements.has(id)) elements.set(id, { setAttribute() {}, attrs: {} }); return elements.get(id); } });
  ctx.location.search = search;
  ctx.location.pathname = '/';
  ctx.location.hash = '#now';
  ctx.history.replaceState = (a, b, url) => replaced.push(url);
  return { ctx, replaced };
}

test('?theme=night: включает ночное зрение, запоминает прежнюю тему и убирает параметр из адреса', () => {
  const { ctx, replaced } = page('?lang=en&theme=night');
  ctx.setSetting('theme', 'light');
  assert.equal(ctx.themeFromUrl(), true);
  assert.equal(ctx.setting('theme'), 'night');
  assert.equal(ctx.localStorage.getItem('aurora.dayTheme'), 'light', 'кнопка в шапке вернёт светлую');
  assert.deepEqual(replaced, ['/?lang=en#now']);

  const first = page('?theme=night&lang=zh');
  first.ctx.themeFromUrl();
  assert.deepEqual(first.replaced, ['/?lang=zh#now']);
  const only = page('?theme=night');
  only.ctx.themeFromUrl();
  assert.deepEqual(only.replaced, ['/#now']);

  const none = page('?lang=en');
  assert.equal(none.ctx.themeFromUrl(), false);
  assert.deepEqual(none.replaced, []);
  assert.equal(none.ctx.setting('theme'), 'dark');
});

test('встроенный скрипт применяет ?theme=night до первой отрисовки, даже поверх сохранённой темы', () => {
  const head = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const run = (search, saved) => {
    const root = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
    vm.runInContext(head, vm.createContext({
      localStorage: { getItem: () => JSON.stringify(saved) }, document: { documentElement: root },
      matchMedia: () => ({ matches: false }), JSON, location: { search }
    }));
    return root.attrs['data-theme'];
  };
  assert.equal(run('?theme=night', { theme: 'light' }), 'night');
  assert.equal(run('?theme=nightly', { theme: 'light' }), 'light', 'только точное значение');
  assert.equal(run('', { theme: 'light' }), 'light');
});

test('манифест в оболочке service worker, чтобы ярлыки работали офлайн', () => {
  assert.match(read('sw.js'), /'manifest\.json'/);
});
