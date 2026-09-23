/* Слой облачности на вкладке «Карта»: сетка над схемой и ползунок по часам на сутки вперёд.
   Часть приложения: общие переменные и функции — глобальные, порядок подключения задан
   в index.html (см. js/README.md). */
'use strict';

/* ------------------------------------------------------------------ */
/*  Облака над областью                                                */
/*                                                                     */
/*  Семь точек не отвечают на главный вопрос — «а если отъехать?».     */
/*  Поэтому над рамкой схемы берётся сетка CLOUD_GRID.cols × rows      */
/*  узлов, и для всех узлов одним запросом к Open-Meteo приходит       */
/*  почасовая облачность по ярусам на сутки вперёд. В каждом узле она  */
/*  сводится в эффективную так же, как для точек (effectiveCloud), и   */
/*  рисуется полупрозрачными облаками поверх схемы с плавными          */
/*  переходами между узлами.                                           */
/*                                                                     */
/*  Шаг сетки ≈ 30 × 30 км: мельче не нужно — модель ICON-EU сама      */
/*  считает с шагом 7 км, а плавная заливка между узлами показывает    */
/*  картину, а не точные границы облаков. Данные грузятся только при   */
/*  открытии карты.                                                    */
/* ------------------------------------------------------------------ */

var CLOUD_GRID = {
  cols: 9,
  rows: 10,
  hours: 24,          // ползунок: от текущего часа на сутки вперёд
  refreshMs: 60 * 60 * 1000,   // модель пересчитывается раз в несколько часов — чаще не нужно
  upscale: 12,        // во сколько раз холст подробнее сетки: плавная заливка между узлами
  minCloud: 10,       // ниже — небо ясное, облаков не рисуем
  maxAlpha: 0.66      // сплошная облачность не закрывает схему полностью
};

/**
 * Узлы сетки в порядке строк: сначала верхний ряд слева направо. Центры ячеек, равномерно
 * по рамке схемы: проекция схемы линейна по широте и долготе, поэтому узлы ровно ложатся на холст.
 */
function cloudGridCells(map) {
  var m = map || REGION_MAP;
  var cells = [];
  for (var r = 0; r < CLOUD_GRID.rows; r++) {
    for (var c = 0; c < CLOUD_GRID.cols; c++) {
      cells.push({
        lat: Math.round((m.latMax - (r + 0.5) * (m.latMax - m.latMin) / CLOUD_GRID.rows) * 1000) / 1000,
        lon: Math.round((m.lonMin + (c + 0.5) * (m.lonMax - m.lonMin) / CLOUD_GRID.cols) * 1000) / 1000
      });
    }
  }
  return cells;
}

/** Адрес облачности по ярусам для всех узлов: один запрос, сутки вперёд с текущего часа. */
function cloudGridUrl(cells) {
  return 'https://api.open-meteo.com/v1/forecast'
    + '?latitude=' + cells.map(function (p) { return p.lat; }).join(',')
    + '&longitude=' + cells.map(function (p) { return p.lon; }).join(',')
    + '&hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high'
    + '&models=' + CONFIG.weatherModel
    + '&forecast_hours=' + CLOUD_GRID.hours + '&timezone=UTC&timeformat=unixtime';
}

/**
 * Ответ Open-Meteo → { times: [мс], values: [[облачность узла, %] по часам] }.
 * Узел без данных на какой-то час — null (на холсте он просто прозрачный).
 * Ответ другой длины — ошибка: порядок узлов тогда уже ничего не значит.
 */
function readCloudGrid(data, count) {
  if (!Array.isArray(data)) throw appError('not_list');
  if (data.length !== count) throw appError('points_count', { got: data.length, want: count });

  var first = data[0] && data[0].hourly;
  if (!first || !Array.isArray(first.time) || !first.time.length) throw appError('no_hours');
  var times = first.time.map(function (s) { return Number(s) * 1000; });

  var values = times.map(function (time, h) {
    return data.map(function (node) {
      var hourly = node && node.hourly;
      if (!hourly || !hourly.time || Number(hourly.time[h]) * 1000 !== time) return null;
      var value = effectiveCloud(readLayers(hourly, h));
      if (value === null) value = num(hourly.cloud_cover ? hourly.cloud_cover[h] : null);
      return value === null ? null : Math.round(value);
    });
  });
  return { times: times, values: values };
}

/** Часы, которые ещё не прошли: текущий и дальше. Прошедшие (данные из кэша) отбрасываются. */
function cloudGridFrom(grid, now) {
  var start = 0;
  while (start + 1 < grid.times.length && grid.times[start + 1] <= now) start++;
  if (!grid.times.length || grid.times[grid.times.length - 1] + 3600000 <= now) return null;
  return { times: grid.times.slice(start), values: grid.values.slice(start) };
}

/**
 * Облачность в произвольном месте рамки: билинейно между четырьмя ближайшими узлами.
 * x, y — доли ширины и высоты схемы (0..1), как у mapPosition. Узлы без данных не участвуют;
 * если вокруг нет ни одного — null.
 */
function cloudAt(values, x, y) {
  var cols = CLOUD_GRID.cols, rows = CLOUD_GRID.rows;
  // центры ячеек — в (c + 0,5) / cols: за крайними центрами значение не экстраполируем
  var gx = Math.max(0, Math.min(cols - 1, x * cols - 0.5));
  var gy = Math.max(0, Math.min(rows - 1, y * rows - 0.5));
  var c0 = Math.floor(gx), r0 = Math.floor(gy);
  var c1 = Math.min(cols - 1, c0 + 1), r1 = Math.min(rows - 1, r0 + 1);
  var fx = gx - c0, fy = gy - r0;

  var sum = 0, weight = 0;
  [[r0, c0, (1 - fx) * (1 - fy)], [r0, c1, fx * (1 - fy)], [r1, c0, (1 - fx) * fy], [r1, c1, fx * fy]]
    .forEach(function (n) {
      var v = values[n[0] * cols + n[1]];
      if (v === null || v === undefined || n[2] <= 0) return;
      sum += v * n[2];
      weight += n[2];
    });
  return weight > 0 ? sum / weight : null;
}

/** Непрозрачность облаков: ясно — ничего, дальше плавно до maxAlpha при сплошной облачности. */
function cloudAlpha(value) {
  if (value === null || value <= CLOUD_GRID.minCloud) return 0;
  var k = (Math.min(100, value) - CLOUD_GRID.minCloud) / (100 - CLOUD_GRID.minCloud);
  return CLOUD_GRID.maxAlpha * Math.pow(k, 0.8);
}

/** Цвет облаков из темы (--map-cloud: «r, g, b»); без него — светло-серый. */
function cloudColor() {
  var el = $('map');
  var raw = el && window.getComputedStyle ? getComputedStyle(el).getPropertyValue('--map-cloud') : '';
  var parts = String(raw || '').split(',').map(function (s) { return Number(s.trim()); });
  return parts.length === 3 && parts.every(function (n) { return n >= 0 && n <= 255; }) ? parts : [214, 222, 232];
}

/** Рисует облака выбранного часа на холсте поверх схемы. */
function drawCloudLayer(canvas, values) {
  var w = CLOUD_GRID.cols * CLOUD_GRID.upscale;
  var h = CLOUD_GRID.rows * CLOUD_GRID.upscale;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  var ctx = canvas.getContext('2d');
  var image = ctx.createImageData(w, h);
  var rgb = cloudColor();

  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var a = cloudAlpha(cloudAt(values, (x + 0.5) / w, (y + 0.5) / h));
      var i = (y * w + x) * 4;
      image.data[i] = rgb[0];
      image.data[i + 1] = rgb[1];
      image.data[i + 2] = rgb[2];
      image.data[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(image, 0, 0);
}

/** Подпись часа: «сейчас» или «23:00, через 5 часов». */
function cloudHourLabel(times, index) {
  if (!index) return t('clouds.now');
  return t('clouds.at', { time: fmtTime(new Date(times[index])), in: t('unit.hours', { n: index }) });
}

/* Выбранный час и включён ли слой; включённость переживает перезагрузку. */
function cloudsEnabled() {
  if (state.cloudsOn === undefined) {
    try { state.cloudsOn = localStorage.getItem(CACHE.prefix + 'clouds') !== 'off'; } catch (e) { state.cloudsOn = true; }
  }
  return state.cloudsOn;
}

function setCloudsEnabled(on) {
  state.cloudsOn = on;
  try { localStorage.setItem(CACHE.prefix + 'clouds', on ? 'on' : 'off'); } catch (e) { /* не запомнится */ }
}

/** Загрузка сетки: сначала сохранённая (если свежая), затем сеть. Не чаще раза в час. */
function loadCloudGrid(force) {
  if (state.cloudGridLoading) return state.cloudGridLoading;
  var fresh = state.cloudGrid && Date.now() - state.cloudGrid.loadedAt < CLOUD_GRID.refreshMs;
  if (fresh && !force) return Promise.resolve(state.cloudGrid);

  if (!state.cloudGrid) {
    var cached = cacheLoad('cloudgrid');
    if (cached) state.cloudGrid = { grid: cached.payload, loadedAt: Date.now() - cached.age, stale: cached.age };
  }

  var cells = cloudGridCells();
  state.cloudGridLoading = fetchJson(cloudGridUrl(cells))
    .then(function (data) {
      var grid = readCloudGrid(data, cells.length);
      state.cloudGrid = { grid: grid, loadedAt: Date.now(), stale: null };
      cacheSave('cloudgrid', grid);
      return state.cloudGrid;
    })
    .catch(function () {
      state.cloudGridError = true;
      return state.cloudGrid;
    })
    .then(function (result) {
      state.cloudGridLoading = null;
      if (result) state.cloudGridError = false;
      renderClouds();
      return result;
    });
  renderClouds();
  return state.cloudGridLoading;
}

/** Слой, ползунок, подпись часа и облачность в выбранной точке. */
function renderClouds() {
  var canvas = $('map-clouds');
  var box = $('map-clouds-ctl');
  if (!canvas || !box) return;

  var on = cloudsEnabled();
  var toggle = $('map-clouds-toggle');
  toggle.setAttribute('aria-pressed', String(on));

  var usable = state.cloudGrid ? cloudGridFrom(state.cloudGrid.grid, Date.now()) : null;
  var slider = $('map-hour');
  var status = $('map-clouds-status');

  if (!usable) {
    canvas.hidden = true;
    slider.disabled = true;
    $('map-hour-label').textContent = '';
    $('map-clouds-here').textContent = '';
    status.textContent = state.cloudGridLoading ? t('clouds.loading') : (state.cloudGridError ? t('clouds.error') : '');
    return;
  }

  var index = Math.max(0, Math.min(usable.times.length - 1, state.cloudHour || 0));
  state.cloudHour = index;
  slider.max = String(usable.times.length - 1);
  slider.value = String(index);
  slider.disabled = !on;
  var label = cloudHourLabel(usable.times, index);
  $('map-hour-label').textContent = label;
  slider.setAttribute('aria-valuetext', label);

  status.textContent = state.cloudGrid.stale
    ? t('stale.line', { lead: t('lead.calc_saved'), age: fmtAge(state.cloudGrid.stale) })
    : '';

  canvas.hidden = !on;
  if (on) drawCloudLayer(canvas, usable.values[index]);

  // Облачность в точке, выбранной на карте, — числом: по заливке на глаз её не оценить.
  var point = state.mapPoint ? findPoint(state.mapPoint) : currentPoint();
  var pos = mapPosition(point.lat, point.lon);
  var here = cloudAt(usable.values[index], pos.x, pos.y);
  $('map-clouds-here').textContent = here === null ? '' :
    t('clouds.here', { name: pointName(point), v: Math.round(here) });
}

function initClouds() {
  var slider = $('map-hour');
  if (!slider) return;
  slider.addEventListener('input', function () {
    state.cloudHour = Number(slider.value) || 0;
    renderClouds();
  });
  $('map-clouds-toggle').addEventListener('click', function () {
    setCloudsEnabled(!cloudsEnabled());
    renderClouds();
  });
}
