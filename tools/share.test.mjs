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
      el.getContext = () => ({
        set fillStyle(v) { el.ops.push(['style', v]); },
        fillRect: (...a) => el.ops.push(['rect', ...a]),
        createLinearGradient: (...a) => ({ gradient: a, stops: [], addColorStop(o, c) { this.stops.push([o, c]); } }),
        beginPath: () => el.ops.push(['begin']),
        roundRect: (...a) => el.ops.push(['round', ...a]),
        fill: rule => el.ops.push(['fill', rule]),
        fillText: (...a) => el.ops.push(['text', ...a])
      });
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

test('SVG: белый фон с тихой зоной в 4 модуля, три «глазка» и по скруглённому модулю на каждый тёмный', () => {
  const { ctx } = page();
  const m = ctx.qrMatrix('https://auroramurmansk.ru/?lang=ru');
  const svg = ctx.qrSvg(m, 'QR-код ссылки "x" <y>');
  const n = m.length, size = n + 8;
  assert.match(svg, new RegExp(`viewBox="0 0 ${size} ${size}"`));
  assert.match(svg, /<rect width="\d+" height="\d+" fill="#fff"\/>/);
  assert.match(svg, /fill="url\(#qr-ink\)" fill-rule="evenodd"/);

  // тёмные модули вне трёх поисковых узоров 7×7 — каждый своим квадратиком
  const inEye = (r, c) => [[0, 0], [0, n - 7], [n - 7, 0]].some(([er, ec]) => r >= er && r < er + 7 && c >= ec && c < ec + 7);
  let dots = 0;
  m.forEach((row, r) => row.forEach((dark, c) => { if (dark && !inEye(r, c)) dots++; }));
  const shapes = svg.match(/M[\d.]+ [\d.]+h/g).length;
  assert.equal(shapes, dots + 3 * 3, 'у каждого «глазка» три контура: рамка, её вырез и центр');
  assert.match(svg, /M6 4h3a2 2 0 0 1 2 2/, 'левый верхний «глазок» — сразу за тихой зоной');
  assert.match(svg, /aria-label="QR-код ссылки x y"/, 'кавычки и угловые скобки из подписи убраны');
});

test('стили: код квадратный сам по себе, рамка по нему — без height: 100% (Safari на iPhone растягивал код)', () => {
  const css = read('styles.css');
  const frame = /\n\.share__qr \{[^}]*\}/.exec(css)[0];
  const svg = /\n\.share__qr svg \{[^}]*\}/.exec(css)[0];
  assert.doesNotMatch(frame, /aspect-ratio/);
  assert.match(svg, /height: auto;/);
  assert.match(svg, /aspect-ratio: 1;/);
  assert.doesNotMatch(svg, /height: 100%/);
});

test('цвет кода тёмный: контраст каждого оттенка с белым фоном не ниже 6:1', () => {
  const { ctx } = page();
  const lum = hex => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  for (const [, color] of ctx.QR_INK) assert.ok(1.05 / (lum(color) + 0.05) >= 6, color);
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
  assert.equal(shared.title, 'Мурманск — прогноз северного сияния');

  const cancelled = page({ navigator: { share: async () => { throw new DOMException('cancel', 'AbortError'); } } });
  await assert.doesNotReject(() => cancelled.ctx.nativeShare());
});

test('PNG для печати: белый фон, «глазки» и модули как на экране, адрес под тихой зоной, имя файла с языком', async () => {
  const { ctx, el, created } = page();
  vm.runInContext("location.host = 'auroramurmansk.ru';", ctx);
  el('share-dialog').showModal = () => {};
  ctx.setLang('zh');
  await ctx.openShare();
  ctx.downloadQrPng();
  const canvas = created.find(e => e.tag === 'canvas');
  const link = created.find(e => e.tag === 'a');
  const m = ctx.state.shareMatrix, n = m.length, size = (n + 8) * 12;
  assert.equal(canvas.width, size);
  assert.equal(canvas.height, size + 36, 'снизу полоса под подпись');
  assert.deepEqual(canvas.ops.slice(0, 2), [['style', '#fff'], ['rect', 0, 0, size, size + 36]]);
  const rounds = canvas.ops.filter(o => o[0] === 'round').length;
  const dots = ctx.qrShapes(m).dots.length;
  assert.equal(rounds, 9 + dots);
  assert.ok(canvas.ops.some(o => o[0] === 'fill' && o[1] === 'evenodd'), 'вырез в рамке «глазка»');
  const text = canvas.ops.find(o => o[0] === 'text');
  assert.equal(text[1], 'auroramurmansk.ru');
  assert.ok(text[3] > size - 12 && text[3] < size + 36, 'подпись ниже кода и тихой зоны');
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
