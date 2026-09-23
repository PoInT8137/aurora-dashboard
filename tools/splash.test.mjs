// Заставка первого визита: решение в <head>, язык и тексты, кадр сияния, пропуск, завершение, стили.
// Запуск: node --test tools/splash.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const html = read('index.html');
const css = read('styles.css');
const code = read('splash.js');

/* ---------------- решение в <head> ---------------- */

const headScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => /aurora\.splash/.test(s));

function decide({ seen = false, reduced = false, throws = false } = {}) {
  const local = new Map(seen ? [['aurora.splash', '1']] : []);
  const session = new Map();
  const classes = new Set();
  const store = map => ({
    getItem: k => { if (throws) throw new Error('заблокировано'); return map.get(k) ?? null; },
    setItem: (k, v) => { if (throws) throw new Error('заблокировано'); map.set(k, v); }
  });
  vm.runInContext(headScript, vm.createContext({
    localStorage: store(local), sessionStorage: store(session),
    matchMedia: q => ({ matches: q.includes('reduce') && reduced }),
    document: { documentElement: { classList: { add: c => classes.add(c) } } }
  }));
  return { classes, local, session };
}

test('первый визит: заставка, флаг на устройство и лёгкое интро в этот раз отключено', () => {
  const { classes, local, session } = decide();
  assert.ok(classes.has('has-splash'));
  assert.equal(local.get('aurora.splash'), '1');
  assert.equal(session.get('aurora.intro'), '1', 'чтобы не было двух анимаций подряд');
});

test('повторный визит — заставки нет, интро остаётся как было', () => {
  const { classes, session } = decide({ seen: true });
  assert.ok(!classes.has('has-splash'));
  assert.equal(session.size, 0);
});

test('«уменьшить движение» — заставки нет и флаг не ставится (включат анимацию — увидят её)', () => {
  const { classes, local } = decide({ reduced: true });
  assert.ok(!classes.has('has-splash'));
  assert.equal(local.size, 0);
});

test('хранилище недоступно — без заставки: иначе она шла бы при каждом визите', () => {
  assert.doesNotThrow(() => decide({ throws: true }));
  assert.ok(!decide({ throws: true }).classes.has('has-splash'));
});

test('решение принимается в <head> до лёгкого интро и до первой отрисовки; скрипт заставки — сразу после её разметки', () => {
  const head = html.slice(0, html.indexOf('</head>'));
  assert.ok(head.includes(headScript));
  assert.ok(head.indexOf('aurora.splash') < head.indexOf("classList.add('intro')"));
  const body = html.slice(html.indexOf('<body>'));
  assert.ok(body.indexOf('id="splash"') < body.indexOf('src="splash.js"'));
  assert.ok(body.indexOf('src="splash.js"') < body.indexOf('class="topbar"'), 'до дашборда — чтобы стартовать сразу');
});

/* ---------------- splash.js ---------------- */

function lib(extra = {}) {
  const ctx = vm.createContext({ Math, String, Number, parseInt, ...extra });
  vm.runInContext(code.replace('window.auroraSplash = startSplash();', ''), ctx);
  return ctx;
}

test('язык — по тем же правилам, что у сайта (detectLang): адрес, выбор, браузер, английский', () => {
  const s = lib();
  const i18n = vm.createContext({});
  vm.runInContext(read('i18n.js'), i18n);
  const cases = [
    ['?lang=zh', 'en', ['ru']], ['?x=1&lang=EN', null, ['zh-CN']], ['', 'ru', ['en-US']], ['', null, ['zh-Hans-CN']],
    ['', null, ['fr-FR', 'de']], ['', null, []], ['?lang=klingon', 'xx', ['ru-RU']], ['', null, undefined]
  ];
  for (const [search, saved, langs] of cases) {
    const m = /[?&]lang=([a-zA-Z-]+)/.exec(search);
    const fromUrl = m ? vm.runInContext(`langFromTag(${JSON.stringify(m[1])})`, i18n) : null;
    const want = vm.runInContext(`detectLang(${JSON.stringify(fromUrl)}, ${JSON.stringify(saved)}, ${JSON.stringify(langs)})`, i18n);
    assert.equal(s.splashLang(search, saved, langs), want, JSON.stringify([search, saved, langs]));
  }
});

test('тексты заставки совпадают со словарями сайта; «Пропустить» переведён', () => {
  const s = lib();
  const ctx = vm.createContext({});
  vm.runInContext(read('i18n.js'), ctx);
  for (const code of ['ru', 'en', 'zh']) vm.runInContext(read(`lang/${code}.js`), ctx);
  const dicts = JSON.parse(vm.runInContext('JSON.stringify(i18nDicts)', ctx));
  for (const code of ['ru', 'en', 'zh']) {
    assert.equal(s.SPLASH_TEXT[code].title, dicts[code]['app.title'], code);
    assert.equal(s.SPLASH_TEXT[code].region, dicts[code]['app.region'], code);
    assert.ok(s.SPLASH_TEXT[code].skip, code);
  }
  assert.doesNotMatch(s.SPLASH_TEXT.en.skip + s.SPLASH_TEXT.zh.skip, /[А-Яа-я]/);
});

test('цвета берутся из темы (#rrggbb), мусор — запасной цвет', () => {
  const s = lib();
  assert.deepEqual([...s.splashRgb(' #4dffb8 ', [0, 0, 0])], [77, 255, 184]);
  assert.deepEqual([...s.splashRgb('rgb(1,2,3)', [9, 9, 9])], [9, 9, 9]);
  assert.deepEqual([...s.splashRgb('', [9, 9, 9])], [9, 9, 9]);
});

test('сияние нарастает с 0,3 до 1,3 с; до этого кадр пустой', () => {
  const s = lib();
  assert.equal(s.splashEnvelope(0), 0);
  assert.equal(s.splashEnvelope(0.3), 0);
  assert.ok(Math.abs(s.splashEnvelope(0.8) - 0.5) < 1e-9);
  assert.equal(s.splashEnvelope(1.3), 1);
  assert.equal(s.splashEnvelope(3), 1);
});

/** Холст-заглушка, считающий вызовы. */
function fakeCtx() {
  const calls = { drawImage: 0, clearRect: 0 };
  return {
    calls, globalAlpha: 1, globalCompositeOperation: 'source-over',
    clearRect() { calls.clearRect++; },
    drawImage(img, x, y, w, h) { calls.drawImage++; calls.last = { x, y, w, h, alpha: this.globalAlpha, op: this.globalCompositeOperation }; }
  };
}

test('кадр: по столбику на колонку каждой ленты, не больше; сложение света; прозрачность в пределах', () => {
  const s = lib();
  const ctx = fakeCtx();
  const w = 94, h = 203;   // телефон 375×812 при уменьшении в 4 раза
  const drawn = s.splashFrame(ctx, w, h, 2, [{}, {}, {}]);
  assert.equal(drawn, ctx.calls.drawImage);
  assert.ok(drawn <= w * 3 && drawn > w, 'столбиков ' + drawn);
  assert.equal(ctx.calls.clearRect, 1);
  assert.equal(ctx.calls.last.op, 'lighter');
  assert.ok(ctx.calls.last.alpha > 0 && ctx.calls.last.alpha <= 1);
  assert.equal(ctx.globalAlpha, 1, 'после кадра прозрачность возвращена');

  const early = fakeCtx();
  assert.equal(s.splashFrame(early, w, h, 0.1, [{}, {}, {}]), 0);
  assert.equal(early.calls.drawImage, 0);
});

test('ленты не уходят за экран: верх и низ столбиков внутри холста', () => {
  const s = lib();
  const w = 120, h = 200;
  for (const t of [0.5, 1, 1.7, 2.4, 3.3]) {
    const ctx = fakeCtx();
    ctx.drawImage = (img, x, y, cw, ch) => { assert.ok(y >= 0 && y + ch <= h, `t=${t}: ${y}..${y + ch}`); };
    s.splashFrame(ctx, w, h, t, [{}, {}, {}]);
  }
});

test('звёзды: число — по площади экрана, выше гуще', () => {
  const s = lib();
  const dots = [];
  const canvas = { getContext: () => ({ beginPath() {}, arc(x, y) { dots.push(y); }, fill() {} }) };
  let seed = 1;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const count = s.splashStars(canvas, 375, 812, 2, random);
  assert.equal(count, Math.round(375 * 812 / 5200));
  assert.equal(canvas.width, 750);
  const upper = dots.filter(y => y < canvas.height * 0.3).length;
  assert.ok(upper > dots.length / 2, 'в верхней трети больше половины звёзд');
});

/* ---------------- жизненный цикл ---------------- */

function element(id) {
  return {
    id, textContent: '', listeners: {}, classes: new Set(), style: { props: {}, setProperty(k, v) { this.props[k] = v; } },
    classList: { add(c) { this.owner.classes.add(c); }, remove(c) { this.owner.classes.delete(c); }, contains(c) { return this.owner.classes.has(c); } },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    getContext: () => ({ ...fakeCtx(), createLinearGradient: () => ({ addColorStop() {} }), fillRect() {}, beginPath() {}, arc() {}, fill() {} }),
    focus() { this.focused = true; }
  };
}

function world({ splash = true, lang = null, languages = ['ru-RU'] } = {}) {
  const els = {};
  const byId = id => {
    if (!els[id]) { els[id] = element(id); els[id].classList.owner = els[id]; }
    return els[id];
  };
  const root = element('html');
  root.classList.owner = root;
  root.attrs = {};
  root.setAttribute = (k, v) => { root.attrs[k] = v; };
  if (splash) root.classes.add('has-splash');
  const docListeners = {};
  const document = {
    documentElement: root, visibilityState: 'visible',
    getElementById: byId,
    createElement: () => element('canvas'),
    addEventListener: (type, fn) => { docListeners[type] = fn; },
    removeEventListener: (type) => { delete docListeners[type]; }
  };
  const timers = [];
  const frames = [];
  let clock = 0;
  const ctx = lib({
    document, location: { search: '' }, navigator: { languages }, innerWidth: 375, innerHeight: 812,
    window: { devicePixelRatio: 3 },
    localStorage: { getItem: () => lang },
    getComputedStyle: () => ({ getPropertyValue: () => '' })
  });
  const env = {
    now: () => clock,
    raf: fn => frames.push(fn),
    setTimeout: (fn, ms) => timers.push({ fn, ms })
  };
  const splashObj = ctx.startSplash(env);
  return {
    splash: splashObj, root, byId, timers, frames, docListeners, document,
    advance(ms) { clock += ms; const run = frames.splice(0); run.forEach(f => f()); }
  };
}

test('без класса splash (повторный визит) — ничего не делает', () => {
  const w = world({ splash: false });
  assert.equal(w.splash, null);
  assert.equal(w.frames.length, 0);
});

test('язык и тексты заставки ставятся сразу; кнопка «Пропустить» в фокусе', () => {
  const w = world({ languages: ['zh-CN'] });
  assert.equal(w.byId('splash-title').textContent, '北极光');
  assert.equal(w.byId('splash-skip').textContent, '跳过');
  assert.equal(w.root.attrs.lang, 'zh-CN');
  assert.equal(w.byId('splash-skip').focused, true, 'Enter и пробел сразу пропускают');
});

test('полная версия: кадры идут, в 2,8 с плавное исчезновение 0,6 с, затем класс снят — итого 3,4 с', () => {
  const w = world();
  for (let i = 0; i < 10; i++) w.advance(16);
  assert.equal(w.splash.frames, 10);
  const auto = w.timers.find(t => t.ms === 2800);
  assert.ok(auto, 'исчезновение назначено на 2,8 с');
  auto.fn();
  assert.ok(w.byId('splash').classes.has('splash--out'));
  assert.equal(w.byId('splash').style.props['--splash-fade'], '600ms');
  assert.ok(w.root.classes.has('has-splash'), 'пока идёт переход, слой ещё на месте');
  w.timers.find(t => t.ms === 600).fn();
  assert.ok(!w.root.classes.has('has-splash'));
  assert.equal(w.docListeners.keydown, undefined, 'обработчики сняты');
  assert.ok(2800 + 600 <= 4000);
});

test('после завершения кадров больше нет — процессор не тратится зря', () => {
  const w = world();
  w.advance(16);
  w.splash.finish(true);
  const before = w.splash.frames;
  w.advance(16);
  w.advance(16);
  assert.equal(w.splash.frames, before);
  assert.equal(w.frames.length, 0);
});

test('пропуск: клик или тап в любом месте, Esc — быстрое исчезновение 0,25 с; повторный пропуск безвреден', () => {
  for (const how of ['click', 'esc']) {
    const w = world();
    if (how === 'click') w.byId('splash').listeners.click();
    else w.docListeners.keydown({ key: 'Escape' });
    assert.equal(w.byId('splash').style.props['--splash-fade'], '250ms', how);
    w.byId('splash').listeners.click();
    assert.equal(w.timers.filter(t => t.ms === 250).length, 1, how + ': второй пропуск ничего не добавил');
    w.timers.find(t => t.ms === 250).fn();
    assert.ok(!w.root.classes.has('has-splash'), how);
  }
  const other = world();
  other.docListeners.keydown({ key: 'Enter' });
  assert.ok(!other.byId('splash').classes.has('splash--out'), 'другие клавиши не пропускают (Enter жмёт саму кнопку)');
});

test('кнопка «Пропустить» внутри слоя: её нажатие — тот же клик по заставке', () => {
  const w = world();
  assert.ok(html.includes('<button class="btn splash__skip" type="button" id="splash-skip">'));
  w.byId('splash').listeners.click();
  assert.ok(w.byId('splash').classes.has('splash--out'));
});

test('вкладку свернули — сразу к дашборду, без кадров в фоне', () => {
  const w = world();
  w.document.visibilityState = 'hidden';
  w.docListeners.visibilitychange();
  assert.ok(w.byId('splash').classes.has('splash--out'));
});

test('прокрутка под заставкой заблокирована, чтобы страница под ней не уехала', () => {
  const w = world();
  let prevented = 0;
  w.byId('splash').listeners.wheel({ preventDefault: () => prevented++ });
  w.byId('splash').listeners.touchmove({ preventDefault: () => prevented++ });
  assert.equal(prevented, 2);
});

test('заставка не связана с загрузкой данных: ни запросов, ни ожиданий в splash.js, приложение её не ждёт', () => {
  assert.doesNotMatch(code, /fetch\(|XMLHttpRequest|await /);
  const app = read('app.js') + [...html.matchAll(/<script src="(js\/[\w-]+\.js)"><\/script>/g)].map(m => read(m[1])).join('\n');
  assert.doesNotMatch(app, /auroraSplash|splash--out/);
});

/* ---------------- стили и офлайн ---------------- */

test('стили: отдельный слой поверх всего, без влияния на разметку; кнопка над безопасной зоной', () => {
  const layer = /\.splash \{[^}]*\}/.exec(css)[0];
  assert.match(layer, /position: fixed;/);
  assert.match(layer, /inset: 0;/);
  assert.match(layer, /z-index: 1000;/);
  assert.match(layer, /display: none;/);
  assert.match(css, /html\.has-splash \.splash \{ display: block; \}/);
  assert.match(css, /\.splash--out \{ opacity: 0; pointer-events: none; \}/);
  assert.match(/\.splash__skip \{[^}]*\}/.exec(css)[0], /bottom: max\(28px, calc\(env\(safe-area-inset-bottom, 0px\) \+ 20px\)\);/);
  assert.doesNotMatch(css, /html\.has-splash (body|html)\s*\{[^}]*overflow/, 'без overflow на странице — полоса прокрутки не пропадает и макет не сдвигается');
});

test('«уменьшить движение» — страховка и в CSS', () => {
  const blocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map(m => m[1]).join('\n');
  assert.match(blocks, /html\.has-splash \.splash \{ display: none; \}/);
});

test('splash.js в оболочке service worker: заставка работает и офлайн; вес небольшой', () => {
  assert.match(read('sw.js'), /'splash\.js'/);
  assert.ok(code.length < 12000, 'размер ' + code.length);
});

test('класс на <html> не совпадает с классом слоя: иначе стиль .splash скрыл бы всю страницу', () => {
  assert.doesNotMatch(headScript, /classList\.add\('splash'\)/);
  assert.match(headScript, /classList\.add\('has-splash'\)/);
  // ни одно правило со скрытием не должно подходить к <html class="has-splash">
  assert.doesNotMatch(css, /(^|[\s,}])\.has-splash\s*\{/);
  assert.doesNotMatch(code, /classList\.(add|remove|contains)\('splash'\)/);
});

test('страница под заставкой скрыта до начала исчезновения: сдвиги при заполнении данными не видны и не считаются', () => {
  assert.match(css, /html\.has-splash:not\(\.splash-leaving\) body > :not\(\.splash\) \{ visibility: hidden; \}/);
  const finish = /finish: function \(fast\) \{([\s\S]*?)\n    \}\n  \};/.exec(code)[1];
  const leaving = finish.indexOf("root.classList.add('splash-leaving')");
  assert.ok(leaving > 0 && leaving < finish.indexOf('later('), 'дашборд проявляется вместе с исчезновением, а не после');
  assert.match(finish, /root\.classList\.remove\('has-splash', 'splash-leaving'\)/);
});
