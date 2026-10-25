/* Живое небо первого экрана: медленные волны сияния за шапкой и вердиктом (WebGL).
   Часть приложения: общие переменные и функции — глобальные, порядок подключения задан
   в index.html (см. js/README.md). */
'use strict';

/* Эффект перенесён из ShaderGradient (https://github.com/ruucm/shadergradient,
   MIT © ruucm, stone-skipper): плоскость 10 × 10 изгибается классическим шумом Перлина,
   цвет — смесь трёх тонов по положению и высоте волны. Без three.js и React: свой маленький
   WebGL — одна сетка и два коротких шейдера. Цвета — из переменных темы (--aurora-*),
   сила волн — по небу за страницей (data-sky).

   Когда неподвижно: «уменьшить движение» в системе или «Живой фон: Выкл» в настройках — один
   кадр без анимации. Когда только CSS-градиент .aurora-bg: ночное зрение, нет WebGL или
   программная графика, слабое устройство, экономия трафика, или первые кадры идут медленно. */

/* Сила волн по небу за страницей: скорость (фаза шума в секунду), высота волн и яркость.
   Буря — чуть быстрее и выше, но всё равно спокойно: полный оборот рисунка — минуты. */
var HERO_SKY_MOOD = {
  calm:   { speed: 0.05, strength: 1.5, bright: 0.85 },
  active: { speed: 0.07, strength: 2.0, bright: 1 },
  storm:  { speed: 0.095, strength: 2.6, bright: 1.15 }
};

/* Сетка: по ширине один отрезок, как в оригинале (волна — прямые ленты), по высоте — частая:
   иначе на гребнях видны грани. Это всего ~1000 вершин — для видеокарты пустяк. На телефоне
   реже и 30 кадров в секунду: движение медленное, разницы не видно. */
var HERO_SKY = { rows: 480, rowsPhone: 320, fpsPhone: 30, testFrames: 30, watchFrames: 90, slowMs: 40, fadeS: 2,
                 density: 1.0, dist: 4, tilt: -20, turn: 70 };

var HERO_SKY_VERTEX = [
  'attribute vec2 aPos;',
  'uniform mat4 uMvp;',
  'uniform float uPhase;',
  'uniform float uStrength;',
  'uniform float uDensity;',
  'varying vec3 vPos;',
  'varying float vSlope;',
  // классический шум Перлина 3D (glsl-noise, Stefan Gustavson) — как в ShaderGradient
  'vec3 m289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }',
  'vec4 m289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }',
  'vec4 perm(vec4 x) { return m289(((x * 34.0) + 1.0) * x); }',
  'vec4 tis(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }',
  'vec3 fade(vec3 t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }',
  'float cnoise(vec3 P) {',
  '  vec3 i0 = m289(floor(P)); vec3 i1 = m289(i0 + 1.0);',
  '  vec3 f0 = fract(P); vec3 f1 = f0 - 1.0;',
  '  vec4 ix = vec4(i0.x, i1.x, i0.x, i1.x); vec4 iy = vec4(i0.yy, i1.yy);',
  '  vec4 ixy = perm(perm(ix) + iy);',
  '  vec4 ixy0 = perm(ixy + i0.zzzz); vec4 ixy1 = perm(ixy + i1.zzzz);',
  '  vec4 gx0 = ixy0 / 7.0; vec4 gy0 = fract(floor(gx0) / 7.0) - 0.5; gx0 = fract(gx0);',
  '  vec4 gz0 = 0.5 - abs(gx0) - abs(gy0); vec4 sz0 = step(gz0, vec4(0.0));',
  '  gx0 -= sz0 * (step(0.0, gx0) - 0.5); gy0 -= sz0 * (step(0.0, gy0) - 0.5);',
  '  vec4 gx1 = ixy1 / 7.0; vec4 gy1 = fract(floor(gx1) / 7.0) - 0.5; gx1 = fract(gx1);',
  '  vec4 gz1 = 0.5 - abs(gx1) - abs(gy1); vec4 sz1 = step(gz1, vec4(0.0));',
  '  gx1 -= sz1 * (step(0.0, gx1) - 0.5); gy1 -= sz1 * (step(0.0, gy1) - 0.5);',
  '  vec3 g000 = vec3(gx0.x, gy0.x, gz0.x); vec3 g100 = vec3(gx0.y, gy0.y, gz0.y);',
  '  vec3 g010 = vec3(gx0.z, gy0.z, gz0.z); vec3 g110 = vec3(gx0.w, gy0.w, gz0.w);',
  '  vec3 g001 = vec3(gx1.x, gy1.x, gz1.x); vec3 g101 = vec3(gx1.y, gy1.y, gz1.y);',
  '  vec3 g011 = vec3(gx1.z, gy1.z, gz1.z); vec3 g111 = vec3(gx1.w, gy1.w, gz1.w);',
  '  vec4 n0 = tis(vec4(dot(g000, g000), dot(g010, g010), dot(g100, g100), dot(g110, g110)));',
  '  g000 *= n0.x; g010 *= n0.y; g100 *= n0.z; g110 *= n0.w;',
  '  vec4 n1 = tis(vec4(dot(g001, g001), dot(g011, g011), dot(g101, g101), dot(g111, g111)));',
  '  g001 *= n1.x; g011 *= n1.y; g101 *= n1.z; g111 *= n1.w;',
  '  vec4 nz = mix(vec4(dot(g000, f0), dot(g100, vec3(f1.x, f0.yz)), dot(g010, vec3(f0.x, f1.y, f0.z)), dot(g110, vec3(f1.xy, f0.z))),',
  '                vec4(dot(g001, vec3(f0.xy, f1.z)), dot(g101, vec3(f1.x, f0.y, f1.z)), dot(g011, vec3(f0.x, f1.yz)), dot(g111, f1)), fade(f0).z);',
  '  vec2 nyz = mix(nz.xy, nz.zw, fade(f0).y);',
  '  return 2.2 * mix(nyz.x, nyz.y, fade(f0).x);',
  '}',
  'void main() {',
  '  vec3 p = vec3(aPos, 0.0);',
  // волна: высота по шуму; уклон по длине ленты — для мягкой светотени
  '  float d = 0.75 * cnoise(uDensity * p + uPhase);',
  '  float d2 = 0.75 * cnoise(uDensity * (p + vec3(0.0, 0.08, 0.0)) + uPhase);',
  '  vSlope = (d2 - d) / 0.08;',
  '  p.z = d * uStrength;',
  '  vPos = p;',
  '  gl_Position = uMvp * vec4(p, 1.0);',
  '}'
].join('\n');

var HERO_SKY_FRAGMENT = [
  // зерну нужна точность: в mediump синус в хэше даёт полосы
  '#ifdef GL_FRAGMENT_PRECISION_HIGH',
  'precision highp float;',
  '#else',
  'precision mediump float;',
  '#endif',
  'uniform vec3 uC1;',
  'uniform vec3 uC2;',
  'uniform vec3 uC3;',
  'uniform float uBright;',
  'uniform float uLight;',
  'uniform float uSeed;',
  'uniform vec2 uRes;',
  'varying vec3 vPos;',
  'varying float vSlope;',
  'float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }',
  'void main() {',
  // смесь трёх тонов, как в ShaderGradient: вдоль волны — первый ко второму, а к верху
  // экрана — третий, как у настоящего сияния: зелёный низ занавеса, фиолетовый верх
  '  float up = gl_FragCoord.y / uRes.y;',
  '  vec3 base = mix(mix(uC1, uC2, smoothstep(-2.0, 2.0, vPos.y)), uC3, smoothstep(0.5, 1.0, up));',
  // светятся гребни, впадины уходят в темноту неба; склон к свету чуть ярче
  '  float glow = pow(smoothstep(-1.0, 1.0, vPos.z), 1.4) * (1.05 + 0.15 * clamp(vSlope, -1.0, 1.0)) * uBright;',
  // тёмная тема: свет поверх неба (холст складывается со страницей «экраном»);
  // светлая: та же волна бледной вуалью (холст умножается на страницу)
  // под шапкой (верхняя пятая часть) свет приглушён — мелкий текст читается
  '  glow *= 1.0 - 0.4 * smoothstep(0.78, 1.0, up);',
  '  vec3 col = mix(base * glow, 1.0 - (1.0 - base) * glow * 0.28, uLight);',
  // зерно, как у оригинала, — заодно убирает полосы на плавных переходах
  '  col += (hash(gl_FragCoord.xy + uSeed) - 0.5) * 0.035;',
  '  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);',
  '}'
].join('\n');

/**
 * Как показывать небо: 'off' — только CSS-градиент, 'still' — один неподвижный кадр,
 * 'live' — анимация. env: { theme, motion (настройка), reduce, gl (есть ли WebGL без
 * программной графики), memory (ГБ), cores, saveData }.
 */
function heroSkyMode(env) {
  if (env.theme === 'night' || !env.gl) return 'off';
  if (env.saveData) return 'off';
  if (env.memory && env.memory <= 2) return 'off';
  if (env.cores && env.cores <= 2) return 'off';
  if (env.reduce || env.motion === 'off') return 'still';
  return 'live';
}

/** Цвет темы #rrggbb (или #rgb) → [r, g, b] от 0 до 1; иное — null. */
function heroSkyRgb(value) {
  var hex = String(value || '').trim().replace('#', '');
  if (/^[0-9a-f]{3}$/i.test(hex)) hex = hex.replace(/./g, '$&$&');
  if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
  return [0, 2, 4].map(function (i) { return parseInt(hex.slice(i, i + 2), 16) / 255; });
}

/** Медленные кадры: середина интервалов между кадрами дольше порога — устройство не тянет. */
function heroSkySlow(intervals, limitMs) {
  if (!intervals.length) return false;
  var sorted = intervals.slice().sort(function (a, b) { return a - b; });
  return sorted[Math.floor(sorted.length / 2)] > limitMs;
}

/**
 * Камера: плоскость повёрнута и наклонена, смотрим с расстояния 3.6 под углом 45°, как в
 * пресете Halo оригинала. Возвращает матрицу 4 × 4 по столбцам (как ждёт WebGL).
 */
function heroSkyMatrix(aspect, view) {
  var f = 1 / Math.tan(Math.PI / 8), near = 0.1, far = 50;
  var proj = [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, 2 * far * near / (near - far), 0];
  var rz = view.turn * Math.PI / 180, rx = view.tilt * Math.PI / 180;
  var cz = Math.cos(rz), sz = Math.sin(rz), cx = Math.cos(rx), sx = Math.sin(rx);
  // поворот вокруг Z, затем наклон вокруг X, затем сдвиг от камеры
  var model = [cz, cx * sz, sx * sz, 0, -sz, cx * cz, sx * cz, 0, 0, -sx, cx, 0, -1.2, 0.4, -view.dist, 1];
  var out = [];
  for (var c = 0; c < 4; c++) {
    for (var r = 0; r < 4; r++) {
      var sum = 0;
      for (var k = 0; k < 4; k++) sum += proj[k * 4 + r] * model[c * 4 + k];
      out.push(sum);
    }
  }
  return out;
}

function heroSkyShader(gl, type, src) {
  var shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

/** Сетка-лента 10 × 10: по ширине один отрезок, по высоте rows; треугольники полосой. */
function heroSkyGrid(rows) {
  var pts = [];
  for (var i = 0; i <= rows; i++) {
    var y = -5 + 10 * i / rows;
    pts.push(-5, y, 5, y);
  }
  return new Float32Array(pts);
}

function initHeroSky() {
  var canvas = $('hero-sky');
  var root = document.documentElement;
  if (!canvas || !canvas.getContext || !window.requestAnimationFrame) return;

  var phone = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  var gl = null;
  try {
    // программная графика (нет видеокарты) — сразу CSS-градиент: такой WebGL тормозит
    gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false,
      powerPreference: 'low-power', failIfMajorPerformanceCaveat: true, preserveDrawingBuffer: false });
  } catch (e) { gl = null; }
  var nav = navigator || {};
  var reduceQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var env = function () {
    return { theme: root.getAttribute('data-theme'), motion: setting('motion'), reduce: !!(reduceQuery && reduceQuery.matches),
      gl: !!gl, memory: nav.deviceMemory, cores: nav.hardwareConcurrency, saveData: !!(nav.connection && nav.connection.saveData) };
  };
  // Без WebGL рамку убираем совсем: пустой слой со смешением тоже стоит браузеру работы.
  var box = canvas.parentNode;
  var drop = function () { if (box) box.hidden = true; };
  if (!gl) return drop();
  // Слабое устройство или экономия трафика — это не изменится до перезагрузки: холст не нужен.
  // (Тема другое дело: из ночного зрения возвращаются кнопкой.)
  var device = env();
  device.theme = 'dark';
  if (heroSkyMode(device) === 'off') return drop();

  var program = gl.createProgram();
  var vs = heroSkyShader(gl, gl.VERTEX_SHADER, HERO_SKY_VERTEX);
  var fs = heroSkyShader(gl, gl.FRAGMENT_SHADER, HERO_SKY_FRAGMENT);
  if (!vs || !fs) return drop();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return drop();
  gl.useProgram(program);

  var rows = phone ? HERO_SKY.rowsPhone : HERO_SKY.rows;
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, heroSkyGrid(rows), gl.STATIC_DRAW);
  var aPos = gl.getAttribLocation(program, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  var u = {};
  ['uMvp', 'uPhase', 'uStrength', 'uDensity', 'uRes', 'uC1', 'uC2', 'uC3', 'uBright', 'uLight', 'uSeed'].forEach(function (name) {
    u[name] = gl.getUniformLocation(program, name);
  });

  // Начало рисунка — своё для каждого визита: небо не повторяется кадр в кадр.
  var phase = Math.random() * 40;
  var mood = Object.assign({}, HERO_SKY_MOOD.calm);
  var mode = 'off', running = false, visible = true, ready = false, broken = false;
  var last = 0, test = [], frameAt = 0, raf = 0;

  function colors() {
    var style = getComputedStyle(root);
    var c = ['--aurora-green', '--aurora-teal', '--aurora-violet'].map(function (name) { return heroSkyRgb(style.getPropertyValue(name)); });
    if (c.some(function (x) { return !x; })) return;
    gl.uniform3fv(u.uC1, c[0]);
    gl.uniform3fv(u.uC2, c[1]);
    gl.uniform3fv(u.uC3, c[2]);
    gl.uniform1f(u.uLight, root.getAttribute('data-theme') === 'light' ? 1 : 0);
  }

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, phone ? 1 : 1.5);
    var w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.uniformMatrix4fv(u.uMvp, false, heroSkyMatrix(w / h, HERO_SKY));
    gl.uniform2f(u.uRes, w, h);
  }

  function draw() {
    gl.uniform1f(u.uPhase, phase);
    gl.uniform1f(u.uStrength, mood.strength);
    gl.uniform1f(u.uDensity, HERO_SKY.density);
    gl.uniform1f(u.uBright, mood.bright);
    gl.uniform1f(u.uSeed, mode === 'live' ? (phase * 1000) % 97 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, (rows + 1) * 2);
  }

  /* Небо за страницей сменилось — сила волн догоняет плавно, за пару секунд, без скачка.
     Фаза копится по шагам, а не «время × скорость»: смена скорости не дёргает рисунок. */
  function step(dt, settle) {
    var target = HERO_SKY_MOOD[root.getAttribute('data-sky')] || HERO_SKY_MOOD.calm;
    var k = settle ? 1 : 1 - Math.exp(-dt / HERO_SKY.fadeS);
    Object.keys(mood).forEach(function (key) { mood[key] += (target[key] - mood[key]) * k; });
    phase = (phase + dt * mood.speed) % 289;
  }

  /* Класс меняем, только если он и правда другой: иначе наблюдатель за <html> снова вызвал
     бы sync — и так по кругу. */
  function lit(on) {
    if (root.classList.contains('sky-gl') !== on) root.classList.toggle('sky-gl', on);
  }

  function show() {
    if (ready) return;
    ready = true;
    lit(true);
  }

  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function fallback() {
    broken = true;
    stop();
    lit(false);
    setTimeout(drop, 2000);  // после того как холст погас (переход 1,6 с)
  }

  function frame(now) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    if (phone && now - frameAt < 1000 / HERO_SKY.fpsPhone - 4) return;
    var dt = last ? Math.min((now - last) / 1000, 0.1) : 0;
    if (last) test.push(now - last);
    last = now;
    frameAt = now;
    step(dt);
    draw();
    // Холст проявляется, только когда первые кадры прошли быстро: на слабом устройстве
    // проверку никто не видит — остаётся CSS-градиент. Видимый холст ещё и смешивается со
    // страницей — это дороже, поэтому кадры считаются и дальше: стало медленно — фон
    // плавно возвращается к CSS-градиенту.
    if (test.length >= (ready ? HERO_SKY.watchFrames : HERO_SKY.testFrames)) {
      if (heroSkySlow(test, HERO_SKY.slowMs)) fallback();
      else show();
      test = [];
    }
  }

  /** Пересчитать режим: тема, настройка, заставка, видимость — и запустить или остановить. */
  function sync() {
    if (broken) return;
    mode = heroSkyMode(env());
    var waiting = root.classList.contains('has-splash');
    if (mode === 'off') {
      stop();
      lit(false);
      ready = false;
      test = [];
      return;
    }
    colors();
    resize();
    if (mode === 'still') {
      stop();
      step(0, true);
      draw();
      show();
      return;
    }
    var go = visible && !waiting && document.visibilityState !== 'hidden';
    if (go && !running) {
      running = true;
      last = 0;
      raf = requestAnimationFrame(frame);
    } else if (!go) {
      stop();
    }
  }

  canvas.addEventListener('webglcontextlost', fallback);
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['class', 'data-theme', 'data-sky', 'data-motion'] });
  document.addEventListener('visibilitychange', sync);
  if (reduceQuery && reduceQuery.addEventListener) reduceQuery.addEventListener('change', sync);
  // Первый экран прокручен — не рисуем то, чего не видно.
  if (window.IntersectionObserver) {
    new IntersectionObserver(function (entries) {
      visible = entries[entries.length - 1].isIntersecting;
      sync();
    }).observe(canvas);
  }
  var resizePending = false;
  window.addEventListener('resize', function () {
    if (resizePending) return;
    resizePending = true;
    requestAnimationFrame(function () {
      resizePending = false;
      if (mode === 'off' || broken) return;
      resize();
      if (!running) draw();
    });
  }, { passive: true });

  // Старт — когда браузер свободен: загрузка данных и первая отрисовка важнее фона.
  (window.requestIdleCallback || function (fn) { return setTimeout(fn, 300); })(sync, { timeout: 1500 });
}
