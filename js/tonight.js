/* Вкладка «Куда ехать ночью»: окна по семи точкам и прогноз NOAA на 27 дней.
   Часть приложения: общие переменные и функции — глобальные, порядок подключения задан
   в index.html (см. js/README.md). */
'use strict';

/* ------------------------------------------------------------------ */
/*  Вкладка «Куда ехать ночью»                                         */
/*                                                                     */
/*  Облачность для всех семи точек берётся одним запросом, Kp и его     */
/*  прогноз переиспользуются с первой вкладки — они планетарные.        */
/*  Запрос уходит при первом открытии вкладки, не при старте.           */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Когда ехать: прогноз NOAA на 27 дней. Разбор и оценка — в core.js. */
/* ------------------------------------------------------------------ */

/* Таблица выходит раз в неделю: чаще раза в 6 часов её не запрашиваем. */
var OUTLOOK_REFRESH_MS = 6 * 60 * 60 * 1000;
var OUTLOOK_CACHE_MS = 8 * 24 * 60 * 60 * 1000;   // прошлогодняя неделя бесполезна, но недельная — годится

var outlookInFlight = null;

function restoreOutlook(payload, age) {
  return { issued: toDate(payload.issued), days: payload.days, stale: age };
}

/** Сохранённый прогноз живёт дольше обычных трёх часов: он и выходит раз в неделю. */
function outlookCacheLoad() {
  try {
    var raw = localStorage.getItem(CACHE.prefix + 'outlook');
    if (!raw) return null;
    var entry = JSON.parse(raw);
    var age = Date.now() - entry.savedAt;
    if (!isFinite(age) || age < 0 || age > OUTLOOK_CACHE_MS) return null;
    return { payload: entry.payload, age: age };
  } catch (e) {
    return null;
  }
}

function loadOutlook(force) {
  var cached = outlookCacheLoad();
  if (cached && !force && cached.age < OUTLOOK_REFRESH_MS) {
    state.outlook = restoreOutlook(cached.payload, null);
    renderOutlook();
    return Promise.resolve(state.outlook);
  }
  if (outlookInFlight) return outlookInFlight;
  if (!state.outlook && cached) {
    state.outlook = restoreOutlook(cached.payload, cached.age);
    renderOutlook();
  }
  markLoading('outlook-card');

  outlookInFlight = fetchText(URLS.outlook)
    .then(function (text) {
      var parsed = parseOutlook27(text);
      if (!parsed) throw appError('outlook_format');
      cacheSave('outlook', parsed);
      state.outlook = { issued: parsed.issued, days: parsed.days, stale: null };
      renderOutlook();
      return state.outlook;
    })
    .catch(function (err) {
      var fallback = outlookCacheLoad();
      if (fallback) {
        state.outlook = restoreOutlook(fallback.payload, fallback.age);
        renderOutlook();
        return state.outlook;
      }
      state.outlook = null;
      showError('outlook-error', 'outlook.error', err);
      setState('outlook-card', 'error');
      return null;
    })
    .finally(function () { outlookInFlight = null; });
  return outlookInFlight;
}

/** Дата прогноза (сутки UTC): «Ср, 24.09». Пояс UTC — это календарная дата, а не момент. */
function fmtOutlookDay(iso) {
  var date = new Date(iso + 'T12:00:00Z');
  return {
    weekday: new Intl.DateTimeFormat(langLocale(), { timeZone: 'UTC', weekday: 'short' }).format(date),
    day: new Intl.DateTimeFormat(langLocale(), { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(date)
  };
}

/** «4 октября» — в сводке лучших дат месяц полностью: сокращение «окт.» давало «окт..» в конце фразы. */
function fmtOutlookLong(iso) {
  return new Intl.DateTimeFormat(langLocale(), { timeZone: 'UTC', day: 'numeric', month: 'long' })
    .format(new Date(iso + 'T12:00:00Z'));
}

function fmtOutlookRange(range) {
  var from = fmtOutlookLong(range.from);
  return range.from === range.to ? from : t('outlook.range', { from: from, to: fmtOutlookLong(range.to) });
}

var OUTLOOK_TONE = { high: 'ok', mid: 'mid', low: 'bad' };

function renderOutlook() {
  var outlook = state.outlook;
  if (!outlook) return;

  var point = currentPoint();
  var days = outlookDays(outlook, point, Date.now());
  var grid = $('outlook-grid');
  grid.innerHTML = '';

  if (!days.length) {
    setState('outlook-card', 'error');
    $('outlook-error').textContent = t('outlook.expired');
    return;
  }

  days.forEach(function (day) {
    var label = fmtOutlookDay(day.date);
    var cell = document.createElement('div');
    cell.className = 'oday' + (day.dark ? '' : ' oday--light');
    setTone(cell, TONE[OUTLOOK_TONE[day.level]]);

    var head = document.createElement('div');
    head.className = 'oday__date';
    head.textContent = label.weekday + ' ' + label.day;

    var kp = document.createElement('div');
    kp.className = 'oday__kp';
    kp.textContent = t('hour.kp', { v: day.kp });

    var note = document.createElement('div');
    note.className = 'oday__note';
    note.textContent = !day.dark ? t('outlook.light') : (day.moon >= BRIGHT_MOON ? t('outlook.moon', { pct: Math.round(day.moon * 100) + '%' }) : ' ');

    cell.appendChild(head);
    cell.appendChild(kp);
    cell.appendChild(note);
    grid.appendChild(cell);
  });

  var best = outlookBestRanges(days, 3);
  $('outlook-best').textContent = best.length
    ? t('outlook.best', { name: pointName(point), dates: best.map(fmtOutlookRange).join(t('sep.list')) })
    : (days.some(function (d) { return d.dark; }) ? t('outlook.none') : t('outlook.polar'));

  $('outlook-meta').textContent = outlook.issued
    ? t('outlook.issued', { date: fmtOutlookLong(outlook.issued.toISOString().slice(0, 10)) })
    : '';

  applyFreshness('outlook-card', 'outlook-stale', outlook.stale, LEAD_OFFLINE);
}

/** Почасовые ряды всех точек из ответа с несколькими координатами. */
function readAllPointsHours(data) {
  if (!Array.isArray(data)) throw appError('not_list');
  var points = allPoints();
  // Для одной точки API отдаёт объект, но точек всегда не меньше семи.
  if (data.length !== points.length) {
    throw appError('points_count', { got: data.length, want: points.length });
  }

  // Порядок ответа совпадает с порядком переданных координат.
  return points.map(function (point, i) {
    return { id: point.id, hours: readHourlyCloud(data[i]) };
  });
}

/*
 * Облачность по всем точкам нужна теперь и на главной (лучшая ночь ближайших дней), поэтому
 * грузится при каждом обновлении. Чтобы не тратить лимит Open-Meteo (он считает каждую точку
 * отдельно), сохранённый ответ моложе получаса считаем свежим. force: по кнопке «Обновить».
 */
var TONIGHT_REFRESH_MS = 30 * 60 * 1000;

function loadTonight(force) {
  if (!state.tonight) {
    var early = cacheLoad('tonight');
    if (early) {
      state.tonight = { rows: early.payload, stale: early.age };
      renderTonight();
      if (!force && early.age < TONIGHT_REFRESH_MS) {
        state.tonight.stale = null;
        renderTonight();
        return Promise.resolve(early.payload);
      }
    }
  } else if (!force && state.tonight.loadedAt && Date.now() - state.tonight.loadedAt < TONIGHT_REFRESH_MS) {
    renderTonight();
    return Promise.resolve(state.tonight.rows);
  }
  markLoading('best-card');
  markLoading('places-card');

  // Смена вкладки правит хэш, а hashchange вызывает showTab повторно. Без
  // этого флага второй вызов успевал уйти в сеть до ответа на первый.
  state.tonightLoading = true;

  return fetchJson(allPointsWeatherUrl())
    .then(function (data) {
      var rows = readAllPointsHours(data);
      state.tonight = { rows: rows, stale: null, loadedAt: Date.now() };
      cacheSave('tonight', rows);
      renderTonight();
      return rows;
    })
    .catch(function (err) {
      var cached = cacheLoad('tonight');

      if (cached) {
        state.tonight = { rows: cached.payload, stale: cached.age };
        renderTonight();
        return cached.payload;
      }

      state.tonight = null;
      showError('best-error', 'best.error', err);
      renderMap();
      setState('best-card', 'error');
      setState('places-card', 'error');
      setState('nights-card', 'error');
      return null;
    })
    .finally(function () { state.tonightLoading = false; });
}

/** Окно на ближайшую ночь для каждой точки, отсортированное по привлекательности. */
function computeAllWindows() {
  if (!state.tonight || !state.tonight.rows) return null;

  var kpNow = state.kp ? state.kp.value : null;

  // Строки удалённых мест (из кэша) пропускаются: подставлять вместо них другую точку нельзя.
  var list = state.tonight.rows.filter(function (row) { return findPlace(row.id); }).map(function (row) {
    var point = findPlace(row.id);
    var win = computeNightWindow({ hours: row.hours, conflict: false },
      state.forecast, kpNow, point);
    return { point: point, window: win };
  });

  list.sort(function (a, b) {
    var aw = a.window, bw = b.window;

    // Точки без темноты или без данных уходят вниз списка.
    var aRank = (aw && !aw.polarDay) ? aw.level : -1;
    var bRank = (bw && !bw.polarDay) ? bw.level : -1;
    if (aRank !== bRank) return bRank - aRank;

    // При равном уровне ближе к делу тот, где чище небо, затем — кто ближе.
    var aCloud = (aw && !aw.polarDay) ? aw.cloudMin : 101;
    var bCloud = (bw && !bw.polarDay) ? bw.cloudMin : 101;
    if (aCloud !== bCloud) return aCloud - bCloud;

    return a.point.km - b.point.km;
  });

  return list;
}

function levelWord(level) {
  return t(level === 2 ? 'chance.high' : (level === 1 ? 'chance.mid' : 'chance.low'));
}

function levelTone(level) {
  return level === 2 ? TONE.ok : (level === 1 ? TONE.mid : TONE.bad);
}

/**
 * Три ближайшие ночи по всем точкам: [{ index, start, list: [{ point, window }] }], в каждой
 * ночи точки отсортированы так же, как на «Куда ехать». null: данных по точкам нет;
 * пустой массив: тёмных часов нет.
 */
function computeAllNights() {
  if (!state.tonight || !state.tonight.rows) return null;
  var kpNow = state.kp ? state.kp.value : null;
  var nights = [];
  state.tonight.rows.forEach(function (row) {
    var point = findPlace(row.id);
    if (!point) return;
    var list = computeNights({ hours: row.hours, conflict: false }, state.forecast, kpNow, point);
    (list || []).forEach(function (night) {
      var slot = nights[night.index] || (nights[night.index] = { index: night.index, start: night.start, cut: false, list: [] });
      if (night.start < slot.start) slot.start = night.start;
      if (night.cut) slot.cut = true;
      slot.list.push({ point: point, window: night.window });
    });
  });
  nights.forEach(function (night) { night.list.sort(comparePlaces); });
  return nights;
}

/** Порядок точек: выше уровень, затем чище небо, затем ближе. */
function comparePlaces(a, b) {
  var aw = a.window, bw = b.window;
  var aRank = (aw && !aw.polarDay) ? aw.level : -1;
  var bRank = (bw && !bw.polarDay) ? bw.level : -1;
  if (aRank !== bRank) return bRank - aRank;
  var aCloud = (aw && !aw.polarDay) ? aw.cloudMin : 101;
  var bCloud = (bw && !bw.polarDay) ? bw.cloudMin : 101;
  if (aCloud !== bCloud) return aCloud - bCloud;
  return a.point.km - b.point.km;
}

/** Точки ночи с заметным шансом (средний и выше), лучшие первыми. */
function goodPlaces(night) {
  return night.list.filter(function (item) { return item.window && item.window.level >= 1; });
}

/**
 * Лучшая ночь из трёх: выше уровень у лучшей точки; при равенстве раньше (ближняя ночь
 * надёжнее), затем чище небо. null: ни одной ночи с шансом.
 */
function bestNight(nights) {
  var best = null;
  (nights || []).forEach(function (night) {
    var top = goodPlaces(night)[0];
    if (!top) return;
    if (!best || top.window.level > best.top.window.level) best = { night: night, top: top };
  });
  return best;
}

/**
 * Почему все ночи низкие: если везде сплошные облака (меньше 75% нигде нет), а Kp по прогнозу
 * заметный (от 2), называем облака. from: с какой ночи смотреть (для «когда ехать» со второй).
 * Возвращает ключ и параметры текста.
 */
function nightsLowReason(nights, from) {
  var short = nights.length < NIGHTS_AHEAD || nights[nights.length - 1].cut;
  nights = nights.slice(from || 0);
  var kpMax = null;
  var cloudy = true;
  nights.forEach(function (night) {
    night.list.forEach(function (item) {
      var win = item.window;
      if (!win || win.polarDay) return;
      if (win.cloudMin <= 75) cloudy = false;
      if (win.kpMax !== null && (kpMax === null || win.kpMax > kpMax)) kpMax = win.kpMax;
    });
  });
  if (cloudy && kpMax !== null && kpMax >= 2) return { key: 'nights.none_cloudy', params: { kp: fmtKp(kpMax) } };
  return { key: short ? 'nights.none_short' : 'nights.none', params: {} };
}

/** Подпись ночи: «эта ночь» для ближайшей, дальше день недели и дата вечера. */
function nightLabel(night) {
  return night.index === 0 ? t('nights.first') : fmtNightDate(night.start);
}

/** Названия точек через запятую, не больше трёх: «Териберка, Мурманск и ещё 2». */
function placeNames(items) {
  var names = items.slice(0, 3).map(function (item) { return pointName(item.point); }).join(', ');
  return items.length > 3 ? t('nights.more', { names: names, n: items.length - 3 }) : names;
}

function renderNights() {
  var card = $('nights-card');
  if (!card) return;
  var nights = computeAllNights();
  if (nights === null) {
    // Данных по точкам ещё нет: показываем загрузку, пока они не придут, а при ошибке их загрузки
    // карточка уходит в ошибку вместе с «Куда ехать».
    return;
  }

  var list = $('nights-list');
  list.innerHTML = '';
  var value = $('nights-value');
  var why = $('nights-why');

  if (!nights.length) {
    setTone(card, TONE.mid);
    setTone(value, TONE.mid);
    value.textContent = t('win.no_dark');
    why.textContent = t('nights.polar');
    setState('nights-card', 'ok');
    return;
  }

  var best = bestNight(nights);
  if (best) {
    var win = best.top.window;
    var tone = levelTone(win.level);
    setTone(card, tone);
    setTone(value, tone);
    value.textContent = t('nights.value', { date: nightLabel(best.night), from: fmtTime(win.from), to: fmtTime(win.to) });
    why.textContent = t('nights.why', {
      name: pointName(best.top.point),
      level: levelWord(win.level).toLowerCase(),
      cloud: cloudRangeText(win),
      kp: win.kpMax !== null ? t('win.kp_max', { v: fmtKp(win.kpMax) }) : t('nights.kp_none')
    });
  } else {
    setTone(card, TONE.bad);
    setTone(value, TONE.bad);
    value.textContent = t('nights.none_value');
    var reason = nightsLowReason(nights, 0);
    why.textContent = t(reason.key, reason.params);
  }

  nights.forEach(function (night) {
    var good = goodPlaces(night);
    var top = night.list[0];
    var li = document.createElement('li');
    li.className = 'nights__item';
    var date = document.createElement('span');
    date.className = 'nights__date';
    date.textContent = nightLabel(night);
    var text = document.createElement('span');
    text.className = 'nights__text';
    var parts = [];
    if (good.length) {
      parts.push(levelWord(good[0].window.level) + ': ' + placeNames(good));
      setTone(li, levelTone(good[0].window.level));
    } else {
      parts.push(t('nights.low_everywhere'));
      setTone(li, TONE.bad);
    }
    if (top && top.window && top.window.noKp) parts.push(t('nights.no_kp'));
    if (night.cut) parts.push(t('nights.cut'));
    text.textContent = parts.join(t('sep.dot'));
    li.appendChild(date);
    li.appendChild(text);
    list.appendChild(li);
  });

  applyFreshness('nights-card', 'nights-stale', state.tonight.stale, 'lead.calc_saved');
}

function renderTonight() {
  renderNights();
  var list = computeAllWindows();

  if (!list) {
    setState('best-card', 'error');
    setState('places-card', 'error');
    return;
  }

  renderBest(list);
  renderPlaces(list);
  renderMap();

  var age = state.tonight.stale;
  applyFreshness('best-card', 'best-stale', age, 'lead.calc_saved');
  setState('places-card', 'ok');
}

/**
 * Когда ехать, если этой ночью некуда: ближайшая следующая ночь с заметным шансом и её точки.
 * Если такой нет или прогноз кончается, так и говорим.
 */
function nextNightText() {
  var nights = computeAllNights();
  if (!nights || nights.length < 2) return t('best.next_unknown');
  for (var i = 1; i < nights.length; i++) {
    var good = goodPlaces(nights[i]);
    if (good.length) {
      return t('best.next', {
        date: nightLabel(nights[i]),
        from: fmtTime(good[0].window.from),
        to: fmtTime(good[0].window.to),
        names: placeNames(good)
      });
    }
  }
  var reason = nightsLowReason(nights, 1);
  if (reason.key === 'nights.none') return t('best.next_none');
  return t(reason.key, reason.params);
}

/** Крупная строка с ответом. Лучшее из плохого здесь не показываем. */
/** Время в пути: «2,5 ч» / «2.5 h» / «2.5小时». */
function driveText(point) {
  return t('drive.h', { h: fmtNum(point.driveH) });
}

function renderBest(list) {
  var valueEl = $('best-value');
  var hintEl = $('best-hint');
  var factors = $('best-factors');
  factors.innerHTML = '';

  var best = list[0];
  var win = best.window;
  var hasDark = list.some(function (item) { return item.window && !item.window.polarDay; });

  if (!hasDark) {
    setTone($('best-card'), TONE.mid);
    setTone(valueEl, TONE.mid);
    valueEl.textContent = t('win.no_dark');
    hintEl.textContent = t('best.polar');
    return;
  }

  if (!win || win.polarDay || win.level < 1) {
    setTone($('best-card'), TONE.bad);
    setTone(valueEl, TONE.bad);
    valueEl.textContent = t('best.no_go');

    // Объясняем, что именно мешает: это видно по лучшей из точек.
    var reason;
    var cloudy = list.every(function (item) {
      return item.window && !item.window.polarDay && item.window.cloudMin > 75;
    });
    var kpNow = state.kp ? state.kp.value : null;

    if (cloudy) {
      reason = t('best.reason.cloudy');
    } else if (kpNow !== null && kpScore(kpNow, findPoint(REFERENCE_POINT_ID)) === 0) {
      reason = t('best.reason.calm');
    } else {
      reason = t('best.reason.other');
    }
    hintEl.textContent = reason + t('sep.sentence') + nextNightText();
    return;
  }

  var tone = levelTone(win.level);
  setTone($('best-card'), tone);
  setTone(valueEl, tone);

  valueEl.textContent = t('best.value', { name: pointName(best.point), from: fmtTime(win.from), to: fmtTime(win.to) });

  hintEl.textContent = levelWord(win.level).toLowerCase() + t('sep.dot') + cloudRangeText(win) +
    (win.kpMax !== null ? t('sep.dot') + t('win.kp_max', { v: fmtKp(win.kpMax) }) : '') +
    (best.point.custom ? t('sep.dot') + t('place.air', { dist: distText(best.point.km) })
      : best.point.km ? t('best.travel', { dist: distText(best.point.km), drive: driveText(best.point) })
      : t('best.here'));

  [
    best.point.light ? t('best.chip.light', { v: t('light.' + best.point.light + '.label') }) : '',
    t('best.chip.threshold', { v: fmtKp(kpThresholds(best.point).low) }),
    t(win.fullDark ? 'best.chip.dark_full' : 'best.chip.dark_part'),
    moonWindowText(moonSummary(win.from, win.to, best.point.lat, best.point.lon))
  ].filter(Boolean).forEach(function (text) {
    var li = document.createElement('li');
    li.textContent = text;
    factors.appendChild(li);
  });
}

function renderPlaces(list) {
  var box = $('places-list');
  box.innerHTML = '';

  list.forEach(function (item, index) {
    var win = item.window;
    var best = index === 0 && win && !win.polarDay && win.level >= 1;
    box.appendChild(buildPlaceRow(item, best));
  });
}

/** Тон точки на ночь: по уровню окна; без темноты или данных — «плохо». */
function placeTone(win) {
  return win && !win.polarDay ? levelTone(win.level) : TONE.bad;
}

/** Строка точки: название, шанс, окно, облачность, дорога. Её показывают список и карта. */
function buildPlaceRow(item, best) {
  var point = item.point;
  var win = item.window;
  var usable = win && !win.polarDay;
  var tone = placeTone(win);

  var row = document.createElement('div');
  row.className = 'place' + (best ? ' place--best' : '');
  setTone(row, tone);

  var name = document.createElement('div');
  name.className = 'place__name';
  name.textContent = pointName(point);

  var level = document.createElement('div');
  level.className = 'place__level';
  level.textContent = usable ? levelWord(win.level) : t('place.no_dark');
  setTone(level, tone);

  var facts = document.createElement('div');
  facts.className = 'place__facts';
  if (usable) {
    var factParts = [fmtTime(win.from) + ' — ' + fmtTime(win.to), cloudRangeText(win)];
    if (win.kpMax !== null) factParts.push(t('win.kp_max', { v: fmtKp(win.kpMax) }));
    factParts.push(t('place.threshold', { v: fmtKp(kpThresholds(point).low) }));
    facts.textContent = factParts.join(t('sep.dot'));
  } else {
    facts.textContent = t(win ? 'place.sun' : 'place.no_data');
  }

  var travel = document.createElement('div');
  travel.className = 'place__travel';
  // Своё место: расстояние по прямой, дорога и засветка неизвестны.
  var travelParts = point.custom ? [t('place.mine'), t('place.air', { dist: distText(point.km) })]
    : point.km ? [t('place.travel', { dist: distText(point.km), drive: driveText(point) })]
    : [t('place.origin')];
  if (point.noteKey) travelParts.push(t('note.' + point.noteKey));
  if (point.light) travelParts.push(t('place.light', { v: t('light.' + point.light + '.label') }));
  travel.textContent = travelParts.join(t('sep.dot'));

  row.appendChild(name);
  row.appendChild(level);
  row.appendChild(facts);
  row.appendChild(travel);
  return row;
}
