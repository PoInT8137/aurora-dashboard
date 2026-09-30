/* Заставка первого визита, «вид с орбиты»; пропуск кнопкой, Esc, нажатием. Уход: сияние за
   горизонт, эмблема на кольцо вердикта, дашборд поднимается. Показывать ли — решает <head>
   (класс has-splash, не splash: стиль .splash скрыл бы <html>). Данные заставка не ждёт. */
'use strict';

var SPLASH = {
  showMs: 2700,      // когда начинать уход
  fadeMs: 1200,      // уход: сияние за горизонт, эмблема на кольцо вердикта, дашборд поднимается
  skipFadeMs: 250,   // после «Пропустить» — быстро и без перелёта
  scale: 2           // во сколько раз холст сияния меньше экрана
};

/* Тексты: словари грузятся позже. Совпадение со словарями — tools/splash.test.mjs. */
var SPLASH_TEXT = {
  ru: { title: 'Северное сияние', region: 'Мурманская область', skip: 'Пропустить', coords: '68,97° С. Ш. · 33,10° В. Д.' },
  en: { title: 'Northern Lights', region: 'Murmansk Region', skip: 'Skip', coords: '68.97° N · 33.10° E' },
  zh: { title: '北极光', region: '摩尔曼斯克州', skip: '跳过', coords: '北纬 68.97° · 东经 33.10°' }
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

/** #rrggbb → [r, g, b]; иначе запасной цвет. */
function splashRgb(value, fallback) {
  var m = /^#?([0-9a-f]{6})$/i.exec(String(value || '').trim());
  if (!m) return fallback;
  var n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/* Занавесы: дальний и ближний. k — складки, speed — дрейф, height — доля экрана, alpha — яркость. */
var SPLASH_CURTAINS = [
  { k: 5.1, speed: -0.35, height: 0.16, alpha: 0.55, phase: 2.4 },
  { k: 9,   speed: 0.7,   height: 0.3,  alpha: 1.25, phase: 0 }
];

/** Спрайт луча: снизу зелёный, выше бирюзовый, вверху фиолетовый. */
function splashRay(green, teal, violet) {
  var sprite = document.createElement('canvas');
  sprite.width = 1;
  sprite.height = 128;
  var g = sprite.getContext('2d');
  var c = function (rgb, a) { return 'rgba(' + rgb.join(',') + ',' + a + ')'; };
  var grad = g.createLinearGradient(0, 128, 0, 0);
  grad.addColorStop(0, c(green, 0));
  grad.addColorStop(0.06, c(green, 0.95));
  grad.addColorStop(0.35, c(teal, 0.45));
  grad.addColorStop(0.7, c(violet, 0.25));
  grad.addColorStop(1, c(violet, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, 1, 128);
  return sprite;
}

/** Плавный выход 0 → 1 (кубический). */
function splashEase(v) {
  v = Math.max(0, Math.min(1, v));
  return 1 - Math.pow(1 - v, 3);
}

/** Подъём сияния: с 0,6 с до 1,9 с, дальше в полную силу. */
function splashEnvelope(t) {
  return splashEase((t - 0.6) / 1.3);
}

/** Край Земли: большая окружность, верх на 80% высоты; y(x) — горизонт в точке x. */
function splashHorizon(w, h) {
  var r = Math.max(w, h) * 1.6;
  var cx = w / 2;
  var cy = h * 0.8 + r;
  return {
    r: r, cx: cx, cy: cy,
    y: function (x) { var dx = x - cx; return cy - Math.sqrt(Math.max(0, r * r - dx * dx)); }
  };
}

/** Кадр неба w×h в момент t (с): лучи, поверх Земля и дуга атмосферы. sink 0..1 — уход
    сияния за горизонт. Возвращает число лучей. */
function splashFrame(ctx, w, h, t, sprites, glow, sink) {
  var TAU = Math.PI * 2;
  var down = 1 - splashEase(sink || 0);
  var rise = splashEnvelope(t) * down;
  var earth = splashHorizon(w, h);
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, w, h);
  var drawn = 0;

  if (rise > 0) {
    ctx.globalCompositeOperation = 'lighter';
    for (var c = 0; c < SPLASH_CURTAINS.length; c++) {
      var cu = SPLASH_CURTAINS[c];
      for (var x = 0; x < w; x++) {
        var u = x / w;
        var fold = Math.pow(0.5 + 0.5 * Math.sin(u * cu.k + t * cu.speed + cu.phase) *
          Math.sin(u * 3.3 - t * 0.4 + 1.2 + cu.phase), 1.6);
        var fine = 0.6 + 0.4 * Math.sin(u * 180 + Math.sin(u * 23 + t * 2.1) * 3);
        var a = Math.min(1, rise * cu.alpha * fold * fine * (0.4 + 0.6 * Math.sin(Math.PI * u)));
        if (a < 0.03) continue;
        var base = Math.min(h, earth.y(x) + h * 0.01);
        var height = Math.min(base, h * (0.1 + cu.height * (0.4 + fold)) * rise);
        ctx.globalAlpha = a;
        ctx.drawImage(sprites[0], x, base - height, 1.3, height);
        drawn++;
      }
    }
    ctx.globalAlpha = 1;
  }

  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath();
  ctx.arc(earth.cx, earth.cy, earth.r, 0, TAU);
  ctx.fill();
  var draw = splashEase((t - 0.2) / 0.9) * down;
  if (draw > 0 && glow) {
    var span = Math.asin(Math.min(1, (w * 0.62) / earth.r)) * draw;
    ctx.save();
    ctx.shadowColor = glow;
    ctx.shadowBlur = 10;
    ctx.strokeStyle = glow;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(earth.cx, earth.cy, earth.r, -Math.PI / 2 - span, -Math.PI / 2 + span);
    ctx.stroke();
    ctx.restore();
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

/** Сдвиг и масштаб, ставящие кольцо заставки на кольцо вердикта; нет цели или вне экрана — null. */
function splashFlight(from, to, viewHeight) {
  if (!from || !to || !from.width || !to.width) return null;
  if (to.bottom < 0 || to.top > viewHeight) return null;
  return {
    x: Math.round(to.left + to.width / 2 - (from.left + from.width / 2)),
    y: Math.round(to.top + to.height / 2 - (from.top + from.height / 2)),
    scale: Math.round(to.width / from.width * 1000) / 1000
  };
}

/** Запуск; env (для тестов): now, raf, setTimeout. Возвращает { finish(fast) } или null. */
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
  var coords = document.getElementById('splash-coords');
  coords.textContent = text.coords;
  // печать по буквам — шагами CSS-анимации
  coords.style.setProperty('--chars', String(text.coords.length));
  var skip = document.getElementById('splash-skip');
  skip.textContent = text.skip;

  var sky = document.getElementById('splash-sky');
  var style = getComputedStyle(root);
  var color = function (name, fallback) { return splashRgb(style.getPropertyValue(name), fallback); };
  var teal = color('--aurora-teal', [53, 214, 232]);
  var sprites = [splashRay(color('--aurora-green', [77, 255, 184]), teal, color('--aurora-violet', [155, 123, 255]))];
  var glow = 'rgba(' + teal.join(',') + ',0.85)';
  var w = Math.max(1, Math.ceil(innerWidth / SPLASH.scale));
  var h = Math.max(1, Math.ceil(innerHeight / SPLASH.scale));
  sky.width = w;
  sky.height = h;
  var ctx = sky.getContext('2d');
  splashStars(document.getElementById('splash-stars'), innerWidth, innerHeight, Math.min(2, window.devicePixelRatio || 1), Math.random);

  var start = now();
  var done = false;
  var leaving = null;   // начало плавного ухода

  // Цель перелёта — кольцо вердикта, если данные уже есть; иначе просто растворение
  var flight = function () {
    if (typeof document.querySelector !== 'function') return null;
    var from = document.getElementById('splash-ring');
    var to = document.querySelector('#verdict-card[data-state="ok"] .ring, #verdict-card[data-state="stale"] .ring');
    var move = from && to ? splashFlight(from.getBoundingClientRect(), to.getBoundingClientRect(), innerHeight) : null;
    if (move) {
      // цвет и число делений вердикта — посадка без подмены
      var card = document.getElementById('verdict-card');
      move.tone = card.style.getPropertyValue('--tone');
      move.level = card.getAttribute('data-level');
    }
    return move;
  };

  var splash = {
    frames: 0,
    finish: function (fast) {
      if (done) return;
      done = true;
      var move = fast ? null : flight();
      box.style.setProperty('--splash-fade', (fast ? SPLASH.skipFadeMs : SPLASH.fadeMs) + 'ms');
      if (fast) {
        box.classList.add('splash--out');
      } else {
        leaving = now();
        box.classList.add('splash--leave');
        root.classList.add('splash-rise');
        if (move) {
          box.style.setProperty('--fly', 'translate(' + move.x + 'px, ' + move.y + 'px) scale(' + move.scale + ')');
          if (move.tone) box.style.setProperty('--fly-tone', move.tone);
          if (move.level) box.setAttribute('data-level', move.level);
          box.classList.add('splash--fly');
          root.classList.add('splash-flying');
        }
      }
      root.classList.add('splash-leaving');
      later(function () {
        leaving = null;
        root.classList.remove('has-splash', 'splash-leaving', 'splash-rise', 'splash-flying');
        box.classList.remove('splash--out', 'splash--leave', 'splash--fly');
        document.removeEventListener('keydown', onKey);
        document.removeEventListener('visibilitychange', onHidden);
      }, fast ? SPLASH.skipFadeMs : SPLASH.fadeMs);
    }
  };

  var tick = function () {
    // после пропуска кадров нет; при плавном уходе — пока сияние не скроется
    if (done && leaving === null) return;
    var sink = leaving === null ? 0 : (now() - leaving) / (SPLASH.fadeMs * 0.6);
    splashFrame(ctx, w, h, (now() - start) / 1000, sprites, glow, sink);
    splash.frames++;
    raf(tick);
  };
  var onKey = function (e) { if (e.key === 'Escape') splash.finish(true); };
  // вкладку свернули — сразу к дашборду
  var onHidden = function () { if (document.visibilityState === 'hidden') splash.finish(true); };

  box.addEventListener('click', function () { splash.finish(true); });
  // страница под заставкой не должна уехать
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
