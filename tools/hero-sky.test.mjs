// Живое небо первого экрана (js/hero-sky.js): когда анимация, когда неподвижный кадр, когда
// только CSS-градиент; цвета из темы, сила волн по небу, разметка, стили и настройка.
// Запуск: node --test tools/hero-sky.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const src = read('js/hero-sky.js');
const css = read('styles.css');
const html = read('index.html');

const ctx = vm.createContext({ Math, String, parseInt, Float32Array });
vm.runInContext(src, ctx);
const plain = v => JSON.parse(JSON.stringify(v));

const base = { theme: 'dark', motion: 'on', reduce: false, gl: true, memory: 8, cores: 8, saveData: false };
const mode = extra => ctx.heroSkyMode({ ...base, ...extra });

test('обычное устройство с WebGL — анимация; тёмная и светлая тема', () => {
  assert.equal(mode({}), 'live');
  assert.equal(mode({ theme: 'light' }), 'live');
  // браузеры без deviceMemory (Safari, Firefox) — не повод отключать
  assert.equal(mode({ memory: undefined, cores: undefined }), 'live');
});

test('«уменьшить движение» и «Живой фон: Выкл» — один неподвижный кадр', () => {
  assert.equal(mode({ reduce: true }), 'still');
  assert.equal(mode({ motion: 'off' }), 'still');
});

test('ночное зрение, нет WebGL, слабое устройство, экономия трафика — только CSS-градиент', () => {
  assert.equal(mode({ theme: 'night' }), 'off');
  assert.equal(mode({ theme: 'night', reduce: true }), 'off');
  assert.equal(mode({ gl: false }), 'off');
  assert.equal(mode({ memory: 2 }), 'off');
  assert.equal(mode({ memory: 1, reduce: true }), 'off');
  assert.equal(mode({ cores: 2 }), 'off');
  assert.equal(mode({ saveData: true }), 'off');
  assert.equal(mode({ memory: 4, cores: 4 }), 'live');
});

test('медленные первые кадры: судим по середине, один долгий кадр не в счёт', () => {
  const fast = Array(30).fill(16.7);
  assert.equal(ctx.heroSkySlow(fast, 40), false);
  assert.equal(ctx.heroSkySlow([...fast.slice(0, 29), 400], 40), false, 'один рывок (загрузка данных)');
  assert.equal(ctx.heroSkySlow(Array(30).fill(33.4), 40), false, '30 кадров в секунду — нормально');
  assert.equal(ctx.heroSkySlow(Array(30).fill(50), 40), true);
  assert.equal(ctx.heroSkySlow([], 40), false);
});

test('цвета темы: #rrggbb и #rgb → доли; мусор — null (холст тогда цвета не меняет)', () => {
  assert.deepEqual(plain(ctx.heroSkyRgb(' #4dffb8')), [77 / 255, 1, 184 / 255]);
  assert.deepEqual(plain(ctx.heroSkyRgb('#fff')), [1, 1, 1]);
  for (const bad of ['', 'red', 'rgb(1, 2, 3)', '#12345', null, undefined]) assert.equal(ctx.heroSkyRgb(bad), null, String(bad));
});

test('цвета — только из переменных темы, своих цветов в коде нет', () => {
  assert.match(src, /'--aurora-green', '--aurora-teal', '--aurora-violet'/);
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ''), /#[0-9a-f]{6}\b/i);
});

test('сила волн по небу: буря быстрее и ярче спокойного, но движение остаётся медленным', () => {
  const m = plain(ctx.HERO_SKY_MOOD);
  assert.deepEqual(Object.keys(m), ['calm', 'active', 'storm']);
  for (const key of ['speed', 'strength', 'bright']) {
    assert.ok(m.calm[key] < m.active[key] && m.active[key] < m.storm[key], key);
  }
  // в оригинальном пресете скорость 0.4; здесь даже буря вчетверо спокойнее
  assert.ok(m.storm.speed <= 0.1, 'скорость бури ' + m.storm.speed);
  assert.match(src, /phase = \(phase \+ dt \* mood\.speed\) % 289/, 'фаза копится — смена скорости не дёргает рисунок');
});

test('камера: матрица 4 × 4 без NaN для узкого телефона и широкого экрана', () => {
  for (const aspect of [375 / 844, 1, 1280 / 900, 3]) {
    const m = plain(ctx.heroSkyMatrix(aspect, ctx.HERO_SKY));
    assert.equal(m.length, 16);
    assert.ok(m.every(Number.isFinite), String(aspect));
  }
  const grid = ctx.heroSkyGrid(4);
  assert.equal(grid.length, (4 + 1) * 4, 'по две вершины на ряд');
});

test('экономия: пауза на скрытой вкладке и вне экрана, реже кадры на телефоне, разрешение не выше 1× на телефоне', () => {
  assert.match(src, /visibilitychange/);
  assert.match(src, /IntersectionObserver/);
  assert.match(src, /fpsPhone: 30/);
  assert.match(src, /phone \? 1 : 1\.5/);
  assert.match(src, /failIfMajorPerformanceCaveat: true/);
  assert.match(src, /webglcontextlost/);
  assert.match(src, /requestIdleCallback/);
  assert.ok(src.length < 20000, 'размер ' + src.length);
});

test('класс sky-gl меняется только при настоящей смене: иначе наблюдатель за <html> зациклился бы', () => {
  assert.match(src, /if \(root\.classList\.contains\('sky-gl'\) !== on\) root\.classList\.toggle\('sky-gl', on\);/);
  assert.equal((src.match(/classList\.(add|remove|toggle)\('sky-gl'/g) || []).length, 1, 'только через lit()');
  assert.match(src, /cancelAnimationFrame\(raf\)/, 'остановка снимает ожидающий кадр — двух циклов не бывает');
});

test('авторы эффекта указаны: ShaderGradient, MIT', () => {
  assert.match(src, /github\.com\/ruucm\/shadergradient/);
  assert.match(src, /MIT © ruucm, stone-skipper/);
});

test('разметка: холст в рамке после CSS-градиента, скрыт от скринридера; скрипт подключён и в оболочке офлайна', () => {
  assert.match(html, /<div class="aurora-bg" aria-hidden="true"><\/div>\n<div class="hero-sky-frame" aria-hidden="true"><canvas class="hero-sky" id="hero-sky"><\/canvas><\/div>/);
  assert.ok(html.includes('<script src="js/hero-sky.js"></script>'));
  assert.ok(read('sw.js').includes("'js/hero-sky.js'"));
  assert.match(read('app.js'), /initHeroSky\(\);/);
});

test('стили: холст виден только с html.sky-gl, гасит CSS-градиент; не во время заставки и интро; нет в ночном зрении', () => {
  assert.match(css, /\.hero-sky \{[^}]*opacity: 0;/);
  assert.match(css, /html\.sky-gl \.hero-sky \{ opacity: [\d.]+; \}/);
  assert.match(css, /html\.sky-gl \.aurora-bg \{ opacity: 0;/);
  assert.match(css, /html\.has-splash \.hero-sky,\nhtml\.intro \.hero-sky \{ opacity: 0; \}/);
  assert.match(css, /html\[data-theme="night"\] \.hero-sky-frame \{ display: none; \}/);
  assert.match(css, /\.hero-sky-frame \{[^}]*overflow: hidden;[^}]*mask-image: linear-gradient/, 'края обрезаны, низ растворяется');
});

test('настройка «Живой фон»: вкл по умолчанию, кнопки в разметке, атрибут до первой отрисовки, подписи на трёх языках', () => {
  const settings = read('js/settings.js');
  assert.match(settings, /motion: 'on' \}/);
  assert.match(settings, /motion: \['on', 'off'\]/);
  assert.match(settings, /root\.setAttribute\('data-motion', setting\('motion'\)\)/);
  assert.match(html, /data-pref="motion"[\s\S]*?data-value="on"[\s\S]*?data-value="off"/);
  assert.match(html, /if \(saved\.motion === 'off'\) root\.setAttribute\('data-motion', 'off'\);/);
  for (const lang of ['ru', 'en', 'zh']) {
    const dict = read(`lang/${lang}.js`);
    for (const key of ['pref.motion', 'pref.motion.on', 'pref.motion.off', 'pref.motion.hint']) assert.ok(dict.includes(`'${key}':`), lang + ' ' + key);
  }
});
