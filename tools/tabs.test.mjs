// Панель вкладок: на телефоне листается вбок, выбранная вкладка доезжает до середины.
// Запуск: node --test tools/tabs.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadApp } from './app-sandbox.mjs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const css = read('styles.css');

function app(bar) {
  const ctx = loadApp([['config.js', read('config.js')], ['core.js', read('core.js')], ['push.js', read('push.js')], ['app.js', read('app.js')]],
    { getElement: id => (id === 'tabs' ? bar : null) });
  return ctx;
}

/** Панель шириной clientWidth с прокруткой и кнопка на позиции offsetLeft. */
const bar = (clientWidth, scrollWidth) => ({ clientWidth, scrollWidth, calls: [], scrollTo(o) { this.calls.push(o); } });

test('выбранная вкладка доезжает до середины панели', () => {
  const b = bar(375, 520);
  app(b).revealTab({ offsetLeft: 300, offsetWidth: 90 });
  assert.deepEqual(JSON.parse(JSON.stringify(b.calls)), [{ left: 300 - (375 - 90) / 2, behavior: 'smooth' }]);
});

test('у левого края прокрутка не уходит в минус; если всё помещается — панель не трогаем', () => {
  const b = bar(375, 520);
  app(b).revealTab({ offsetLeft: 10, offsetWidth: 80 });
  assert.equal(b.calls[0].left, 0);

  const wide = bar(1000, 1000);
  app(wide).revealTab({ offsetLeft: 600, offsetWidth: 200 });
  assert.deepEqual(wide.calls, [], 'на широком экране всё видно, прокручивать нечего');
});

test('без поддержки scrollTo ничего не ломается', () => {
  assert.doesNotThrow(() => app({ clientWidth: 375, scrollWidth: 600 }).revealTab({ offsetLeft: 300, offsetWidth: 90 }));
  assert.doesNotThrow(() => app(null).revealTab({ offsetLeft: 300, offsetWidth: 90 }));
});

test('стили: на узком экране панель прокручивается вбок, кнопки не сжимаются и не переносят подпись', () => {
  const mobile = /@media \(max-width: 719px\) \{\s*\.tabs \{[\s\S]*?\n\}/.exec(css)[0];
  assert.match(mobile, /overflow-x: auto;/);
  assert.match(mobile, /scroll-snap-type: x proximity;/);
  assert.match(mobile, /scrollbar-width: none;/);
  assert.match(mobile, /\.tabs__btn \{[^}]*flex: 0 0 auto;[^}]*white-space: nowrap;[^}]*scroll-snap-align: center;/);
  assert.match(mobile, /mask-image: linear-gradient/);
});
