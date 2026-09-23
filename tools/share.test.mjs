// «Поделиться»: ссылка на выбранном языке, QR-код, копирование, системное меню, PNG для печати.
// Запуск: node --test tools/share.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { loadApp } from './app-sandbox.mjs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');

const element = () => ({
  textContent: '', hidden: false, disabled: false, className: '', innerHTMLValue: '',
  style: { setProperty(k, v) { this[k] = v; } },
  children: [], attrs: {}, listeners: {},
  setAttribute(k, v) { this.attrs[k] = String(v); },
  getAttribute(k) { return this.attrs[k] ?? null; },
  removeAttribute(k) { delete this.attrs[k]; },
  addEventListener(type, fn) { this.listeners[type] = fn; },
  querySelector() { return element(); },
  querySelectorAll() { return []; },
  appendChild(child) { this.children.push(child); return child; },
  set innerHTML(value) { this.innerHTMLValue = value; if (value === '') this.children = []; },
  get innerHTML() { return this.innerHTMLValue; }
});

/** Страница с загруженной библиотекой QR (как после первого открытия окна). */
function page({ withLib = true, navigator = {} } = {}) {
  const elements = new Map();
  const getElement = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const created = [];
  const createElement = tag => {
    const el = element();
    el.tag = tag;
    if (tag === 'canvas') {
      el.ops = [];
      el.getContext = () => ({ set fillStyle(v) { el.ops.push(['style', v]); }, fillRect: (...a) => el.ops.push(['rect', ...a]) });
      el.toDataURL = type => 'data:' + type + ';base64,AAAA';
    }
    if (tag === 'a') el.click = () => { el.clicked = true; };
    created.push(el);
    return el;
  };
  const sources = [['config.js', read('config.js')], ['core.js', read('core.js')], ['push.js', read('push.js')]];
  if (withLib) sources.push(['vendor/qrcode.js', read('vendor/qrcode.js')]);
  sources.push(['app.js', read('app.js')]);
  const ctx = loadApp(sources, { now: Date.parse('2026-12-15T18:00:00Z'), getElement, createElement });
  vm.runInContext("location.origin = 'https://auroramurmansk.ru'; location.pathname = '/';", ctx);
  Object.assign(ctx.navigator, navigator);
  ctx.state.point = ctx.findPoint('murmansk');
  return { ctx, el: getElement, created };
}

test('ссылка открывает сайт на выбранном языке', () => {
  const { ctx } = page();
  assert.equal(ctx.shareUrl('zh'), 'https://auroramurmansk.ru/?lang=zh');
  assert.equal(ctx.shareUrl('en'), 'https://auroramurmansk.ru/?lang=en');
});

test('ссылка из окна действительно переключает язык: адрес ?lang= разбирается как надо', () => {
  const { ctx } = page();
  for (const lang of ['ru', 'en', 'zh']) {
    vm.runInContext(`location.search = ${JSON.stringify(new URL(ctx.shareUrl(lang)).search)}`, ctx);
    assert.equal(ctx.langFromUrl(), lang);
  }
});

test('QR-матрица: квадратная, версии 2–4 для нашей ссылки, три поисковых узора по углам', () => {
  const { ctx } = page();
  const m = ctx.qrMatrix(ctx.shareUrl('zh'));
  const n = m.length;
  assert.ok([25, 29, 33].includes(n), 'модулей ' + n);
  assert.ok(m.every(row => row.length === n));
  // поисковый узор 7×7: тёмная рамка, светлое кольцо, тёмный центр 3×3
  const finder = (r0, c0) => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const ring = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        assert.equal(m[r0 + r][c0 + c], ring || core, `узор (${r0},${c0}) клетка ${r},${c}`);
      }
    }
  };
  finder(0, 0);
  finder(0, n - 7);
  finder(n - 7, 0);
});

test('QR для разных языков разный, для одинаковых — одинаковый', () => {
  const { ctx } = page();
  const s = lang => JSON.stringify(ctx.qrMatrix(ctx.shareUrl(lang)));
  assert.equal(s('en'), s('en'));
  assert.notEqual(s('en'), s('zh'));
});

test('SVG: белый фон с тихой зоной в 4 модуля и по квадратику на тёмный модуль', () => {
  const { ctx } = page();
  const m = ctx.qrMatrix('https://auroramurmansk.ru/?lang=ru');
  const svg = ctx.qrSvg(m, 'QR-код ссылки "x" <y>');
  const size = m.length + 8;
  assert.match(svg, new RegExp(`viewBox="0 0 ${size} ${size}"`));
  assert.match(svg, /<rect width="\d+" height="\d+" fill="#fff"\/>/);
  const dark = m.flat().filter(Boolean).length;
  assert.equal((svg.match(/h1v1h-1z/g) || []).length, dark);
  assert.match(svg, /aria-label="QR-код ссылки x y"/, 'кавычки и угловые скобки из подписи убраны');
  assert.match(svg, /M4 4h1v1h-1z/, 'левый верхний модуль узора — сразу за тихой зоной');
});

test('открытие окна: язык по умолчанию — язык страницы, QR и ссылка на месте', async () => {
  const { ctx, el } = page();
  ctx.setLang('en');
  el('share-dialog').showModal = function () { this.opened = true; };
  await ctx.openShare();
  assert.equal(el('share-dialog').opened, true);
  assert.equal(el('share-url').textContent, 'https://auroramurmansk.ru/?lang=en');
  assert.match(el('share-qr').innerHTML, /^<svg /);
  assert.match(el('share-qr').innerHTML, /aria-label="QR code for https:\/\/auroramurmansk\.ru\/\?lang=en"/);
});

test('смена языка в окне меняет ссылку и QR, язык страницы не трогает', async () => {
  const { ctx, el } = page();
  el('share-dialog').showModal = () => {};
  await ctx.openShare();
  const before = el('share-qr').innerHTML;
  ctx.initShare();
  await el('share-lang').listeners.click({ target: { closest: () => ({ getAttribute: () => 'zh' }) } });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(el('share-url').textContent, 'https://auroramurmansk.ru/?lang=zh');
  assert.notEqual(el('share-qr').innerHTML, before);
  assert.equal(ctx.getLang(), 'ru');
});

test('без dialog.showModal окно всё равно открывается', async () => {
  const { ctx, el } = page();
  await ctx.openShare();
  assert.equal(el('share-dialog').attrs.open, '');
});

test('копирование: успех и отказ буфера обмена объясняются словами', async () => {
  let copied = null;
  const ok = page({ navigator: { clipboard: { writeText: async text => { copied = text; } } } });
  ok.ctx.state.shareLang = 'zh';
  await ok.ctx.copyShareUrl();
  assert.equal(copied, 'https://auroramurmansk.ru/?lang=zh');
  assert.equal(ok.el('share-status').textContent, 'Ссылка скопирована.');

  const denied = page({ navigator: { clipboard: { writeText: async () => { throw new Error('нет доступа'); } } } });
  await denied.ctx.copyShareUrl();
  assert.match(denied.el('share-status').textContent, /^Не удалось скопировать/);

  const none = page();
  await none.ctx.copyShareUrl();
  assert.match(none.el('share-status').textContent, /^Не удалось скопировать/);
});

test('системное меню «Отправить…»: кнопка только там, где оно есть; отмена не пугает ошибкой', async () => {
  const without = page();
  without.el('share-dialog').showModal = () => {};
  await without.ctx.openShare();
  assert.equal(without.el('share-native').hidden, true);

  let shared = null;
  const withShare = page({ navigator: { share: async data => { shared = data; } } });
  withShare.el('share-dialog').showModal = () => {};
  await withShare.ctx.openShare();
  assert.equal(withShare.el('share-native').hidden, false);
  await withShare.ctx.nativeShare();
  assert.equal(shared.url, 'https://auroramurmansk.ru/?lang=ru');
  assert.equal(shared.title, 'Мурманск · Северное сияние');

  const cancelled = page({ navigator: { share: async () => { throw new DOMException('cancel', 'AbortError'); } } });
  await assert.doesNotReject(() => cancelled.ctx.nativeShare());
});

test('PNG для печати: белый фон, по квадрату на тёмный модуль, имя файла с языком', async () => {
  const { ctx, el, created } = page();
  el('share-dialog').showModal = () => {};
  ctx.setLang('zh');
  await ctx.openShare();
  ctx.downloadQrPng();
  const canvas = created.find(e => e.tag === 'canvas');
  const link = created.find(e => e.tag === 'a');
  const n = ctx.state.shareMatrix.length;
  assert.equal(canvas.width, (n + 8) * 12);
  assert.deepEqual(canvas.ops.slice(0, 2), [['style', '#fff'], ['rect', 0, 0, (n + 8) * 12, (n + 8) * 12]]);
  assert.equal(canvas.ops.filter(o => o[0] === 'rect').length - 1, ctx.state.shareMatrix.flat().filter(Boolean).length);
  assert.equal(link.download, 'aurora-murmansk-qr-zh.png');
  assert.equal(link.href, 'data:image/png;base64,AAAA');
  assert.equal(link.clicked, true);
});

test('библиотека QR не загрузилась: ссылка есть, объяснение есть, скачивать нечего', async () => {
  const { ctx, el, created } = page({ withLib: false });
  el('share-dialog').showModal = () => {};
  const opening = ctx.openShare();
  const script = created.find(e => e.tag === 'script');
  assert.equal(script.src, 'vendor/qrcode.js', 'подгружается при первом открытии');
  script.onerror();
  await opening;
  assert.equal(el('share-url').textContent, 'https://auroramurmansk.ru/?lang=ru');
  assert.equal(el('share-status').textContent, 'QR-код не загрузился — ссылка выше работает и без него.');
  ctx.downloadQrPng();
  assert.ok(!created.some(e => e.tag === 'canvas'));
});

test('библиотека лежит в оболочке service worker (офлайн), в разметке — кнопка и окно', () => {
  assert.match(read('sw.js'), /'vendor\/qrcode\.js'/);
  const html = read('index.html');
  assert.match(html, /id="share-btn"[^>]*aria-haspopup="dialog"/);
  assert.match(html, /<dialog class="share" id="share-dialog" aria-labelledby="share-title">/);
  assert.doesNotMatch(html, /src="vendor\/qrcode\.js"/, 'в страницу сразу не подключается — только по требованию');
  assert.match(read('vendor/qrcode.js'), /Licensed under the MIT license/);
});
