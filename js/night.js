/* Окно наблюдения на ближайшую ночь и график ночи по часам.
   Часть приложения: общие переменные и функции — глобальные, порядок подключения задан
   в index.html (см. js/README.md). */
'use strict';

/* ------------------------------------------------------------------ */
/*  Окно наблюдения на ближайшую ночь                                  */
/*                                                                     */
/*  Новых запросов не требует: почасовая облачность и трёхчасовой      */
/*  прогноз Kp уже загружены, высота Солнца считается локально.        */
/* ------------------------------------------------------------------ */

/** Прогнозное Kp на момент time: последняя трёхчасовка, начавшаяся до него. */
function kpAt(time, rows, fallback) {
  if (rows) {
    for (var i = rows.length - 1; i >= 0; i--) {
      if (rows[i].time.getTime() <= time.getTime()) return rows[i].value;
    }
  }
  return fallback;
}

/** Уровень часа: 2 — высокий, 1 — средний, 0 — низкий. */
function hourLevel(kp, cloudPct, alt, conflict, point) {
  var cs = cloudScore(cloudPct, conflict);
  var level;

  if (kp === null) {
    // Без прогноза Kp судим только по небу и выше среднего не поднимаемся.
    level = cs >= 3 ? 1 : 0;
  } else {
    var product = kpScore(kp, point) * cs;
    level = product >= 6 ? 2 : (product >= 2 ? 1 : 0);
  }

  // В неполной темноте высокий уровень не ставим — как и в вердикте.
  if (alt > DARK_FULL && level > 1) level = 1;
  return level;
}

/**
 * Ближайшая ночь и лучший отрезок внутри неё.
 * Возвращает null (нет данных), { polarDay: true } либо описание окна.
 */
function computeNightWindow(cloud, kpRows, kpNow, point) {
  if (!cloud || !cloud.hours || !cloud.hours.length) return null;

  point = point || currentPoint();
  var now = Date.now();
  var hours = [];

  for (var i = 0; i < cloud.hours.length; i++) {
    var t = parseUtc(cloud.hours[i].time);
    if (!t || t.getTime() + 3600000 < now) continue; // час уже прошёл
    hours.push({
      time: t,
      cloud: cloud.hours[i].cloud,
      alt: solarAltitude(t, point.lat, point.lon)
    });
  }

  if (!hours.length) return null;

  // Ближайший тёмный отрезок — это и есть «ночь».
  var start = -1;
  for (i = 0; i < hours.length; i++) {
    if (hours[i].alt <= DARK_USABLE) { start = i; break; }
  }
  if (start < 0) return { polarDay: true };

  var night = [];
  for (i = start; i < hours.length && hours[i].alt <= DARK_USABLE; i++) night.push(hours[i]);

  var noKp = true;
  night.forEach(function (h) {
    h.kp = kpAt(h.time, kpRows, kpNow);
    if (h.kp !== null && h.kp !== undefined) noKp = false;
    h.level = hourLevel(h.kp === undefined ? null : h.kp, h.cloud, h.alt, cloud.conflict, point);
  });

  // Лучший отрезок: самый длинный непрерывный ряд часов максимального уровня.
  var best = { level: -1, from: 0, to: -1 };
  var runStart = 0;

  for (i = 0; i <= night.length; i++) {
    var ends = (i === night.length) || (night[i].level !== night[runStart].level);
    if (!ends) continue;

    var level = night[runStart].level;
    var length = i - runStart;
    var bestLength = best.to - best.from + 1;

    if (level > best.level || (level === best.level && length > bestLength)) {
      best = { level: level, from: runStart, to: i - 1 };
    }
    runStart = i;
  }

  var window = night.slice(best.from, best.to + 1);
  var clouds = window.map(function (h) { return h.cloud; });
  var kps = window.map(function (h) { return h.kp; }).filter(function (v) {
    return v !== null && v !== undefined;
  });

  return {
    polarDay: false,
    point: point,
    night: night,
    from: window[0].time,
    to: new Date(window[window.length - 1].time.getTime() + 3600000), // час занимает интервал
    level: best.level,
    hours: window.length,
    cloudMin: Math.min.apply(null, clouds),
    cloudMax: Math.max.apply(null, clouds),
    kpMax: kps.length ? Math.max.apply(null, kps) : null,
    noKp: noKp,
    fullDark: window.every(function (h) { return h.alt <= DARK_FULL; })
  };
}

/** «облачность 12%» или «облачность 10–20%» для окна наблюдения. */
function cloudRangeText(win) {
  return win.cloudMin === win.cloudMax
    ? t('win.cloud_one', { v: win.cloudMin })
    : t('win.cloud_range', { min: win.cloudMin, max: win.cloudMax });
}

/** График ночи — в своей карточке под окном, её состояние повторяет состояние окна. */
function windowFreshness() {
  applyFreshness('window-card', 'window-stale', state.cloud.stale, 'lead.calc_saved');
  setState('night-card', 'ok');
}

function renderWindow() {
  var win = computeNightWindow(state.cloud, state.forecast, state.kp ? state.kp.value : null);
  var nightCard = $('night-card');

  if (!win) {
    setState('window-card', 'error');
    setState('night-card', 'error');
    return;
  }
  // В полярный день графика нет — и карточки для него тоже.
  if (nightCard) nightCard.hidden = !!win.polarDay;

  var valueEl = $('window-value');
  var hintEl = $('window-hint');
  var metaEl = $('window-meta');
  // В полярный день графика нет — прежний не должен остаться на экране.
  $('window-hours').innerHTML = '';
  $('window-detail').textContent = '';

  if (win.polarDay) {
    setTone($('window-card'), TONE.mid);
    setTone(valueEl, TONE.mid);
    valueEl.textContent = t('win.no_dark');
    hintEl.textContent = t('win.polar');
    metaEl.textContent = '';
    windowFreshness();
    return;
  }

  var tone = win.level === 2 ? TONE.ok : (win.level === 1 ? TONE.mid : TONE.bad);
  setTone($('window-card'), tone);
  setTone(valueEl, tone);

  valueEl.textContent = fmtTime(win.from) + ' — ' + fmtTime(win.to);

  var quality = t(win.level === 2 ? 'win.q.high' : (win.level === 1 ? 'win.q.mid' : 'win.q.low'));

  var parts = [quality, cloudRangeText(win)];
  if (win.kpMax !== null) parts.push(t('win.kp_max', { v: fmtKp(win.kpMax) }));
  parts.push(t(win.fullDark ? 'win.dark_full' : 'win.dark_part'));
  parts.push(moonWindowText(moonSummary(win.from, win.to, win.point.lat, win.point.lon)));

  hintEl.textContent = parts.join(t('sep.dot')) + t('punct.end');

  // График всей ночи: шанс, облака, Kp и Луна по часам
  renderNightChart(win);

  var meta = t('win.meta', {
    from: fmtTime(win.night[0].time),
    to: fmtTime(new Date(win.night[win.night.length - 1].time.getTime() + 3600000))
  });
  if (win.noKp) meta += t('sep.sentence') + t('win.no_kp');
  metaEl.textContent = meta;

  windowFreshness();
}

/* ------------------------------------------------------------------ */
/*  График ночи: по столбику на час. Высота — доля чистого неба,      */
/*  цвет — шанс в этот час, точка под столбиком — Луна над горизонтом. */
/*  Светлый фон — сумерки, пунктир — лучшее окно. Нажатие на час       */
/*  показывает его подробности (облачность, Kp, Луна) под графиком.   */
/* ------------------------------------------------------------------ */

/** Легенда: цвет — шанс, высота — чистое небо, пунктир — лучшее окно. Для глаза: скринридер читает часы целиком. */
function nightLegend() {
  var legend = document.createElement('div');
  legend.className = 'nchart__legend';
  legend.setAttribute('aria-hidden', 'true');
  var item = function (mod, text, level) {
    var span = document.createElement('span');
    span.className = 'nchart__key nchart__key--' + mod;
    if (level !== undefined) setTone(span, levelTone(level));
    span.textContent = text;
    legend.appendChild(span);
  };
  item('sky', t('nchart.legend.sky'));
  item('level', levelWord(2), 2);
  item('level', levelWord(1), 1);
  item('level', levelWord(0), 0);
  item('best', t('nchart.legend.best'));
  return legend;
}

/** Луна в середине часа: над горизонтом ли и насколько освещена. */
function hourMoon(time, point) {
  var mid = new Date(time.getTime() + 30 * 60000);
  return {
    up: moonAltitude(mid, point.lat, point.lon) > MOON_HORIZON,
    illumination: moonPhase(mid).illumination
  };
}

/** Через сколько часов подписывать время, чтобы подписи не налезали друг на друга. */
function timeLabelStep(count) {
  if (count <= 8) return 1;
  if (count <= 14) return 2;
  if (count <= 20) return 3;
  return 4;
}

/** Подробности часа одной строкой — и под графиком, и для скринридера. */
function nightHourText(h, moon) {
  var parts = [
    fmtTime(h.time) + '–' + fmtTime(new Date(h.time.getTime() + 3600000)),
    levelWord(h.level),
    t('win.cloud_one', { v: h.cloud })
  ];
  if (h.kp !== null && h.kp !== undefined) parts.push(t('hour.kp', { v: fmtKp(h.kp) }));
  parts.push(t(h.alt <= DARK_FULL ? 'win.dark_full' : 'win.dark_part'));
  parts.push(t(moon.up ? 'moon.win.up' : 'moon.win.down', { pct: moonPercent(moon.illumination) }));
  return parts.join(t('sep.dot'));
}

function renderNightChart(win) {
  var box = $('window-hours');
  box.innerHTML = '';

  var night = win.night;
  var step = timeLabelStep(night.length);
  var selected = state.nightHour;
  var inNight = night.some(function (h) { return h.time.getTime() === selected; });
  if (!inNight) selected = win.from.getTime();

  var cols = document.createElement('div');
  cols.className = 'nchart__cols';
  cols.style.setProperty('--cols', String(night.length));
  var detail = '';
  var bestFrom = -1;
  var bestCount = 0;

  night.forEach(function (h, i) {
    var moon = hourMoon(h.time, win.point);
    var inWindow = h.time >= win.from && h.time < win.to;
    if (inWindow) { if (bestFrom < 0) bestFrom = i; bestCount++; }
    var text = nightHourText(h, moon);
    var isSelected = h.time.getTime() === selected;
    if (isSelected) detail = text;

    var col = document.createElement('button');
    col.type = 'button';
    // Текущий час — с отметкой: видно, где на графике «сейчас».
    var isNow = Date.now() >= h.time.getTime() && Date.now() < h.time.getTime() + 3600000;
    col.className = 'ncol' + (inWindow ? ' ncol--best' : '') + (h.alt > DARK_FULL ? ' ncol--twilight' : '') + (isNow ? ' ncol--now' : '');
    col.setAttribute('data-time', String(h.time.getTime()));
    col.setAttribute('aria-pressed', String(isSelected));
    col.setAttribute('aria-label', text);
    col.tabIndex = isSelected ? 0 : -1;

    // Столбик: высота — чистое небо (100% − облачность), цвет — шанс часа
    var plot = document.createElement('span');
    plot.className = 'ncol__plot';
    var bar = document.createElement('span');
    bar.className = 'ncol__bar';
    bar.style.height = (100 - Math.max(0, Math.min(100, h.cloud))) + '%';
    setTone(bar, levelTone(h.level));
    plot.appendChild(bar);

    var moonCell = document.createElement('span');
    moonCell.className = 'ncol__moon' + (moon.up ? ' ncol__moon--up' : '');
    if (moon.up) moonCell.style.setProperty('--moon', String(Math.round((0.25 + 0.75 * moon.illumination) * 100) / 100));

    var time = document.createElement('span');
    time.className = 'ncol__time' + (i % step === 0 ? '' : ' ncol__time--hidden');
    time.textContent = fmtTime(h.time);

    col.appendChild(plot);
    col.appendChild(moonCell);
    col.appendChild(time);
    cols.appendChild(col);
  });

  // Рамка лучшего окна — одна на весь отрезок, а не по кусочку у каждого часа
  if (bestCount) {
    cols.style.setProperty('--best-from', String(bestFrom));
    cols.style.setProperty('--best-count', String(bestCount));
    cols.className += ' nchart__cols--best';
  }

  box.appendChild(nightLegend());
  box.appendChild(cols);
  $('window-detail').textContent = detail;
}

/** Выбор часа мышью, пальцем или стрелками. */
function initNightChart() {
  var box = $('window-hours');
  var choose = function (time, focus) {
    state.nightHour = time;
    renderWindow();
    if (focus) {
      var col = box.querySelector('[data-time="' + time + '"]');
      if (col && col.focus) col.focus();
    }
  };

  box.addEventListener('click', function (e) {
    var col = e.target.closest ? e.target.closest('[data-time]') : null;
    if (col) choose(Number(col.getAttribute('data-time')), false);
  });

  box.addEventListener('keydown', function (e) {
    var step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    var cols = Array.prototype.slice.call(box.querySelectorAll('[data-time]'));
    var index = cols.findIndex(function (c) { return c.getAttribute('aria-pressed') === 'true'; });
    var next = cols[index + step];
    if (!next) return;   // у края дальше некуда
    e.preventDefault();
    choose(Number(next.getAttribute('data-time')), true);
  });
}
