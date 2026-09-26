// Панель вкладок: на телефоне листается вбок, выбранная вкладка доезжает до середины.
// Запуск: node --test tools/tabs.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadApp } from './app-sandbox.mjs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const css = read('styles.css');
const html = read('index.html');

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

test('стили: на узком экране панель — пять равных ячеек без прокрутки, над полоской Home (жест iPhone не мешает)', () => {
  const mobile = /@media \(max-width: 719px\) \{\s*\.tabs \{[\s\S]*?\n\}/.exec(css)[0];
  assert.match(mobile, /grid-template-columns: repeat\(5, minmax\(0, 1fr\)\);/);
  assert.match(mobile, /overflow: hidden;/);
  assert.doesNotMatch(mobile, /overflow-x: auto|scroll-snap/, 'горизонтальная прокрутка у нижнего края конфликтует с жестом iPhone');
  assert.match(mobile, /calc\(6px \+ env\(safe-area-inset-bottom, 0px\)\)/);
  assert.match(mobile, /\.tabs__title \{[^}]*text-overflow: ellipsis;/);
  assert.match(mobile, /\.tabs__icon \{[^}]*display: block;/);
  // без viewport-fit=cover iPhone не сообщает отступ полоски Home — панель стояла бы в зоне жеста
  assert.match(html, /<meta name="viewport" content="[^"]*viewport-fit=cover/);
  assert.match(css, /body \{[^}]*padding-top: env\(safe-area-inset-top, 0px\);/);
  // у каждой вкладки значок, скрытый от скринридеров (подпись уже есть)
  const icons = [...html.matchAll(/<button class="tabs__btn"[^>]*>\s*<svg class="tabs__icon"[^>]*aria-hidden="true"/g)];
  assert.equal(icons.length, 5);
});
