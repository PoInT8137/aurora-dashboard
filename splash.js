/* Заставка при первом визите: северное сияние на холсте, ~3,4 с, пропускается кнопкой, Esc и
   нажатием где угодно. Показывать или нет, решает встроенный скрипт в <head> (класс splash на <html>)
   ещё до первой отрисовки; этот файл только рисует и убирает заставку.
   Класс на <html> — has-splash, а не splash: иначе стиль слоя .splash (display: none; fixed)
   срабатывал бы на самом <html> и скрывал страницу целиком.

   Заставка — отдельный слой поверх страницы: разметку не трогает и данные не ждёт — запросы к NOAA
   и Open-Meteo уходят как обычно, параллельно с анимацией.

   Сияние рисуется на холсте в четверть разрешения, растянутом на весь экран: оно и так размытое,
   а работы в 16 раз меньше. Каждая лента — ряд столбиков из заранее готового градиента. */
'use strict';

var SPLASH = {
  showMs: 2800,      // когда начинать исчезать
  fadeMs: 600,       // плавный переход к дашборду
  skipFadeMs: 250,   // после «Пропустить» — быстрее
  scale: 4           // во сколько раз холст сияния меньше экрана
};

/* Тексты заставки: словари загружаются позже, а заставка нужна сразу. Совпадение со словарями
   (app.title, app.region, splash.skip) проверяет tools/splash.test.mjs. */
var SPLASH_TEXT = {
  ru: { title: 'Северное сияние', region: 'Мурманская область', skip: 'Пропустить' },
  en: { title: 'Northern Lights', region: 'Murmansk Region', skip: 'Skip' },
  zh: { title: '北极光', region: '摩尔曼斯克州', skip: '跳过' }
};

/** Язык по тем же правилам, что у сайта (detectLang в i18n.js): адрес, выбор, браузер, английский. */
function splashLang(search, saved, browserLangs) {
  var known = function (code) { return code === 'ru' || code === 'en' || code === 'zh'; };
  var fromTag = function (tag) {
    var base = String(tag || '').toLowerCase().split(/[-_]/)[0];
    return known(base) ? base : null;
  };
  var match = /[?&]lang=([a-zA-Z-]+)/.exec(search || '');
  var fromUrl = match ? fromTag(match[1]) : null;
  if (fromUrl) return fromUrl;
  if (known(saved)) return saved;
  var list = browserLangs || [];
  for (var i = 0; i < list.length; i++) {
    var code = fromTag(list[i]);
    if (code) return code;
  }
  return 'en';
}

/** Цвет #rrggbb → [r, g, b]; всё остальное — запасной цвет. */
function splashRgb(value, fallback) {
  var m = /^#?([0-9a-f]{6})$/i.exec(String(value || '').trim());
  if (!m) return fallback;
  var n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/* Три ленты: базовая высота (доля экрана), волна, скорость, высота занавеса, яркость. */
var SPLASH_RIBBONS = [
  { color: '--aurora-green',  fallback: [77, 255, 184],  base: 0.44, amp: 0.06, k: 1.7, speed: 0.09,  height: 0.34, phase: 0,   alpha: 1 },
  { color: '--aurora-teal',   fallback: [53, 214, 232],  base: 0.37, amp: 0.05, k: 2.6, speed: -0.07, height: 0.24, phase: 1.9, alpha: 0.8 },
  { color: '--aurora-violet', fallback: [155, 123, 255], base: 0.30, amp: 0.04, k: 1.3, speed: 0.05,  height: 0.2,  phase: 3.4, alpha: 0.55 }
];

/** Вертикальный градиент одной ленты: прозрачный верх, свечение, яркий нижний край — как у занавеса. */
function splashSprite(rgb) {
  var sprite = document.createElement('canvas');
  sprite.width = 1;
  sprite.height = 64;
  var g = sprite.getContext('2d');
  var c = rgb.join(',');
  var grad = g.createLinearGradient(0, 0, 0, 64);
  grad.addColorStop(0, 'rgba(' + c + ',0)');
  grad.addColorStop(0.55, 'rgba(' + c + ',0.28)');
  grad.addColorStop(0.9, 'rgba(' + c + ',0.9)');
  grad.addColorStop(1, 'rgba(' + c + ',0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 1, 64);
  return sprite;
}

/** Нарастание сияния: с 0,3 с до 1,3 с, дальше в полную силу (исчезает весь слой). */
function splashEnvelope(t) {
  return Math.max(0, Math.min(1, (t - 0.3) / 1.0));
}

/** Один кадр сияния на холсте w×h в момент t (секунды). */
function splashFrame(ctx, w, h, t, sprites) {
  var TAU = Math.PI * 2;
  var env = splashEnvelope(t);
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, w, h);
  if (env <= 0) return 0;
  ctx.globalCompositeOperation = 'lighter';
  var drawn = 0;
  for (var r = 0; r < SPLASH_RIBBONS.length; r++) {
    var rb = SPLASH_RIBBONS[r];
    for (var x = 0; x < w; x++) {
      var u = x / w;
      var y = h * (rb.base + rb.amp * Math.sin(TAU * (rb.k * u + rb.speed * t) + rb.phase) +
        rb.amp * 0.4 * Math.sin(TAU * (2.7 * rb.k * u - 1.3 * rb.speed * t)));
      var height = h * rb.height * (0.72 + 0.28 * Math.sin(TAU * (3.1 * u) + 1.1 * t + rb.phase));
      var glow = 0.55 + 0.45 * Math.sin(TAU * (2.3 * u) + 1.7 * t + rb.phase);
      var rays = 0.8 + 0.2 * Math.sin(40 * u + 3 * t + rb.phase);
      var a = env * rb.alpha * glow * glow * rays;
      if (a < 0.02) continue;
      ctx.globalAlpha = a;
      ctx.drawImage(sprites[r], x, y - height, 1, height);
      drawn++;
    }
  }
  ctx.globalAlpha = 1;
  return drawn;
}

/** Звёзды — один раз, на отдельном холсте в полном разрешении; выше сияния гуще. */
function splashStars(canvas, width, height, dpr, random) {
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  var g = canvas.getContext('2d');
  var count = Math.round(width * height / 5200);
  for (var i = 0; i < count; i++) {
    var x = random() * canvas.width;
    var y = Math.pow(random(), 1.6) * canvas.height * 0.85;
    g.globalAlpha = 0.25 + 0.6 * random();
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(x, y, (0.4 + 0.8 * random()) * dpr, 0, Math.PI * 2);
    g.fill();
  }
  return count;
}

/**
 * Запуск. env — зависимости окружения (для тестов): now(), raf(fn), setTimeout(fn, ms).
 * Возвращает объект заставки с finish(fast) либо null, если показывать нечего.
 */
function startSplash(env) {
  var root = document.documentElement;
  // Решение уже принято в <head>; класса нет — заставки нет (повторный визит, «уменьшить движение»).
  if (!root.classList || root.classList.contains('has-splash') !== true) return null;
  var box = document.getElementById('splash');
  if (!box) return null;

  env = env || {};
  var now = env.now || function () { return performance.now(); };
  var raf = env.raf || function (fn) { return requestAnimationFrame(fn); };
  var later = env.setTimeout || function (fn, ms) { return setTimeout(fn, ms); };

  var lang = splashLang(location.search, (function () {
    try { return localStorage.getItem('aurora.lang'); } catch (e) { return null; }
  })(), navigator.languages || [navigator.language]);
  var text = SPLASH_TEXT[lang];
  root.setAttribute('lang', lang === 'zh' ? 'zh-CN' : lang);
  document.getElementById('splash-title').textContent = text.title;
  document.getElementById('splash-region').textContent = text.region;
  var skip = document.getElementById('splash-skip');
  skip.textContent = text.skip;

  var sky = document.getElementById('splash-sky');
  var style = getComputedStyle(root);
  var sprites = SPLASH_RIBBONS.map(function (rb) { return splashSprite(splashRgb(style.getPropertyValue(rb.color), rb.fallback)); });
  var w = Math.max(1, Math.ceil(innerWidth / SPLASH.scale));
  var h = Math.max(1, Math.ceil(innerHeight / SPLASH.scale));
  sky.width = w;
  sky.height = h;
  var ctx = sky.getContext('2d');
  splashStars(document.getElementById('splash-stars'), innerWidth, innerHeight, Math.min(2, window.devicePixelRatio || 1), Math.random);

  var start = now();
  var done = false;

  var splash = {
    frames: 0,
    finish: function (fast) {
      if (done) return;
      done = true;
      box.style.setProperty('--splash-fade', (fast ? SPLASH.skipFadeMs : SPLASH.fadeMs) + 'ms');
      box.classList.add('splash--out');
      root.classList.add('splash-leaving');
      later(function () {
        root.classList.remove('has-splash', 'splash-leaving');
        box.classList.remove('splash--out');
        document.removeEventListener('keydown', onKey);
        document.removeEventListener('visibilitychange', onHidden);
      }, fast ? SPLASH.skipFadeMs : SPLASH.fadeMs);
    }
  };

  var tick = function () {
    if (done) return;   // после завершения кадров больше нет
    splashFrame(ctx, w, h, (now() - start) / 1000, sprites);
    splash.frames++;
    raf(tick);
  };
  var onKey = function (e) { if (e.key === 'Escape') splash.finish(true); };
  // Вкладку свернули — досматривать некому: сразу к дашборду, без кадров в фоне.
  var onHidden = function () { if (document.visibilityState === 'hidden') splash.finish(true); };

  box.addEventListener('click', function () { splash.finish(true); });
  // Прокрутка под заставкой не нужна: она на мгновение, а страница под ней не должна уехать.
  box.addEventListener('wheel', function (e) { e.preventDefault(); }, { passive: false });
  box.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });
  document.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', onHidden);
  if (skip.focus) skip.focus({ preventScroll: true });

  later(function () { splash.finish(false); }, SPLASH.showMs);
  raf(tick);
  return splash;
}

window.auroraSplash = startSplash();
