/* Вкладка «Сейчас»: Луна, шкалы и оценка, Kp, солнечный ветер, OVATION, погода, облачность, прогноз Kp.
   Часть приложения: общие переменные и функции — глобальные, порядок подключения задан
   в index.html (см. js/README.md). */
'use strict';

/* ------------------------------------------------------------------ */
/*  Луна: тексты. Расчёт — в core.js.                                  */
/* ------------------------------------------------------------------ */

function moonPercent(illumination) {
  return Math.round(illumination * 100) + '%';
}

/** Фактор в вердикте: «Луна: 92%, над горизонтом». */
function moonFactor(info) {
  return t(info.up ? 'moon.factor.up' : 'moon.factor.down', { pct: moonPercent(info.illumination) });
}

/** Пояснение — только когда Луна действительно мешает. */
function moonHint(impact) {
  if (impact === 'strong') return t('moon.hint.strong');
  if (impact === 'moderate') return t('moon.hint.moderate');
  return '';
}

/**
 * Луна за интервал окна наблюдения одной строкой: «Луна 92%, над горизонтом»,
 * «Луна 92%, зайдёт в 03:14», «Луна 3%, под горизонтом».
 */
function moonWindowText(summary) {
  var pct = moonPercent(summary.illumination);

  if (summary.upShare === 0) return t('moon.win.down', { pct: pct });
  if (summary.upShare === 1) return t('moon.win.up', { pct: pct });

  // И восход, и заход внутри окна: интервал видимости назван целиком, иначе строка
  // «взойдёт в 19:50» умолчала бы, что через четыре часа Луна уже зайдёт.
  if (summary.rise && summary.set) {
    if (summary.rise < summary.set) {
      return t('moon.win.between', { pct: pct, from: fmtTime(summary.rise), to: fmtTime(summary.set) });
    }
    return t('moon.win.set_rise', { pct: pct, set: fmtTime(summary.set), rise: fmtTime(summary.rise) });
  }
  if (summary.set) return t('moon.win.set', { pct: pct, time: fmtTime(summary.set) });
  if (summary.rise) return t('moon.win.rise', { pct: pct, time: fmtTime(summary.rise) });
  return t('moon.win.plain', { pct: pct });
}

/* ------------------------------------------------------------------ */
/*  Шкалы и оценки                                                     */
/* ------------------------------------------------------------------ */

/* Тона — ссылки на переменные CSS: в светлой теме те же слова дают тёмные оттенки, и перерисовка не нужна. */
var TONE = { ok: 'var(--ok)', mid: 'var(--mid)', bad: 'var(--bad)' };

/** Балл за Kp (0..3) для точки; без точки — для выбранной. */
function kpScore(kp, point) {
  return kpScoreAt(kp, point || currentPoint());
}

function kpText(kp, point) {
  point = point || currentPoint();
  var score = kpScore(kp, point);
  var limits = kpThresholds(point);

  if (score === 3) return t(kp >= limits.high + 2 ? 'kp.storm' : 'kp.high');
  if (score === 2) return t('kp.mid');
  if (score === 1) return t('kp.low');
  return t('kp.calm');
}

function kpTone(kp, point) {
  var score = kpScore(kp, point);
  if (score === 3) return TONE.ok;
  if (score >= 1) return TONE.mid;
  return TONE.bad;
}

function cloudText(pct) {
  if (pct <= 25) return t('cloud.clear');
  if (pct <= 50) return t('cloud.partly');
  if (pct <= 75) return t('cloud.mostly');
  return t('cloud.overcast');
}

function cloudTone(pct) {
  if (pct <= 25) return TONE.ok;
  if (pct <= 50) return TONE.mid;
  return TONE.bad;
}

/**
 * Итоговая оценка. Основа — Kp и облачность.
 * Дополнительно учитывается высота Солнца: в полярный день сияние не видно
 * ни при каком Kp, поэтому светлое небо опускает вердикт.
 */
function computeVerdict(kp, cloud) {
  var ks = kp !== null ? kpScore(kp.value, currentPoint()) : null;
  var cs = cloud !== null ? cloudScore(cloud.value, cloud.conflict) : null;

  if (ks === null && cs === null) return null; // считать не из чего

  var partial = (ks === null || cs === null);
  var factors = [];

  factors.push(ks !== null ? t('verdict.f.kp', { v: fmtKp(kp.value) }) : t('verdict.f.kp_none'));
  factors.push(cs !== null ? t('verdict.f.cloud', { v: cloud.value }) : t('verdict.f.cloud_none'));
  if (cloud && cloud.conflict) factors.push(t('verdict.f.conflict'));

  var point = currentPoint();
  var alt = solarAltitude(new Date(), point.lat, point.lon);
  var level = verdictLevel(ks, cs, alt);
  var tooLight = alt > DARK_USABLE;

  // Освещённость неба
  if (tooLight) {
    factors.push(t(alt > 0 ? 'verdict.f.sun_up' : 'verdict.f.twilight'));
  } else if (alt > DARK_FULL) {
    factors.push(t('verdict.f.dark_part'));
  } else {
    factors.push(t('verdict.f.dark'));
  }

  var hint;
  if (level === 'high') {
    hint = t('verdict.hint.high');
  } else if (level === 'mid') {
    hint = t('verdict.hint.mid');
  } else if (tooLight) {
    hint = t('verdict.hint.too_light');
  } else if (cs === 0) {
    hint = t('verdict.hint.cloudy');
  } else if (ks === 0) {
    hint = t('verdict.hint.calm');
  } else {
    hint = t('verdict.hint.bad');
  }
  var gap = t('sep.sentence');

  // Засветка в расчёт не входит — только пояснение. Упоминаем её, когда
  // небо в принципе стоит смотреть: при полярном дне или сплошных облаках
  // совет отъехать от фонарей бесполезен.
  // У своего места засветка неизвестна — не упоминаем.
  if (point.light) {
    factors.push(t('verdict.f.light', { v: t('light.' + point.light + '.label') }));
    if (!tooLight && level !== 'low') hint += gap + t('light.' + point.light + '.hint');
  }

  // Луна, как и засветка, в расчёт уровня не входит — это фактор и пояснение.
  // Упоминаем её, когда небо в принципе стоит смотреть.
  var moon = moonInfo(new Date(), point.lat, point.lon);
  factors.push(moonFactor(moon));
  if (!tooLight && level !== 'low' && moonHint(moon.impact)) hint += gap + moonHint(moon.impact);

  // Туман облачность не показывает: модель видит ясное небо, а над головой молоко.
  var wx = cloud && cloud.weather;
  if (wx && !tooLight && weatherCondition(wx) === 'fog') {
    factors.push(t('verdict.f.fog'));
    hint += gap + t('verdict.hint.fog');
  }

  // Солнечный ветер обещает рост, а сейчас шанс не высокий — стоит сказать, что ждать.
  // Уровень не меняется: это прогноз на час вперёд, а не текущее состояние.
  var sw = state.sw;
  if (sw && !sw.stale && level !== 'high' && !tooLight && cs !== 0 && (sw.level === 'strong' || sw.level === 'south')) {
    hint += gap + t('verdict.hint.sw');
  }

  if (partial) hint += gap + t('verdict.hint.partial');

  return {
    level: level,
    label: t(level === 'high' ? 'level.high' : (level === 'mid' ? 'level.mid' : 'level.low')),
    tone:  level === 'high' ? TONE.ok  : (level === 'mid' ? TONE.mid  : TONE.bad),
    hint: hint,
    factors: factors,
    // Посчитан ли хоть частично по сохранённым данным — от этого зависит,
    // можно ли по нему будить человека уведомлением.
    stale: !!((kp && kp.stale) || (cloud && cloud.stale))
  };
}

/* ------------------------------------------------------------------ */
/*  Kp: текущее значение                                               */
/* ------------------------------------------------------------------ */

function loadKp() {
  // Пока идёт запрос, показываем сохранённое. Иначе при медленной сети
  // карточка стояла пустой до 50 с: основной источник с повтором, затем
  // резервный с повтором — и только потом откат на кэш.
  if (!state.kp) {
    var early = cacheLoad('kp');
    if (early) {
      state.kp = restoreKp(early, true);
      renderKp(state.kp);
    }
  } else if (state.kp.stale) {
    state.kp.refreshing = true;
    renderKp(state.kp);
  }
  markLoading('kp-card');

  return fetchJson(URLS.kpNow)
    .then(readKpSeries)
    .catch(function () {
      // Основной endpoint не отдал данные — пробуем трёхчасовой ряд.
      return fetchJson(URLS.kpNowAlt).then(readKpSeries);
    })
    .then(function (kp) {
      kp.stale = null;
      state.kp = kp;
      cacheSave('kp', { value: kp.value, time: kp.time });
      renderKp(kp);
      return kp;
    })
    .catch(function (err) {
      var cached = cacheLoad('kp');

      if (cached) {
        state.kp = restoreKp(cached, false);
        renderKp(state.kp);
        return state.kp;
      }

      state.kp = null;
      showError('kp-error', 'kp.error', err);
      setState('kp-card', 'error');
      return null;
    });
}

function renderKp(kp) {
  var tone = kpTone(kp.value);
  setTone($('kp-card'), tone);

  var valueEl = $('kp-value');
  valueEl.textContent = fmtKp(kp.value);
  setTone(valueEl, tone);

  $('kp-caption').textContent = kpText(kp.value);

  // Шкала 0..9
  var scale = $('kp-scale');
  var filled = Math.round(kp.value);
  scale.innerHTML = '';
  for (var i = 0; i < 10; i++) {
    var cell = document.createElement('div');
    cell.className = 'scale__cell' + (i <= filled ? ' scale__cell--on' : '');
    if (i <= filled) setTone(cell, tone);
    scale.appendChild(cell);
  }

  var meta = t('kp.scale');
  if (kp.time) {
    var mins = Math.max(0, Math.round((Date.now() - kp.time.getTime()) / 60000));
    meta = t('kp.measured', {
      time: fmtTime(kp.time),
      ago: mins < 1 ? t('age.just_now') : t('age.ago', { value: t('unit.minutes', { n: mins }) })
    });
  }
  $('kp-time').textContent = meta;

  applyFreshness('kp-card', 'kp-stale', kp.stale, kp.refreshing ? LEAD_REFRESHING : LEAD_OFFLINE);
}

/* ------------------------------------------------------------------ */
/*  Солнечный ветер: что будет в ближайший час. Расчёт — в core.js.    */
/* ------------------------------------------------------------------ */

/** Скорость из сводки NOAA: [{ proton_speed, time_tag }]; null, если нет. */
function readSpeed(data) {
  var row = Array.isArray(data) ? data[0] : null;
  return row ? num(row.proton_speed) : null;
}

function restoreSolarWind(cached, refreshing) {
  var sw = cached.payload;
  sw.time = toDate(sw.time);
  sw.stale = cached.age;
  sw.refreshing = !!refreshing;
  return sw;
}

function loadSolarWind() {
  if (!state.sw) {
    var early = cacheLoad('sw');
    if (early) {
      state.sw = restoreSolarWind(early, true);
      renderSolarWind(state.sw);
    }
  } else if (state.sw.stale) {
    state.sw.refreshing = true;
    renderSolarWind(state.sw);
  }
  markLoading('sw-card');

  // Скорость необязательна: без неё нет только оценки времени в пути до Земли.
  var speed = fetchJson(URLS.swSpeed).then(readSpeed, function () { return null; });

  return Promise.all([fetchJson(URLS.swMag), speed])
    .then(function (results) {
      var summary = solarWindSummary(results[0], Date.now());
      if (!summary) throw appError('sw_stale');

      var sw = {
        time: summary.time, bz: summary.bz, bt: summary.bt, level: summary.level,
        southMinutes: summary.southMinutes, series: summary.series, speed: results[1], stale: null
      };
      state.sw = sw;
      cacheSave('sw', sw);
      renderSolarWind(sw);
      return sw;
    })
    .catch(function (err) {
      var cached = cacheLoad('sw');
      if (cached) {
        state.sw = restoreSolarWind(cached, false);
        renderSolarWind(state.sw);
        return state.sw;
      }
      state.sw = null;
      showError('sw-error', 'sw.error', err);
      setState('sw-card', 'error');
      return null;
    });
}

var SW_TONE = { strong: 'ok', south: 'ok', weak: 'mid', north: 'bad' };

/** Подсказка «что будет в ближайший час» — используется и в карточке, и в вердикте. */
function solarWindOutlook(sw) {
  if (sw.level === 'south') return t('sw.outlook.south', { dur: t('unit.minutes', { n: Math.max(sw.southMinutes, 1) }) });
  return t('sw.outlook.' + sw.level);
}

function fmtSigned(value) {
  // Настоящий минус, а не дефис: так читается «−7», а не «-7».
  return (value > 0 ? '+' : value < 0 ? '−' : '') + fmtNum(Math.abs(value).toFixed(1));
}

function renderSolarWind(sw) {
  var tone = TONE[SW_TONE[sw.level]];
  setTone($('sw-card'), tone);

  var value = $('sw-value');
  value.textContent = t('unit.nt', { v: fmtSigned(sw.bz) });
  setTone(value, tone);

  $('sw-caption').textContent = solarWindOutlook(sw);

  var facts = [];
  if (sw.bt !== null && sw.bt !== undefined) facts.push(t('sw.bt', { v: t('unit.nt', { v: fmtNum(sw.bt.toFixed(1)) }) }));
  if (sw.speed) facts.push(t('sw.speed', { v: t('unit.kms', { v: Math.round(sw.speed) }) }));
  var lead = solarWindLeadMinutes(sw.speed);
  if (lead) facts.push(t('sw.lead', { dur: t('unit.minutes', { n: lead }) }));
  $('sw-facts').textContent = facts.join(t('sep.dot'));

  renderSolarWindChart(sw.series || []);
  $('sw-meta').textContent = sw.time ? t('sw.meta', { time: fmtTime(sw.time) }) +
    (sw.fallback ? t('sep.dot') + t('sw.backup', { source: sw.source }) : '') : '';

  applyFreshness('sw-card', 'sw-stale', sw.stale, sw.refreshing ? LEAD_REFRESHING : LEAD_OFFLINE);
}

/**
 * Bz за два часа столбиками по 5 минут: вниз — южный (хорошо для сияния), вверх — северный.
 * Шкала — не меньше ±10 нТл и не меньше самого сильного отсчёта: в спокойный день
 * столбики не сливаются в линию, а в бурю не упираются в край.
 */
function renderSolarWindChart(series) {
  var box = $('sw-chart');
  box.innerHTML = '';
  if (!series.length) return;

  var end = series[series.length - 1].time;
  var BUCKET = 5 * 60000, COUNT = 24;
  var buckets = [];
  for (var k = COUNT - 1; k >= 0; k--) {
    var from = end - (k + 1) * BUCKET, to = end - k * BUCKET;
    var sum = 0, n = 0;
    for (var i = 0; i < series.length; i++) {
      if (series[i].time > from && series[i].time <= to) { sum += series[i].bz; n++; }
    }
    buckets.push(n ? sum / n : null);
  }
  var LIMIT = Math.max.apply(null, [10].concat(buckets.map(function (v) { return v === null ? 0 : Math.abs(v); })));

  buckets.forEach(function (value) {
    var bar = document.createElement('div');
    var fill = document.createElement('div');
    fill.className = 'swbar__fill';
    if (value !== null) {
      var bz = value;
      bar.className = 'swbar ' + (bz < 0 ? 'swbar--south' : 'swbar--north');
      fill.style.height = Math.max(Math.min(Math.abs(bz), LIMIT) / LIMIT * 50, 1.5) + '%';
      setTone(fill, bz <= -5 ? TONE.ok : bz < 0 ? TONE.mid : TONE.bad);
    } else {
      bar.className = 'swbar swbar--gap';   // пропуск в данных — спутники иногда молчат
    }
    bar.appendChild(fill);
    box.appendChild(bar);
  });
}

/* ------------------------------------------------------------------ */
/*  NOAA OVATION: вероятность сияния на ближайшие 30–90 минут.         */
/*  Расчёт по сетке — в core.js; здесь загрузка и карточка.            */
/* ------------------------------------------------------------------ */

/* Модель обновляется каждые несколько минут, но файл велик: чаще раза в 15 минут
   не запрашиваем — сохранённый ответ этого возраста считается свежим. */
var OVATION_REFRESH_MS = 15 * 60 * 1000;

function restoreOvation(cached, age) {
  var ov = cached.payload;
  ov.observed = toDate(ov.observed);
  ov.forecast = toDate(ov.forecast);
  ov.stale = age;
  return ov;
}

/** force — по кнопке «Повторить»: тогда запрашиваем, даже если сохранённое свежее. */
function loadOvation(force) {
  var cached = cacheLoad('ovation');
  if (cached && !force && cached.age < OVATION_REFRESH_MS) {
    state.ov = restoreOvation(cached, null);
    renderOvation();
    return Promise.resolve(state.ov);
  }
  if (!state.ov && cached) {
    state.ov = restoreOvation(cached, cached.age);
    renderOvation();
  }
  markLoading('ov-card');

  return fetchJson(URLS.ovation)
    .then(function (data) {
      var summary = ovationSummary(data, allPoints(), Date.now());
      if (!summary) throw appError('ov_stale');
      var ov = { observed: summary.observed, forecast: summary.forecast, points: summary.points, stale: null };
      // В кэш — только числа по семи точкам, а не вся сетка Земли.
      cacheSave('ovation', { observed: ov.observed, forecast: ov.forecast, points: ov.points });
      state.ov = ov;
      renderOvation();
      return ov;
    })
    .catch(function (err) {
      var fallback = cacheLoad('ovation');
      if (fallback) {
        state.ov = restoreOvation(fallback, fallback.age);
        renderOvation();
        return state.ov;
      }
      state.ov = null;
      showError('ov-error', 'ov.error', err);
      setState('ov-card', 'error');
      return null;
    });
}

/** Уровень по вероятности в поле зрения: пороги как у NOAA на карте «вероятности сияния». */
function ovationLevel(view) {
  if (view >= 50) return 'high';
  if (view >= 30) return 'mid';
  if (view >= 10) return 'low';
  return 'none';
}

var OV_TONE = { high: 'ok', mid: 'ok', low: 'mid', none: 'bad' };

function renderOvation() {
  var ov = state.ov;
  if (!ov) return;
  var values = ov.points && ov.points[currentPoint().id];
  if (!values) {
    setState('ov-card', 'error');
    $('ov-error').textContent = t('ov.error.default');
    return;
  }

  var level = ovationLevel(values.view);
  var tone = TONE[OV_TONE[level]];
  setTone($('ov-card'), tone);

  var value = $('ov-value');
  value.textContent = Math.round(values.view) + '%';
  setTone(value, tone);

  $('ov-caption').textContent = t('ov.level.' + level);

  var facts = [t('ov.overhead', { v: Math.round(values.overhead) + '%' })];
  if (ov.forecast) facts.push(t('ov.forecast', { time: fmtTime(ov.forecast) }));
  $('ov-facts').textContent = facts.join(t('sep.dot'));

  applyFreshness('ov-card', 'ov-stale', ov.stale, LEAD_OFFLINE);
}

/* ------------------------------------------------------------------ */
/*  Погода для наблюдателя: ветер, осадки, видимость.                  */
/*  Приходит тем же запросом, что и облачность, и хранится вместе с ней. */
/* ------------------------------------------------------------------ */

/** Поля current из Open-Meteo → погода в единицах СИ (ветер — м/с). Нет поля — null. */
function readWeather(cur) {
  if (!cur) return null;
  var kmh = function (v) { v = num(v); return v === null ? null : Math.round(v / 3.6 * 10) / 10; };
  return {
    temp: num(cur.temperature_2m),
    feels: num(cur.apparent_temperature),
    wind: kmh(cur.wind_speed_10m),
    gusts: kmh(cur.wind_gusts_10m),
    dir: num(cur.wind_direction_10m),
    precip: num(cur.precipitation),
    rain: num(cur.rain),
    snow: num(cur.snowfall),
    code: num(cur.weather_code),
    vis: num(cur.visibility),
    humidity: num(cur.relative_humidity_2m)
  };
}

/* Коды погоды ВМО: 45, 48 — туман; 51–67, 80–82 — морось и дождь; 71–77, 85–86 — снег; 95–99 — гроза. */
var FOG_VISIBILITY_M = 1000;   // так метеорологи и определяют туман
var WINDY_GUSTS_MS = 15;       // порывы от 15 м/с — на открытом месте тяжело стоять и снимать

/** Главное, что мешает наблюдению, одним словом: fog, snow, rain, windy или clear. */
function weatherCondition(wx) {
  var code = wx.code;
  if (code === 45 || code === 48 || (wx.vis !== null && wx.vis < FOG_VISIBILITY_M)) return 'fog';
  if (wx.snow > 0 || (code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (wx.rain > 0 || wx.precip > 0 || (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95) return 'rain';
  if (wx.gusts !== null && wx.gusts >= WINDY_GUSTS_MS) return 'windy';
  return 'clear';
}

var WX_TONE = { clear: 'ok', windy: 'mid', snow: 'mid', rain: 'bad', fog: 'bad' };

/** Скорость ветра в выбранных единицах: м/с или мили в час (если расстояния в милях). */
function windText(ms) {
  if (setting('dist') === 'mi') return t('unit.mph', { v: Math.round(ms * 2.23694) });
  return t('unit.ms', { v: Math.round(ms) });
}

/** Видимость: «26 км», «800 м» либо в милях. */
function visibilityText(m) {
  if (setting('dist') === 'mi') return t('unit.mi', { n: Math.max(1, Math.round(m / 1609.34)) });
  if (m < 1000) return t('unit.m', { v: Math.round(m / 100) * 100 });
  return t('unit.km', { n: Math.round(m / 1000) });
}

/** Откуда дует ветер — одна из восьми сторон. */
function windDirText(deg) {
  return t('wind.dir.' + (Math.round((((deg % 360) + 360) % 360) / 45) % 8));
}

function renderWeather(cloud) {
  var wx = cloud && cloud.weather;
  if (!wx || wx.temp === null) {
    setState('wx-card', 'error');
    return;
  }

  var condition = weatherCondition(wx);
  var tone = TONE[WX_TONE[condition]];
  setTone($('wx-card'), tone);

  var value = $('wx-value');
  value.textContent = tempText(wx.temp);

  $('wx-caption').textContent = t('wx.' + condition);

  var facts = [];
  if (wx.feels !== null) facts.push(t('wx.feels', { v: tempText(wx.feels) }));
  if (wx.wind !== null) {
    var wind = t('wx.wind', { v: windText(wx.wind) });
    if (wx.gusts !== null && wx.gusts > wx.wind + 2) wind += t('sep.list') + t('wx.gusts', { v: windText(wx.gusts) });
    if (wx.dir !== null && wx.wind >= 1) wind += t('sep.list') + windDirText(wx.dir);
    facts.push(wind);
  }
  if (wx.vis !== null) facts.push(t('wx.vis', { v: visibilityText(wx.vis) }));
  if (wx.humidity !== null) facts.push(t('wx.humidity', { v: Math.round(wx.humidity) + '%' }));
  $('wx-facts').textContent = facts.join(t('sep.dot'));

  applyFreshness('wx-card', 'wx-stale', cloud.stale, cloud.refreshing ? LEAD_REFRESHING : LEAD_OFFLINE);
}

/* ------------------------------------------------------------------ */
/*  Облачность                                                         */
/* ------------------------------------------------------------------ */

function loadCloud() {
  var point = currentPoint();

  // Сохранённое показываем сразу, не дожидаясь сети (до 25 с при таймауте).
  if (!state.cloud) {
    var early = cacheLoad(cloudCacheKey(point));
    if (early) {
      state.cloud = restoreCloud(early, point, true);
      renderCloud(state.cloud);
    }
  } else if (state.cloud.stale) {
    state.cloud.refreshing = true;
    renderCloud(state.cloud);
  }
  markLoading('cloud-card');

  // Каждый запрос получает номер, и ответ применяется, только если за время
  // ожидания не ушёл более новый. Иначе при быстрой смене городов медленный
  // ответ по прежнему городу приходил вторым и перезаписывал данные выбранного.
  var seq = ++state.cloudSeq;
  var isLatest = function () { return seq === state.cloudSeq; };
  state.cloudPending = true;

  return fetchJson(weatherUrl(point))
    .then(function (data) {
      var cur = data && data.current;
      var parsed = cloudFromCurrent(cur);

      // Без ярусов оценка всё равно возможна — по общей облачности.
      if (parsed === null) throw appError('no_cloud');

      var cloud = {
        value: parsed.value,
        byLayers: parsed.byLayers,
        conflict: parsed.conflict,
        total: parsed.total,
        layers: parsed.layers,
        temp: num(cur.temperature_2m) === null ? null : Math.round(num(cur.temperature_2m)),
        weather: readWeather(cur),
        time: parseUtc(cur.time),
        soon: pickCloudIn(data, 3),
        hours: readHourlyCloud(data),
        pointId: point.id,
        stale: null
      };

      // Данные верны для своей точки, поэтому в кэш кладём в любом случае —
      // а показываем, только если это ответ на последний запрос.
      cacheSave(cloudCacheKey(point), cloud);
      if (!isLatest()) return null;

      state.cloudPending = false;
      state.cloud = cloud;
      renderCloud(cloud);
      return cloud;
    })
    .catch(function (err) {
      if (!isLatest()) return null;
      state.cloudPending = false;

      var cached = cacheLoad(cloudCacheKey(point));

      if (cached) {
        state.cloud = restoreCloud(cached, point, false);
        renderCloud(state.cloud);
        return state.cloud;
      }

      state.cloud = null;
      showError('cloud-error', 'cloud.error', err);
      setState('cloud-card', 'error');
      setState('wx-card', 'error');
      return null;
    });
}

/**
 * Весь почасовой ряд облачности: [{ time: '2026-09-17T18:00', cloud: 78 }, …].
 * Метки времени остаются строками — так они переживают JSON в кэше и
 * разбираются тем же parseUtc(), что и свежие.
 */
function readHourlyCloud(data) {
  var out = [];
  try {
    var hourly = data.hourly;
    for (var i = 0; i < hourly.time.length; i++) {
      var value = effectiveCloud(readLayers(hourly, i));
      if (value === null) value = num(hourly.cloud_cover ? hourly.cloud_cover[i] : null);
      if (value === null) continue;
      out.push({ time: hourly.time[i], cloud: Math.round(value) });
    }
  } catch (e) { /* почасовых данных нет — окно наблюдения просто не покажем */ }
  return out;
}

/** Эффективная облачность через N часов из почасового ряда (или null). */
function pickCloudIn(data, hours) {
  try {
    var hourly = data.hourly;
    var times = hourly.time;
    var target = Date.now() + hours * 3600000;

    for (var i = 0; i < times.length; i++) {
      var t = parseUtc(times[i]);
      if (!t || t.getTime() < target) continue;

      var value = effectiveCloud(readLayers(hourly, i));
      if (value === null) value = num(hourly.cloud_cover ? hourly.cloud_cover[i] : null);
      if (value !== null) return { value: Math.round(value), time: t };
    }
  } catch (e) { /* почасовых данных нет — не критично */ }
  return null;
}

function renderCloud(cloud) {
  var tone = cloudTone(cloud.value);
  setTone($('cloud-card'), tone);

  var valueEl = $('cloud-value');
  valueEl.textContent = cloud.value + '%';
  setTone(valueEl, tone);

  $('cloud-caption').textContent = cloudText(cloud.value);

  var fill = $('cloud-fill');
  fill.style.width = cloud.value + '%';
  setTone(fill, tone);

  renderCloudLayers(cloud);

  var warn = $('cloud-warn');
  warn.hidden = !cloud.conflict;
  if (cloud.conflict) {
    warn.textContent = t('cloud.warn', { layers: cloud.value, total: Math.round(cloud.total) });
  }

  var parts = [];
  if (cloud.soon) parts.push(t('cloud.meta.soon', { time: fmtTime(cloud.soon.time), v: cloud.soon.value }));
  if (cloud.time) parts.push(t('cloud.meta.time', { time: fmtTime(cloud.time) }));
  $('cloud-meta').textContent = parts.join(' · ');

  applyFreshness('cloud-card', 'cloud-stale', cloud.stale, cloud.refreshing ? LEAD_REFRESHING : LEAD_OFFLINE);
  renderWeather(cloud);
}

/** Полоски по ярусам и пояснение к весам. */
function renderCloudLayers(cloud) {
  var box = $('cloud-layers');
  var note = $('cloud-note');

  if (!cloud.byLayers) {
    // Ярусов нет — показываем только общий показатель и говорим об этом прямо.
    box.hidden = true;
    note.textContent = t('cloud.note.no_layers');
    return;
  }

  box.hidden = false;

  CLOUD_LAYERS.forEach(function (layer) {
    var row = box.querySelector('[data-layer="' + layer.key + '"]');
    if (!row) return;

    var value = cloud.layers[layer.key];
    var known = value !== null;

    row.querySelector('.layer__val').textContent = known ? Math.round(value) + '%' : '—';

    var bar = row.querySelector('.layer__fill');
    bar.style.width = (known ? Math.round(value) : 0) + '%';
    setTone(bar, cloudTone(known ? value : 0));
  });

  var weights = CLOUD_LAYERS.map(function (layer) {
    // Целый вес печатаем как «1,0», а не «1», чтобы ряд читался единообразно.
    var weight = Number.isInteger(layer.weight) ? layer.weight.toFixed(1) : String(layer.weight);
    return t('layer.' + layer.key).toLowerCase() + ' ×' + fmtNum(weight);
  }).join(t('sep.list'));

  note.textContent = t('cloud.note.layers', { weights: weights }) +
    (cloud.total !== null ? t('sep.sentence') + t('cloud.note.total', { v: Math.round(cloud.total) }) : '');
}

/* ------------------------------------------------------------------ */
/*  Прогноз Kp на 3 суток                                              */
/* ------------------------------------------------------------------ */

function loadForecast() {
  if (!state.forecast) {
    var early = cacheLoad('forecast');
    var earlyRows = early ? buildForecastRows(early.payload) : [];
    if (earlyRows.length) {
      state.forecast = earlyRows;
      state.forecastAge = early.age;
      renderForecast(earlyRows, early.age, true);
    }
  } else if (state.forecastAge) {
    renderForecast(state.forecast, state.forecastAge, true);
  }
  markLoading('forecast-card');

  return fetchJson(URLS.kpForecast)
    .then(function (data) {
      var source = normalizeRows(data);
      var rows = buildForecastRows(source);

      if (!rows.length) throw appError('no_values');

      // Кэшируем исходные строки, а не готовые ячейки: за время хранения часть
      // трёхчасовок уйдёт в прошлое, и при восстановлении их надо отфильтровать
      // заново — иначе подсветка «сейчас» встанет не на ту ячейку.
      cacheSave('forecast', source);
      state.forecast = rows;
      state.forecastAge = null;
      renderForecast(rows, null);
      return rows;
    })
    .catch(function (err) {
      var cached = cacheLoad('forecast');

      if (cached) {
        var rows = buildForecastRows(cached.payload);
        if (rows.length) {
          state.forecast = rows;
          state.forecastAge = cached.age;
          renderForecast(rows, cached.age, false);
          return rows;
        }
        cacheDrop('forecast'); // весь сохранённый прогноз уже в прошлом
      }

      showError('forecast-error', 'forecast.error', err);
      setState('forecast-card', 'error');
      return null;
    });
}

/** Строки NOAA -> ячейки прогноза: только будущее, максимум 24 трёхчасовки. */
function buildForecastRows(source) {
  var now = Date.now();
  var rows = [];

  for (var i = 0; i < source.length; i++) {
    var t = parseUtc(source[i].time_tag);
    var v = pickKpValue(source[i]);
    if (!t || !isFinite(v)) continue;
    if (t.getTime() + 3 * 3600000 < now) continue; // прошедшие трёхчасовки пропускаем
    rows.push({ time: t, value: v, current: t.getTime() <= now });
    if (rows.length >= 24) break;
  }

  return rows;
}

function renderForecast(rows, ageMs, refreshing) {
  var list = $('forecast-list');
  list.innerHTML = '';
  var lastDay = '';

  rows.forEach(function (row) {
    var slot = document.createElement('div');
    slot.className = 'slot' + (row.current ? ' slot--now' : '');

    var dayKey = fmtDayKey(row.time);
    var dayEl = document.createElement('div');
    dayEl.className = 'slot__day';
    dayEl.textContent = (dayKey !== lastDay) ? fmtWeekday(row.time) : ' ';
    lastDay = dayKey;

    var kpEl = document.createElement('div');
    kpEl.className = 'slot__kp';
    kpEl.textContent = fmtKp(row.value);
    setTone(kpEl, kpTone(row.value));

    var timeEl = document.createElement('div');
    timeEl.className = 'slot__time';
    timeEl.textContent = row.current ? t('forecast.now') : fmtTime(row.time);

    slot.appendChild(dayEl);
    slot.appendChild(kpEl);
    slot.appendChild(timeEl);
    list.appendChild(slot);
  });

  applyFreshness('forecast-card', 'forecast-stale', ageMs === undefined ? null : ageMs,
    refreshing ? LEAD_REFRESHING : LEAD_OFFLINE);
}
