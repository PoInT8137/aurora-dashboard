/* Дашборд северного сияния — Мурманск.
   Чистый JS, без зависимостей. Все запросы — публичные API с CORS. */
'use strict';

/* ------------------------------------------------------------------ */
/*  Настройки                                                          */
/* ------------------------------------------------------------------ */

var CONFIG = {
  lat: 68.97,
  lon: 33.07,
  tz: 'Europe/Moscow',
  timeoutMs: 12000,        // таймаут одного запроса
  retries: 1,              // одна автоматическая повторная попытка
  refreshMs: 5 * 60 * 1000 // автообновление раз в 5 минут
};

var URLS = {
  kpNow:      'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json',
  kpNowAlt:   'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json',
  kpForecast: 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json',
  weather:    'https://api.open-meteo.com/v1/forecast'
    + '?latitude=' + CONFIG.lat + '&longitude=' + CONFIG.lon
    + '&current=cloud_cover,temperature_2m'
    + '&hourly=cloud_cover&forecast_days=2&timezone=UTC'
};

// Текущее состояние: null — данных нет (ошибка или ещё не загрузились).
var state = { kp: null, cloud: null, lastOk: null };

/* ------------------------------------------------------------------ */
/*  Утилиты                                                            */
/* ------------------------------------------------------------------ */

function $(id) { return document.getElementById(id); }

function setState(cardId, value) {
  var el = $(cardId);
  if (el) el.setAttribute('data-state', value);
}

function setTone(el, color) {
  if (el) el.style.setProperty('--tone', color);
}

/** fetch с таймаутом и повторами. Бросает Error с понятным текстом. */
function fetchJson(url, attempt) {
  attempt = attempt || 0;

  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, CONFIG.timeoutMs);

  // cache: 'no-store' — чтобы браузер не отдал вчерашний Kp из кэша
  return fetch(url, { signal: ctrl.signal, cache: 'no-store' })
    .then(function (res) {
      if (!res.ok) throw new Error('сервер ответил ' + res.status);
      return res.json();
    })
    .catch(function (err) {
      if (attempt < CONFIG.retries) {
        return new Promise(function (resolve) { setTimeout(resolve, 900); })
          .then(function () { return fetchJson(url, attempt + 1); });
      }
      if (err.name === 'AbortError') throw new Error('превышено время ожидания');
      if (err instanceof TypeError) throw new Error('нет соединения');
      throw err;
    })
    .finally(function () { clearTimeout(timer); });
}

/** "2026-09-17 15:00:00" (UTC, без указания зоны) -> Date */
function parseUtc(str) {
  if (!str) return null;
  var iso = String(str).trim().replace(' ', 'T');
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(iso)) iso += 'Z';
  var d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function fmtTime(date) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: CONFIG.tz, hour: '2-digit', minute: '2-digit'
  }).format(date);
}

function fmtDayKey(date) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: CONFIG.tz, day: 'numeric', month: 'numeric'
  }).format(date);
}

function fmtWeekday(date) {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: CONFIG.tz, weekday: 'short' }).format(date);
}

/** Склонение: 1 минуту / 2 минуты / 12 минут */
function plural(n, one, few, many) {
  var m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

function fmtKp(value) {
  return value.toFixed(1).replace('.', ',');
}

/* ------------------------------------------------------------------ */
/*  Высота Солнца — чтобы не обещать сияние в полярный день.           */
/*  Упрощённый алгоритм NOAA, точность около 0,1°.                     */
/* ------------------------------------------------------------------ */

function solarAltitude(date, lat, lon) {
  var rad = Math.PI / 180;
  var d = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 86400000; // дней от J2000

  var g = (357.529 + 0.98560028 * d) * rad;                       // средняя аномалия
  var q = 280.459 + 0.98564736 * d;                               // средняя долгота
  var L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
  var e = (23.439 - 0.00000036 * d) * rad;                        // наклон эклиптики

  var dec = Math.asin(Math.sin(e) * Math.sin(L));
  var ra  = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));

  var gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  var lst = (((gmst + 24) % 24) + lon / 15) * 15 * rad;
  var H = lst - ra;

  var alt = Math.asin(
    Math.sin(lat * rad) * Math.sin(dec) +
    Math.cos(lat * rad) * Math.cos(dec) * Math.cos(H)
  );
  return alt / rad;
}

/* ------------------------------------------------------------------ */
/*  Шкалы и оценки                                                     */
/* ------------------------------------------------------------------ */

var TONE = { ok: '#4dffb8', mid: '#ffd166', bad: '#ff7a8a' };

/** Балл за Kp (0..3). Пороги низкие: Мурманск лежит под авроральным овалом. */
function kpScore(kp) {
  if (kp >= 3) return 3;
  if (kp >= 2) return 2;
  if (kp >= 1) return 1;
  return 0;
}

function kpText(kp) {
  if (kp >= 5) return 'Магнитная буря — сияние вероятно и южнее Мурманска';
  if (kp >= 3) return 'Повышенная активность — овал сияния над городом';
  if (kp >= 2) return 'Умеренная активность — сияние возможно на севере неба';
  if (kp >= 1) return 'Слабая активность — шанс на бледную дугу у горизонта';
  return 'Магнитное поле спокойно';
}

function kpTone(kp) {
  if (kp >= 3) return TONE.ok;
  if (kp >= 1) return TONE.mid;
  return TONE.bad;
}

/** Балл за облачность (0..3). */
function cloudScore(pct) {
  if (pct <= 25) return 3;
  if (pct <= 50) return 2;
  if (pct <= 75) return 1;
  return 0;
}

function cloudText(pct) {
  if (pct <= 25) return 'Ясно — небо открыто';
  if (pct <= 50) return 'Переменная облачность — есть просветы';
  if (pct <= 75) return 'Значительная облачность — просветы редки';
  return 'Сплошная облачность — небо закрыто';
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
  var ks = kp !== null ? kpScore(kp.value) : null;
  var cs = cloud !== null ? cloudScore(cloud.value) : null;

  if (ks === null && cs === null) return null; // считать не из чего

  var partial = (ks === null || cs === null);
  var factors = [];

  factors.push(ks !== null ? 'Kp ' + fmtKp(kp.value) : 'Kp: данных нет');
  factors.push(cs !== null ? 'Облачность ' + cloud.value + '%' : 'Облачность: данных нет');

  var level;
  if (partial) {
    // Считаем по одному доступному фактору и не завышаем вердикт.
    var only = (ks !== null) ? ks : cs;
    level = only >= 1 ? 'mid' : 'low';
  } else {
    var product = ks * cs; // 0..9
    level = product >= 6 ? 'high' : (product >= 2 ? 'mid' : 'low');
  }

  // Освещённость неба
  var alt = solarAltitude(new Date(), CONFIG.lat, CONFIG.lon);
  var tooLight = false;

  if (alt > -6) {
    tooLight = true;
    level = 'low';
    factors.push(alt > 0 ? 'Солнце над горизонтом' : 'Светлые сумерки');
  } else if (alt > -12) {
    if (level === 'high') level = 'mid';
    factors.push('Неполная темнота');
  } else {
    factors.push('Тёмное небо');
  }

  var hint;
  if (level === 'high') {
    hint = 'Хорошие условия: активность есть, небо достаточно чистое. Отойдите от городской засветки и смотрите на север.';
  } else if (level === 'mid') {
    hint = 'Шанс есть, но не гарантирован — имеет смысл проверять небо каждые полчаса.';
  } else if (tooLight) {
    hint = 'Сейчас слишком светло: сияние не различить даже при высокой магнитной активности. Возвращайтесь после наступления темноты.';
  } else if (cs === 0) {
    hint = 'Небо затянуто облаками — сияние не будет видно, какой бы ни была активность.';
  } else if (ks === 0) {
    hint = 'Магнитное поле спокойно — сияния практически нет.';
  } else {
    hint = 'Условия неблагоприятные.';
  }

  if (partial) hint += ' Оценка неполная: часть данных не загрузилась.';

  return {
    label: level === 'high' ? 'Высокий' : (level === 'mid' ? 'Средний' : 'Низкий'),
    tone:  level === 'high' ? TONE.ok  : (level === 'mid' ? TONE.mid  : TONE.bad),
    hint: hint,
    factors: factors
  };
}

/* ------------------------------------------------------------------ */
/*  Kp: текущее значение                                               */
/* ------------------------------------------------------------------ */

/**
 * NOAA отдаёт данные в двух форматах: массив объектов (/json/...) и массив
 * массивов с заголовком в первой строке (/products/..., исторический формат).
 * Приводим оба к массиву объектов с ключами в нижнем регистре.
 */
function normalizeRows(data) {
  if (!Array.isArray(data) || !data.length) throw new Error('пустой ответ');

  var rows = data;
  if (Array.isArray(data[0])) {
    var head = data[0].map(function (h) { return String(h).toLowerCase(); });
    rows = data.slice(1).map(function (row) {
      var obj = {};
      head.forEach(function (key, i) { obj[key] = row[i]; });
      return obj;
    });
  } else {
    rows = data.map(function (row) {
      var obj = {};
      Object.keys(row).forEach(function (key) { obj[key.toLowerCase()] = row[key]; });
      return obj;
    });
  }

  if (!rows.length) throw new Error('нет строк с данными');
  return rows;
}

/** Значение Kp из строки ряда: сперва дробная оценка, затем целый индекс. */
function pickKpValue(row) {
  var candidates = [row.estimated_kp, row.kp, row.kp_index];
  for (var i = 0; i < candidates.length; i++) {
    var value = parseFloat(candidates[i]);
    if (isFinite(value)) return value;
  }
  return NaN;
}

/** Последнее измерение ряда. */
function readKpSeries(data) {
  var rows = normalizeRows(data);
  var last = rows[rows.length - 1];
  var value = pickKpValue(last);
  if (!isFinite(value)) throw new Error('некорректное значение Kp');
  return { value: value, time: parseUtc(last.time_tag) };
}

function loadKp() {
  setState('kp-card', 'loading');

  return fetchJson(URLS.kpNow)
    .then(readKpSeries)
    .catch(function () {
      // Основной endpoint не отдал данные — пробуем трёхчасовой ряд.
      return fetchJson(URLS.kpNowAlt).then(readKpSeries);
    })
    .then(function (kp) {
      state.kp = kp;
      renderKp(kp);
      return kp;
    })
    .catch(function (err) {
      state.kp = null;
      $('kp-error').textContent = 'NOAA SWPC недоступен: ' + err.message + '.';
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

  var meta = 'Шкала 0–9';
  if (kp.time) {
    var mins = Math.max(0, Math.round((Date.now() - kp.time.getTime()) / 60000));
    meta = 'Измерено в ' + fmtTime(kp.time) + ' · ' +
      (mins < 1 ? 'только что'
                : mins + ' ' + plural(mins, 'минуту', 'минуты', 'минут') + ' назад');
  }
  $('kp-time').textContent = meta;

  setState('kp-card', 'ok');
}

/* ------------------------------------------------------------------ */
/*  Облачность                                                         */
/* ------------------------------------------------------------------ */

function loadCloud() {
  setState('cloud-card', 'loading');

  return fetchJson(URLS.weather)
    .then(function (data) {
      var cur = data && data.current;
      if (!cur || cur.cloud_cover === undefined || cur.cloud_cover === null) {
        throw new Error('в ответе нет облачности');
      }
      var cloud = {
        value: Math.round(cur.cloud_cover),
        temp: (cur.temperature_2m === undefined || cur.temperature_2m === null)
          ? null : Math.round(cur.temperature_2m),
        time: parseUtc(cur.time),
        soon: pickCloudIn(data, 3)
      };
      state.cloud = cloud;
      renderCloud(cloud);
      return cloud;
    })
    .catch(function (err) {
      state.cloud = null;
      $('cloud-error').textContent = 'Open-Meteo недоступен: ' + err.message + '.';
      setState('cloud-card', 'error');
      return null;
    });
}

/** Облачность через N часов из почасового ряда (или null). */
function pickCloudIn(data, hours) {
  try {
    var times = data.hourly.time;
    var values = data.hourly.cloud_cover;
    var target = Date.now() + hours * 3600000;
    for (var i = 0; i < times.length; i++) {
      var t = parseUtc(times[i]);
      if (t && t.getTime() >= target && values[i] !== null && values[i] !== undefined) {
        return { value: Math.round(values[i]), time: t };
      }
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

  var parts = [];
  if (cloud.temp !== null) parts.push((cloud.temp > 0 ? '+' : '') + cloud.temp + ' °C');
  if (cloud.soon) parts.push('к ' + fmtTime(cloud.soon.time) + ' — ' + cloud.soon.value + '%');
  if (cloud.time) parts.push('данные на ' + fmtTime(cloud.time));
  $('cloud-meta').textContent = parts.join(' · ');

  setState('cloud-card', 'ok');
}

/* ------------------------------------------------------------------ */
/*  Прогноз Kp на 3 суток                                              */
/* ------------------------------------------------------------------ */

function loadForecast() {
  setState('forecast-card', 'loading');

  return fetchJson(URLS.kpForecast)
    .then(function (data) {
      var source = normalizeRows(data);
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

      if (!rows.length) throw new Error('нет актуальных значений');
      renderForecast(rows);
      return rows;
    })
    .catch(function (err) {
      $('forecast-error').textContent = 'Прогноз NOAA недоступен: ' + err.message + '.';
      setState('forecast-card', 'error');
      return null;
    });
}

function renderForecast(rows) {
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
    timeEl.textContent = row.current ? 'сейчас' : fmtTime(row.time);

    slot.appendChild(dayEl);
    slot.appendChild(kpEl);
    slot.appendChild(timeEl);
    list.appendChild(slot);
  });

  setState('forecast-card', 'ok');
}

/* ------------------------------------------------------------------ */
/*  Вердикт                                                            */
/* ------------------------------------------------------------------ */

function renderVerdict() {
  var v = computeVerdict(state.kp, state.cloud);

  if (!v) {
    setState('verdict-card', 'error');
    return;
  }

  setTone($('verdict-card'), v.tone);

  var valueEl = $('verdict-value');
  valueEl.textContent = v.label;
  setTone(valueEl, v.tone);

  $('verdict-hint').textContent = v.hint;

  var list = $('verdict-factors');
  list.innerHTML = '';
  v.factors.forEach(function (text) {
    var li = document.createElement('li');
    li.textContent = text;
    list.appendChild(li);
  });

  setState('verdict-card', 'ok');
}

/* ------------------------------------------------------------------ */
/*  Оркестрация                                                        */
/* ------------------------------------------------------------------ */

function refreshAll() {
  var btn = $('refresh');
  btn.disabled = true;
  $('updated').textContent = 'Обновляем…';
  setState('verdict-card', 'loading');

  return Promise.all([loadKp(), loadCloud(), loadForecast()])
    .then(function () {
      renderVerdict();

      if (state.kp || state.cloud) {
        state.lastOk = new Date();
        $('updated').textContent = 'Обновлено в ' + fmtTime(state.lastOk);
      } else {
        $('updated').textContent = state.lastOk
          ? 'Нет связи · последние данные в ' + fmtTime(state.lastOk)
          : 'Нет связи с сервисами данных';
      }
    })
    .finally(function () { btn.disabled = false; });
}

function init() {
  $('refresh').addEventListener('click', refreshAll);

  // Кнопки «Повторить» внутри карточек перезагружают только свой блок.
  document.addEventListener('click', function (e) {
    var target = e.target.closest ? e.target.closest('[data-retry]') : null;
    if (!target) return;
    var what = target.getAttribute('data-retry');
    if (what === 'kp')       loadKp().then(renderVerdict);
    if (what === 'cloud')    loadCloud().then(renderVerdict);
    if (what === 'forecast') loadForecast();
  });

  refreshAll();
  setInterval(refreshAll, CONFIG.refreshMs);

  // Вернулись на вкладку после долгого отсутствия — обновляем сразу.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' &&
        (!state.lastOk || Date.now() - state.lastOk.getTime() > CONFIG.refreshMs)) {
      refreshAll();
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
