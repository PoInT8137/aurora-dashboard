// Шапка: на телефоне компактная — обновление значком, язык, «Поделиться» и ночное зрение в меню.
// Запуск: node --test tools/header.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const html = read('index.html');
const css = read('styles.css');

test('разметка: язык, «Поделиться» и ночное зрение — внутри меню, кнопка меню ссылается на него', () => {
  const menu = /<div class="topbar__menu" id="topbar-menu">([\s\S]*?)\n    <\/div>/.exec(html)[1];
  for (const id of ['id="lang"', 'id="share-btn"', 'id="night-btn"']) assert.ok(menu.includes(id), id);
  assert.match(html, /id="menu-btn"[^>]*aria-expanded="false"[^>]*aria-controls="topbar-menu"/);
  assert.match(html, /id="refresh"[^>]*>.*<span class="btn__text" data-i18n="btn.refresh">/, 'подпись «Обновить» — для скринридеров и компьютера');
  for (const lang of ['ru', 'en', 'zh']) assert.match(read('lang/' + lang + '.js'), /'menu\.btn': '/);
});

test('стили: на компьютере меню «раскрыто» в строку, на телефоне — сетка шапки и выпадающая панель', () => {
  assert.match(css, /\.topbar__menu \{ display: contents; \}/);
  assert.match(css, /\.topbar \.topbar__menu-btn \{ display: none; \}/);
  const mobile = css.slice(css.indexOf('/* Телефон: компактная шапка'));
  assert.match(mobile, /grid-template-areas:\s*"title refresh menu"/);
  assert.match(mobile, /\.topbar__menu \{[^}]*display: none;[^}]*position: absolute;/);
  assert.match(mobile, /\.topbar__menu\.is-open \{ display: grid;/);
});

test('настройки на телефоне: название над переключателем, кнопки равные в одну строку, подсказка не уезжает', () => {
  const start = css.indexOf('/* Телефон: название всегда над переключателем');
  const mobile = css.slice(start, css.indexOf('\n}\n', start));
  assert.match(mobile, /\.pref \{ flex-direction: column; align-items: stretch;/);
  assert.match(mobile, /\.pref \.seg \{[^}]*grid-auto-flow: column;[^}]*grid-auto-columns: minmax\(0, 1fr\);/);
  assert.match(mobile, /\.pref \.seg__btn \{[^}]*white-space: normal;/);
  // .pref__hint задан позже с той же силой — нужен более сильный селектор
  assert.match(mobile, /\.pref \.pref__hint \{ flex-basis: auto; \}/);
});

function menuPage() {
  const handlers = {};
  const make = id => ({
    id, attrs: {}, classes: new Set(), listeners: {}, focused: false,
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; },
    addEventListener(t, fn) { this.listeners[t] = fn; }, focus() { this.focused = true; },
    classList: null
  });
  const els = { 'menu-btn': make('menu-btn'), 'topbar-menu': make('topbar-menu') };
  els['topbar-menu'].classList = { toggle: (c, on) => (on ? els['topbar-menu'].classes.add(c) : els['topbar-menu'].classes.delete(c)) };
  els['menu-btn'].attrs['aria-expanded'] = 'false';
  const ctx = { $: id => els[id], document: { addEventListener: (t, fn) => { handlers[t] = fn; } } };
  const src = read('js/page.js');
  const code = ['setTopMenu', 'topMenuOpen', 'initTopMenu'].map(n => new RegExp('function ' + n + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}').exec(src)[0]).join('\n');
  vm.runInNewContext(code + '; initTopMenu();', ctx);
  const target = inside => ({ closest: sel => (sel === inside ? {} : null) });
  const open = () => els['topbar-menu'].classes.has('is-open');
  return { els, handlers, target, open };
}

test('меню: кнопка открывает и закрывает; выбор пункта, клик мимо и Escape закрывают', () => {
  const { els, handlers, target, open } = menuPage();
  const btn = els['menu-btn'];
  btn.listeners.click();
  assert.equal(open(), true);
  assert.equal(btn.attrs['aria-expanded'], 'true');
  handlers.click({ target: target('#topbar-menu') });
  assert.equal(open(), true, 'клик внутри меню не закрывает');
  els['topbar-menu'].listeners.click({ target: target('button') });
  assert.equal(open(), false, 'выбрали пункт — меню закрылось');

  btn.listeners.click();
  handlers.click({ target: target('.card') });
  assert.equal(open(), false, 'клик мимо');

  btn.listeners.click();
  handlers.keydown({ key: 'Escape' });
  assert.equal(open(), false);
  assert.equal(btn.focused, true, 'фокус вернулся на кнопку меню');
});
