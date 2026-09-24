/* «Прошлые ночи»: как было в последние ночи у выбранной точки — по тем же правилам, что прогноз.
   Часть приложения: общие переменные и функции — глобальные, порядок подключения задан
   в index.html (см. js/README.md). */
'use strict';

/* ------------------------------------------------------------------ */
/*  Прошлые ночи                                                       */
/*                                                                     */
/*  Kp — измеренный NOAA за последние 7 суток (трёхчасовки), облачность */
/*  — та же модель ICON-EU за прошлые дни (Open-Meteo, past_days).      */
/*  Каждая тёмная ночь оценивается по часам функцией hourLevel, как     */
/*  окно наблюдения: видно, что вы пропустили и как часто здесь бывает  */
/*  шанс. Два небольших запроса, только при открытии вкладки.           */
/* ------------------------------------------------------------------ */

var HISTORY = {
  days: 7,
  refreshMs: 60 * 60 * 1000,     // прошлое не меняется — раз в час достаточно
  kpUrl: 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json'
};

/** Облачность за прошлые дни для точки: та же модель и те же ярусы, что у прогноза. */
function historyCloudUrl(point) {
  return 'https://api.open-meteo.com/v1/forecast'
    + '?latitude=' + point.lat + '&longitude=' + point.lon
    + '&hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high'
    + '&models=' + CONFIG.weatherModel
    + '&past_days=' + HISTORY.days + '&forecast_days=1&timezone=UTC';
}

/** Измеренные Kp по трёхчасовкам: [{ time: Date, value }] по возрастанию. */
function readKpHistory(data) {
  return normalizeRows(data).map(function (row) {
    return { time: parseUtc(row.time_tag), value: pickKpValue(row) };
  }).filter(function (r) { return r.time && isFinite(r.value); })
    .sort(function (a, b) { return a.time - b.time; });
}

/**
 * Прошедшие ночи, новые сверху. hours — [{ time, cloud }] (как readHourlyCloud), kpRows —
 * readKpHistory. Ночь — непрерывный тёмный отрезок, закончившийся до now; обрезанная началом
 * данных не берётся (её начала мы не видели). Для каждой: лучший уровень и его часы, Kp и облака.
 */
function computePastNights(hours, kpRows, point, now) {
  var list = [];
  var run = [];
  var truncated = true;   // первый отрезок мог начаться раньше данных

  function close() {
    if (run.length && !truncated) list.push(summarizeNight(run, point));
    run = [];
  }

  for (var i = 0; i < hours.length; i++) {
    var t = parseUtc(hours[i].time);
    if (!t) continue;
    if (t.getTime() + 3600000 > now) break;   // дальше — не прошлое
    var alt = solarAltitude(t, point.lat, point.lon);
    if (alt <= DARK_USABLE) {
      run.push({ time: t, cloud: hours[i].cloud, alt: alt, kp: kpAt(t, kpRows, null) });
    } else {
      close();
      truncated = false;
    }
  }
  // Незакончившаяся ночь (идёт сейчас) — не прошлое: её показывает окно наблюдения.
  return list.reverse();
}

function summarizeNight(run, point) {
  var best = -1;
  run.forEach(function (h) {
    h.level = hourLevel(h.kp, h.cloud, h.alt, false, point);
    if (h.level > best) best = h.level;
  });
  var at = run.filter(function (h) { return h.level === best; });
  var kps = run.map(function (h) { return h.kp; }).filter(function (v) { return v !== null && v !== undefined; });
  return {
    from: run[0].time,
    to: new Date(run[run.length - 1].time.getTime() + 3600000),
    level: best,
    bestFrom: at[0].time,
    bestHours: at.length,
    kpMax: kps.length ? Math.max.apply(null, kps) : null,
    cloudMin: Math.min.apply(null, run.map(function (h) { return h.cloud; }))
  };
}

/** «Ср, 23.09» — по вечеру ночи, в выбранном поясе. */
function fmtNightDate(date) {
  var zone = displayZone();
  var opts = zone ? { timeZone: zone } : {};
  var weekday = new Intl.DateTimeFormat(langLocale(), Object.assign({ weekday: 'short' }, opts)).format(date);
  var day = new Intl.DateTimeFormat(langLocale(), Object.assign({ day: 'numeric', month: 'short' }, opts)).format(date);
  return weekday + ' ' + day;
}

function loadHistory(force) {
  var point = currentPoint();
  var key = 'history-' + point.id;
  if (!force && state.history && state.history.pointId === point.id && Date.now() - state.history.loadedAt < HISTORY.refreshMs) {
    renderHistory();
    return Promise.resolve(state.history);
  }
  if (!state.history || state.history.pointId !== point.id) {
    var cached = cacheLoad(key);
    state.history = cached ? { pointId: point.id, hours: cached.payload.hours, kp: cached.payload.kp.map(function (r) {
      return { time: new Date(r.time), value: r.value };
    }), loadedAt: Date.now() - cached.age, stale: cached.age } : null;
    renderHistory();
  }
  markLoading('history-card');

  return Promise.all([fetchJson(HISTORY.kpUrl), fetchJson(historyCloudUrl(point))])
    .then(function (res) {
      var kp = readKpHistory(res[0]);
      var hours = readHourlyCloud(res[1]);
      if (!kp.length || !hours.length) throw appError('no_values');
      state.history = { pointId: point.id, hours: hours, kp: kp, loadedAt: Date.now(), stale: null };
      cacheSave(key, { hours: hours, kp: kp.map(function (r) { return { time: r.time.getTime(), value: r.value }; }) });
      renderHistory();
      return state.history;
    })
    .catch(function (err) {
      if (state.history && state.history.pointId === point.id) { renderHistory(); return state.history; }
      showError('history-error', 'history.error', err);
      setState('history-card', 'error');
      return null;
    });
}

var HISTORY_TONE = ['bad', 'mid', 'ok'];

function renderHistory() {
  var box = $('history-list');
  if (!box) return;
  var h = state.history;
  if (!h || h.pointId !== currentPoint().id) return;

  var point = currentPoint();
  var nights = computePastNights(h.hours, h.kp, point, Date.now()).slice(0, HISTORY.days);
  box.innerHTML = '';
  $('history-title-point').textContent = pointName(point);

  if (!nights.length) {
    $('history-summary').textContent = t('history.polar');
  } else {
    var good = nights.filter(function (n) { return n.level >= 1; }).length;
    $('history-summary').textContent = t('history.summary', { n: nights.length, good: good, nights: t('history.nights', { n: good }) });
  }

  nights.forEach(function (n) {
    var row = document.createElement('li');
    row.className = 'hnight';
    setTone(row, TONE[HISTORY_TONE[n.level]]);

    var date = document.createElement('span');
    date.className = 'hnight__date';
    date.textContent = fmtNightDate(n.from);

    var level = document.createElement('span');
    level.className = 'hnight__level';
    level.textContent = levelWord(n.level);

    var facts = document.createElement('span');
    facts.className = 'hnight__facts';
    var parts = [];
    if (n.kpMax !== null) parts.push(t('win.kp_max', { v: fmtKp(n.kpMax) }));
    parts.push(t('history.cloud_min', { v: n.cloudMin }));
    if (n.level >= 1) parts.push(t('history.best', { time: fmtTime(n.bestFrom), hours: t('unit.hours', { n: n.bestHours }) }));
    facts.textContent = parts.join(t('sep.dot'));

    row.appendChild(date);
    row.appendChild(level);
    row.appendChild(facts);
    box.appendChild(row);
  });

  applyFreshness('history-card', 'history-stale', h.stale, LEAD_OFFLINE);
}

/* ------------------------------------------------------------------ */
/*  Насколько сбывается прогноз                                        */
/*                                                                     */
/*  Сервер каждый вечер записывает прогноз на ночь для семи точек, а    */
/*  утром сверяет его с измеренными данными (worker/src/verify.js).     */
/*  Здесь — итог за последние 60 ночей. Пока сверено меньше пяти ночей, */
/*  цифр не показываем: по двум-трём ночам они ничего не значат.        */
/* ------------------------------------------------------------------ */

var ACCURACY = { minNights: 5, refreshMs: 60 * 60 * 1000 };

function loadAccuracy(force) {
  if (!pushConfigured()) { renderAccuracy(); return Promise.resolve(null); }
  if (!force && state.accuracy && Date.now() - state.accuracy.loadedAt < ACCURACY.refreshMs) {
    renderAccuracy();
    return Promise.resolve(state.accuracy);
  }
  return fetchJson(AURORA_CONFIG.pushApi + '/verify')
    .then(function (data) {
      if (!data || typeof data.total !== 'number') throw appError('bad_format');
      state.accuracy = { data: data, loadedAt: Date.now() };
      renderAccuracy();
      return state.accuracy;
    })
    .catch(function () {
      renderAccuracy();
      return null;
    });
}

/** Текст итога: доля совпадений, промахи, что было при обещанном высоком шансе. */
function accuracyText(d) {
  if (!d || d.nights < ACCURACY.minNights) {
    return t('accuracy.collecting', { n: d ? d.nights : 0, min: ACCURACY.minNights });
  }
  var text = t('accuracy.main', {
    nights: t('history.nights', { n: d.nights }),
    pct: Math.round(100 * d.exact / Math.max(1, d.total)),
    exact: d.exact, total: d.total, one: d.offByOne, two: d.offByTwo
  });
  var high = d.promised && d.promised.high;
  if (high && high.n) text += ' ' + t('accuracy.high', { ok: high.high + high.mid, n: high.n });
  return text;
}

function renderAccuracy() {
  var card = $('accuracy-card');
  if (!card) return;
  card.hidden = !pushConfigured() || !state.accuracy;
  if (card.hidden) return;
  $('accuracy-text').textContent = accuracyText(state.accuracy.data);
}
