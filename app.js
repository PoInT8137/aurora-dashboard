/* Дашборд северного сияния — Мурманская область.
   Чистый JS, без зависимостей. Все запросы — публичные API с CORS. */
'use strict';

/* ------------------------------------------------------------------ */
/*  Настройки                                                          */
/* ------------------------------------------------------------------ */

var CONFIG = {
  tz: 'Europe/Moscow',
  timeoutMs: 12000,        // таймаут одного запроса
  retries: 1,              // одна автоматическая повторная попытка

  /*
   * Модель Open-Meteo указывается явно, а не оставляется на best_match.
   * Причина (проверено 17 сентября 2026 для точки 68.97, 33.07):
   *
   * best_match выбирает здесь MET Norway — ответ совпадает с
   * models=metno_seamless во всех четырёх полях облачности и на всех
   * 48 часах почасового ряда. У этой модели ярусы и суммарная облачность
   * противоречат друг другу: неравенство
   *
   *     max(ярусы) <= всего <= сумма(ярусы),
   *
   * обязательное при любом допущении о перекрытии слоёв, нарушалось
   * в 16 часах из 48 (33 %), расхождение больше 30 п.п. — в 23 % часов,
   * среднее 17 п.п. Показательный час: ярусы 8/4/0 при суммарной
   * облачности 90 %, то есть «почти ясно» и «почти сплошь» одновременно.
   *
   * У icon_eu за те же 48 часов ни одного нарушения, среднее расхождение
   * 2 п.п.; у gfs_seamless — одно нарушение из 48. Прочие проверенные
   * модели (ecmwf_ifs025, ukmo, gem, knmi, dmi, meteofrance) либо тоже
   * дают нарушения, либо хуже покрывают Кольский полуостров.
   *
   * Какое именно поле MET Norway недостоверно, по одному API установить
   * не удалось. Её ярусы 8/13/0 совпадали с knmi_seamless и dmi_seamless
   * (у тех сумма 15 %, что согласованно), но её же суммарные 72 %
   * совпадали с icon_eu и gfs_seamless. То есть с суммой MET Norway
   * согласны две независимые модели, а её ярусы разделяют лишь сборки,
   * похоже берущие их из общего источника. Расчёт по таким ярусам
   * занижал бы облачность: дашборд показывал бы «ясно, 18 %» там, где
   * три модели из четырёх видят 70 %.
   *
   * ICON-EU (DWD, сетка 7 км) грубее локальной скандинавской модели, но
   * её поля самосогласованы, а это для расчёта по ярусам важнее.
   * Перекрёстная проверка на противоречивость (CLOUD_CONFLICT_LIMIT)
   * оставлена как страховка на случай, если и здесь поля разойдутся.
   */
  weatherModel: WEATHER_MODEL   // значение — в core.js: одна модель для сайта и сервера уведомлений
};

/** Название модели для подписи в карточке: model.<id> в словарях, иначе сам идентификатор. */
function weatherModelLabel() {
  var key = 'model.' + CONFIG.weatherModel;
  return hasKey(key) ? t(key) : CONFIG.weatherModel;
}

var URLS = {
  kpNow:      'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json',
  kpNowAlt:   'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json',
  kpForecast: 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json',
  // Солнечный ветер: поминутное поле за сутки (≈90 КБ в сжатом виде) и крошечная сводка скорости.
  // Старые адреса products/solar-wind/*.json NOAA убрала (404 с сентября 2026).
  swMag:      'https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json',
  swSpeed:    'https://services.swpc.noaa.gov/products/summary/solar-wind-speed.json',
  // Модель OVATION: сетка всей Земли, ≈140 КБ в сжатом виде — поэтому не чаще раза в 15 минут.
  ovation:    'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json',
  // Прогноз на 27 дней: текстовая таблица, выходит раз в неделю (по понедельникам).
  outlook:    'https://services.swpc.noaa.gov/text/27-day-outlook.txt'
};

/** Адрес почасовой облачности сразу для всех точек: один запрос вместо семи. */
function allPointsWeatherUrl() {
  return 'https://api.open-meteo.com/v1/forecast'
    + '?latitude=' + POINTS.map(function (p) { return p.lat; }).join(',')
    + '&longitude=' + POINTS.map(function (p) { return p.lon; }).join(',')
    + '&hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high'
    + '&models=' + CONFIG.weatherModel
    + '&forecast_days=2&timezone=UTC';
}

/** Адрес погоды для выбранной точки. */
function weatherUrl(point) {
  return 'https://api.open-meteo.com/v1/forecast'
    + '?latitude=' + point.lat + '&longitude=' + point.lon
    + '&current=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,temperature_2m'
    // Погода для наблюдателя — тем же запросом: ветер, осадки, видимость (туман).
    + ',apparent_temperature,wind_speed_10m,wind_gusts_10m,wind_direction_10m'
    + ',precipitation,rain,snowfall,weather_code,visibility,relative_humidity_2m'
    + '&hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high'
    + '&models=' + CONFIG.weatherModel
    + '&forecast_days=2&timezone=UTC';
}

// Текущее состояние: null — данных нет (ошибка или ещё не загрузились).
var state = { tab: 'now', point: null, kp: null, cloud: null, forecast: null, forecastAge: null,
              tonight: null, tonightLoading: false, lastOk: null,
              cloudSeq: 0, cloudPending: false, refreshing: null,
              lastLevel: null, pushBusy: false, pushHealth: null,
              status: null, errors: {}, settings: null, timer: null, sw: null, ov: null, outlook: null };

/* ------------------------------------------------------------------ */
/*  Точка наблюдения                                                   */
/* ------------------------------------------------------------------ */

function currentPoint() {
  return state.point || POINTS[0];
}

/** Выбор города переживает перезагрузку; хранилище может быть недоступно. */
function savedPointId() {
  try {
    return localStorage.getItem(CACHE.prefix + 'point');
  } catch (e) {
    return null;
  }
}

function savePointId(id) {
  try {
    localStorage.setItem(CACHE.prefix + 'point', id);
  } catch (e) { /* без сохранения выбор просто не переживёт перезагрузку */ }
}

/* ------------------------------------------------------------------ */
/*  Утилиты                                                            */
/* ------------------------------------------------------------------ */

function $(id) { return document.getElementById(id); }

function setState(cardId, value) {
  var el = $(cardId);
  if (!el) return;
  el.setAttribute('data-state', value);
  // Высота, зафиксированная на время загрузки, больше не нужна.
  if (value !== 'loading') el.style.minHeight = '';
}

/**
 * «Загрузка» только для пустой карточки. Если данные уже на экране, они
 * остаются до прихода новых: раньше каждое обновление, включая
 * автоматическое раз в 5 минут, схлопывало все карточки и раскрывало их
 * обратно — сдвиг макета (CLS) доходил до 0,96 при норме 0,1.
 */
function markLoading(cardId) {
  var el = $(cardId);
  if (!el) return;
  var current = el.getAttribute('data-state');
  if (current === 'ok' || current === 'stale') return;
  el.setAttribute('data-state', 'loading');
}

/**
 * Данные на карточке больше не годятся — например, сменился город. Показываем
 * загрузку, но сохраняем прежнюю высоту, чтобы страница не прыгнула.
 */
function replaceWithLoading(cardId) {
  var el = $(cardId);
  if (!el) return;
  var height = el.getBoundingClientRect().height;
  if (height) el.style.minHeight = Math.round(height) + 'px';
  el.setAttribute('data-state', 'loading');
}

function setTone(el, color) {
  if (el) el.style.setProperty('--tone', color);
}

/** Ошибка с кодом и параметрами: текст по ней строит errorText() на языке интерфейса. */
function appError(code, params) {
  var error = codedError(code, code);
  error.params = params || {};
  return error;
}

/** Причина сбоя словами на текущем языке; неизвестное показываем как есть. */
function errorText(error) {
  if (error && typeof error.code === 'string' && hasKey('err.' + error.code)) {
    return t('err.' + error.code, error.params || {});
  }
  return (error && error.message) || String(error);
}

/**
 * Показать ошибку в карточке и запомнить её: при смене языка текст строится заново.
 * key — ключ шаблона с {reason}.
 */
function showError(elementId, key, error) {
  state.errors[elementId] = { key: key, error: error };
  $(elementId).textContent = t(key, { reason: errorText(error) });
}

function refreshErrors() {
  Object.keys(state.errors).forEach(function (id) {
    var entry = state.errors[id];
    var el = $(id);
    if (el) el.textContent = t(entry.key, { reason: errorText(entry.error) });
  });
}

/** fetch с таймаутом и повторами. Бросает ошибку с кодом — понятный текст строит errorText(). */
function fetchJson(url, attempt, as) {
  attempt = attempt || 0;

  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, CONFIG.timeoutMs);

  // cache: 'no-store' — чтобы браузер не отдал вчерашний Kp из кэша
  return fetch(url, { signal: ctrl.signal, cache: 'no-store' })
    .then(function (res) {
      if (!res.ok) throw appError('http', { status: res.status });
      return as === 'text' ? res.text() : res.json();
    })
    .catch(function (err) {
      if (attempt < CONFIG.retries) {
        return new Promise(function (resolve) { setTimeout(resolve, 900); })
          .then(function () { return fetchJson(url, attempt + 1, as); });
      }
      if (err.name === 'AbortError') throw appError('timeout');
      // По имени, а не instanceof: тот же довод, что в pushErrorText — ошибка может прийти из другого окружения.
      if (err && err.name === 'TypeError') throw appError('offline');
      throw err;
    })
    .finally(function () { clearTimeout(timer); });
}

/** То же для текстовых ответов (прогноз NOAA на 27 дней — таблица, а не JSON). */
function fetchText(url) {
  return fetchJson(url, 0, 'text');
}

/** Часовой пояс отображения: московский (по умолчанию) или пояс устройства (undefined). */
function displayZone() {
  return setting('tz') === 'device' ? undefined : CONFIG.tz;
}

function clockCycle() {
  return setting('clock') === '12' ? 'h12' : 'h23';
}

function fmtTime(date) {
  return new Intl.DateTimeFormat(langLocale(), {
    timeZone: displayZone(), hour: '2-digit', minute: '2-digit', hourCycle: clockCycle()
  }).format(date);
}

function fmtDayKey(date) {
  return new Intl.DateTimeFormat(langLocale(), {
    timeZone: displayZone(), day: 'numeric', month: 'numeric'
  }).format(date);
}

function fmtWeekday(date) {
  return new Intl.DateTimeFormat(langLocale(), { timeZone: displayZone(), weekday: 'short' }).format(date);
}

/** Расстояние в выбранных единицах: «120 км» / «75 миль». */
function distText(km) {
  if (setting('dist') === 'mi') return t('unit.mi', { n: Math.round(km * 0.621371) });
  return t('unit.km', { n: km });
}

/**
 * Температура из целых градусов Цельсия в выбранных единицах: «+3 °C» / «37 °F».
 * Плюс — привычка шкалы Цельсия, где важен переход через ноль; во Фаренгейте нулём служит 32.
 */
function tempText(celsius) {
  // Округление одно и в конце: иначе −21,6 °C сначала стало бы −22, а потом −8 °F вместо −7.
  if (setting('temp') === 'f') return Math.round(celsius * 9 / 5 + 32) + ' °F';
  var c = Math.round(celsius);
  return (c > 0 ? '+' : '') + c + ' °C';
}

function fmtKp(value) {
  return fmtNum(value.toFixed(1));
}

/** Возраст данных словами: «12 минут назад», «1 час 5 минут назад». */
function fmtAge(ms) {
  var mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 1) return t('age.under_minute');
  if (mins < 60) return t('age.ago', { value: t('unit.minutes', { n: mins }) });

  var hours = Math.floor(mins / 60);
  var rest = mins % 60;
  var value = t('unit.hours', { n: hours });
  if (rest) value = t('age.join', { a: value, b: t('unit.minutes', { n: rest }) });
  return t('age.ago', { value: value });
}

/** ISO-строка из кэша обратно в Date (или null). */
function toDate(value) {
  if (!value) return null;
  var d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/* ------------------------------------------------------------------ */
/*  Кэш последних удачных ответов                                      */
/*                                                                     */
/*  Кэш необязателен: в приватном режиме обращение к localStorage может */
/*  бросить исключение, при переполнении квоты падает setItem. Любая    */
/*  ошибка хранилища просто означает работу как раньше, без кэша.       */
/* ------------------------------------------------------------------ */

var CACHE = {
  prefix: 'aurora.',
  maxAgeMs: 3 * 60 * 60 * 1000 // старше трёх часов не показываем
};

function cacheSave(key, payload) {
  try {
    localStorage.setItem(CACHE.prefix + key, JSON.stringify({
      savedAt: Date.now(),
      payload: payload
    }));
  } catch (e) { /* хранилище недоступно или переполнено */ }
}

/** Возвращает { payload, age } или null, если записи нет либо она просрочена. */
function cacheLoad(key) {
  try {
    var raw = localStorage.getItem(CACHE.prefix + key);
    if (!raw) return null;

    var entry = JSON.parse(raw);
    var age = Date.now() - entry.savedAt;

    // Отрицательный возраст означает, что часы перевели назад — доверять нельзя.
    if (!isFinite(age) || age < 0 || age > CACHE.maxAgeMs) {
      cacheDrop(key);
      return null;
    }
    return { payload: entry.payload, age: age };
  } catch (e) {
    cacheDrop(key); // битая запись — выбрасываем, чтобы не спотыкаться о неё снова
    return null;
  }
}

/**
 * Облачность зависит от точки, поэтому кэшируется по каждой отдельно.
 * Kp и его прогноз — планетарные величины, одинаковые для всей области,
 * и хранятся общими ключами: смешиваться там нечему, а копия на каждый город
 * лишила бы запасных данных при переходе в город, куда ещё не заходили.
 */
function cloudCacheKey(point) {
  return 'cloud.' + point.id;
}

function cacheDrop(key) {
  try {
    localStorage.removeItem(CACHE.prefix + key);
  } catch (e) { /* см. выше */ }
}

/*
 * Подписи устаревших данных. Пока запрос в пути, сохранённые данные уже на
 * экране — и честнее сказать «обновляем», чем «нет связи».
 */
var LEAD_OFFLINE = 'lead.offline';        // ключи словаря: «Нет связи. Данные»
var LEAD_REFRESHING = 'lead.refreshing';  // «Обновляем. Данные»

function restoreKp(cached, refreshing) {
  return {
    value: cached.payload.value,
    time: toDate(cached.payload.time),
    stale: cached.age,
    refreshing: !!refreshing
  };
}

function restoreCloud(cached, point, refreshing) {
  var cloud = cached.payload;
  cloud.time = toDate(cloud.time);
  cloud.stale = cached.age;
  cloud.pointId = point.id;
  cloud.refreshing = !!refreshing;

  // Прогноз «через 3 часа» мог уже стать прошлым — тогда не показываем его.
  if (cloud.soon) {
    cloud.soon.time = toDate(cloud.soon.time);
    if (!cloud.soon.time || cloud.soon.time.getTime() < Date.now()) cloud.soon = null;
  }
  return cloud;
}

/**
 * Переключает карточку между «свежо» и «данные из кэша».
 * ageMs === null — данные живые. lead — ключ словаря с началом фразы.
 */
function applyFreshness(cardId, staleId, ageMs, lead) {
  if (ageMs === null || ageMs === undefined) {
    setState(cardId, 'ok');
    return;
  }

  var note = $(staleId);
  if (note) {
    var text = note.querySelector('.stale__text');
    if (text) text.textContent = t('stale.line', { lead: t(lead || LEAD_OFFLINE), age: fmtAge(ageMs) });
  }
  setState(cardId, 'stale');
}

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
  factors.push(t('verdict.f.light', { v: t('light.' + point.light + '.label') }));
  if (!tooLight && level !== 'low') hint += gap + t('light.' + point.light + '.hint');

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
  $('sw-meta').textContent = sw.time ? t('sw.meta', { time: fmtTime(sw.time) }) : '';

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
      var summary = ovationSummary(data, POINTS, Date.now());
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

function renderWindow() {
  var win = computeNightWindow(state.cloud, state.forecast, state.kp ? state.kp.value : null);

  if (!win) {
    setState('window-card', 'error');
    return;
  }

  var valueEl = $('window-value');
  var hintEl = $('window-hint');
  var metaEl = $('window-meta');
  var list = $('window-hours');
  list.innerHTML = '';

  if (win.polarDay) {
    setTone($('window-card'), TONE.mid);
    setTone(valueEl, TONE.mid);
    valueEl.textContent = t('win.no_dark');
    hintEl.textContent = t('win.polar');
    metaEl.textContent = '';
    applyFreshness('window-card', 'window-stale', state.cloud.stale, 'lead.calc_saved');
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

  // Почасовая полоса всей ночи
  win.night.forEach(function (h) {
    var cell = document.createElement('div');
    var inWindow = h.time >= win.from && h.time < win.to;
    cell.className = 'hour' + (inWindow ? ' hour--best' : '');
    setTone(cell, h.level === 2 ? TONE.ok : (h.level === 1 ? TONE.mid : TONE.bad));

    var time = document.createElement('div');
    time.className = 'hour__time';
    time.textContent = fmtTime(h.time);

    var cloud = document.createElement('div');
    cloud.className = 'hour__cloud';
    cloud.textContent = h.cloud + '%';

    var kp = document.createElement('div');
    kp.className = 'hour__kp';
    kp.textContent = (h.kp === null || h.kp === undefined) ? '—' : t('hour.kp', { v: fmtKp(h.kp) });

    cell.appendChild(time);
    cell.appendChild(cloud);
    cell.appendChild(kp);
    list.appendChild(cell);
  });

  var meta = t('win.meta', {
    from: fmtTime(win.night[0].time),
    to: fmtTime(new Date(win.night[win.night.length - 1].time.getTime() + 3600000))
  });
  if (win.noKp) meta += t('sep.sentence') + t('win.no_kp');
  metaEl.textContent = meta;

  applyFreshness('window-card', 'window-stale', state.cloud.stale, 'lead.calc_saved');
}

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
  if (data.length !== POINTS.length) {
    throw appError('points_count', { got: data.length, want: POINTS.length });
  }

  // Порядок ответа совпадает с порядком переданных координат.
  return POINTS.map(function (point, i) {
    return { id: point.id, hours: readHourlyCloud(data[i]) };
  });
}

function loadTonight() {
  if (!state.tonight) {
    var early = cacheLoad('tonight');
    if (early) {
      state.tonight = { rows: early.payload, stale: early.age };
      renderTonight();
    }
  }
  markLoading('best-card');
  markLoading('places-card');

  // Смена вкладки правит хэш, а hashchange вызывает showTab повторно. Без
  // этого флага второй вызов успевал уйти в сеть до ответа на первый.
  state.tonightLoading = true;

  return fetchJson(allPointsWeatherUrl())
    .then(function (data) {
      var rows = readAllPointsHours(data);
      state.tonight = { rows: rows, stale: null };
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
      setState('best-card', 'error');
      setState('places-card', 'error');
      return null;
    })
    .finally(function () { state.tonightLoading = false; });
}

/** Окно на ближайшую ночь для каждой точки, отсортированное по привлекательности. */
function computeAllWindows() {
  if (!state.tonight || !state.tonight.rows) return null;

  var kpNow = state.kp ? state.kp.value : null;

  var list = state.tonight.rows.map(function (row) {
    var point = findPoint(row.id);
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

function renderTonight() {
  var list = computeAllWindows();

  if (!list) {
    setState('best-card', 'error');
    setState('places-card', 'error');
    return;
  }

  renderBest(list);
  renderPlaces(list);

  var age = state.tonight.stale;
  applyFreshness('best-card', 'best-stale', age, 'lead.calc_saved');
  setState('places-card', 'ok');
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
    hintEl.textContent = reason + t('sep.sentence') + t('best.wait');
    return;
  }

  var tone = levelTone(win.level);
  setTone($('best-card'), tone);
  setTone(valueEl, tone);

  valueEl.textContent = t('best.value', { name: pointName(best.point), from: fmtTime(win.from), to: fmtTime(win.to) });

  hintEl.textContent = levelWord(win.level).toLowerCase() + t('sep.dot') + cloudRangeText(win) +
    (win.kpMax !== null ? t('sep.dot') + t('win.kp_max', { v: fmtKp(win.kpMax) }) : '') +
    (best.point.km ? t('best.travel', { dist: distText(best.point.km), drive: driveText(best.point) })
                   : t('best.here'));

  [
    t('best.chip.light', { v: t('light.' + best.point.light + '.label') }),
    t('best.chip.threshold', { v: fmtKp(kpThresholds(best.point).low) }),
    t(win.fullDark ? 'best.chip.dark_full' : 'best.chip.dark_part'),
    moonWindowText(moonSummary(win.from, win.to, best.point.lat, best.point.lon))
  ].forEach(function (text) {
    var li = document.createElement('li');
    li.textContent = text;
    factors.appendChild(li);
  });
}

function renderPlaces(list) {
  var box = $('places-list');
  box.innerHTML = '';

  list.forEach(function (item, index) {
    var point = item.point;
    var win = item.window;
    var usable = win && !win.polarDay;
    var tone = usable ? levelTone(win.level) : TONE.bad;

    var row = document.createElement('div');
    row.className = 'place' + (index === 0 && usable && win.level >= 1 ? ' place--best' : '');
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
    var travelParts = point.km
      ? [t('place.travel', { dist: distText(point.km), drive: driveText(point) })]
      : [t('place.origin')];
    if (point.noteKey) travelParts.push(t('note.' + point.noteKey));
    travelParts.push(t('place.light', { v: t('light.' + point.light + '.label') }));
    travel.textContent = travelParts.join(t('sep.dot'));

    row.appendChild(name);
    row.appendChild(level);
    row.appendChild(facts);
    row.appendChild(travel);
    box.appendChild(row);
  });
}

/* ------------------------------------------------------------------ */
/*  Уведомления о высоком шансе                                        */
/*                                                                     */
/*  У сайта нет сервера push-уведомлений, поэтому закрытая страница     */
/*  проснуться не может: уведомления работают, пока приложение открыто  */
/*  — во вкладке, в том числе фоновой, или в установленном окне.        */
/*  Проверка идёт на каждом пересчёте вердикта, то есть при             */
/*  автообновлении раз в 5 минут.                                       */
/* ------------------------------------------------------------------ */

/*
 * Суббури идут волнами с интервалом в 2–3 часа. Уведомление на каждую
 * волну было бы шумом, но новый эпизод позже ночью заслуживает сигнала.
 */
var NOTIFY_COOLDOWN_MS = 3 * 60 * 60 * 1000;

function notifySupported() {
  return 'Notification' in window;
}

function notifyEnabled() {
  try {
    return localStorage.getItem(CACHE.prefix + 'notify') === 'on';
  } catch (e) {
    return false;
  }
}

function setNotifyEnabled(on) {
  try {
    localStorage.setItem(CACHE.prefix + 'notify', on ? 'on' : 'off');
  } catch (e) { /* без хранилища включение не переживёт перезагрузку */ }
}

/** Время последнего уведомления по точке — хранится, чтобы пережить перезагрузку. */
function lastNotifiedAt(pointId) {
  try {
    return Number(localStorage.getItem(CACHE.prefix + 'notified.' + pointId)) || 0;
  } catch (e) {
    return 0;
  }
}

function markNotified(pointId) {
  try {
    localStorage.setItem(CACHE.prefix + 'notified.' + pointId, String(Date.now()));
  } catch (e) { /* в худшем случае уведомление повторится после перезагрузки */ }
}

/**
 * Показ через service worker: на Android конструктор new Notification()
 * не работает вовсе. Если воркера нет — обычный конструктор.
 */
function showAppNotification(title, options) {
  options.icon = new URL('icons/icon-192.png', location.href).href;
  options.badge = options.icon;
  options.lang = langInfo().html;
  options.data = { url: location.href.split('#')[0] + '#now' };

  // Результат — каким способом показали; ошибка — если не получилось никак.
  // Вкладке «Уведомления» это нужно, чтобы сказать человеку, что сломалось.
  var direct = function () {
    new Notification(title, options);
    return 'direct';
  };

  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    return navigator.serviceWorker.ready
      .then(function (reg) { return reg.showNotification(title, options); })
      .then(function () { return 'sw'; }, direct);
  }
  return new Promise(function (resolve) { resolve(direct()); });
}

function ignore() { /* результат не нужен, а необработанный отказ шумел бы в консоли */ }

/**
 * Вызывается при каждом пересчёте вердикта. Шлёт уведомление при переходе
 * выбранной точки в «Высокий», соблюдая все ограничения ниже.
 */
function checkHighChance(verdict) {
  // По сохранённым данным не будим: устаревший «высокий» — не повод. Такой
  // расчёт не становится и точкой отсчёта — ею служит первый свежий.
  if (!verdict || verdict.stale) return;

  var point = currentPoint();
  var prev = state.lastLevel;
  state.lastLevel = { pointId: point.id, level: verdict.level };

  if (verdict.level !== 'high') return;
  // Первый свежий расчёт после открытия или смены точки — только точка
  // отсчёта: высокий шанс и так на экране.
  if (!prev || prev.pointId !== point.id) return;
  // Шанс уже был высоким — о нём уже сообщили или он был на экране.
  if (prev.level === 'high') return;

  if (!notifySupported() || !notifyEnabled() || Notification.permission !== 'granted') return;
  // Уведомления с сервера включены — они придут и без страницы; свои не дублируем.
  if (pushIsActive()) return;
  // Вкладка в фокусе — вердикт и так перед глазами.
  if (document.hasFocus()) return;
  // Тихие часы: не беспокоим, этот переход пропускается.
  if (inQuietNow()) return;
  if (Date.now() - lastNotifiedAt(point.id) < NOTIFY_COOLDOWN_MS) return;

  markNotified(point.id);
  showAppNotification(t('notif.high.title', { name: pointName(point) }), {
    body: t('notif.high.body', { factors: verdict.factors.slice(0, 3).join(t('sep.dot')) }),
    tag: 'aurora-high-' + point.id  // новое уведомление по точке заменяет старое
  }).catch(ignore);
}

/** Разрешение: современный вариант с промисом и старый с колбэком (Safari). */
function askNotificationPermission() {
  return new Promise(function (resolve) {
    var result = Notification.requestPermission(resolve);
    if (result && result.then) result.then(resolve);
  });
}

function renderNotifyControl() {
  var btn = $('notify-btn');
  var hint = $('notify-hint');

  if (!notifySupported()) {
    btn.hidden = true;
    hint.textContent = t('notify.unsupported');
    return;
  }

  btn.hidden = false;
  var permission = Notification.permission;
  var on = notifyEnabled() && permission === 'granted';

  btn.disabled = (permission === 'denied');
  btn.setAttribute('aria-pressed', String(on));
  btn.textContent = t(on ? 'notify.btn.on' : 'notify.btn.off');

  if (permission === 'denied') {
    hint.textContent = t('notify.hint.denied');
  } else if (pushIsActive()) {
    hint.textContent = t('notify.hint.server');
  } else if (on) {
    hint.textContent = t('notify.hint.on');
  } else {
    hint.textContent = t('notify.hint.off');
  }
}

function initNotifications() {
  renderNotifyControl();

  $('notify-btn').addEventListener('click', function () {
    if (notifyEnabled() && Notification.permission === 'granted') {
      setNotifyEnabled(false);
      renderNotifyControl();
      renderNotifyDiagnostics();
      return;
    }

    askNotificationPermission().then(function (permission) {
      if (permission === 'granted') {
        setNotifyEnabled(true);
        // Пробное уведомление: сразу видно, что система их пропускает.
        showAppNotification(t('notif.enabled.title'), {
          body: t('notif.enabled.body', { name: pointName(currentPoint()) }),
          tag: 'aurora-test'
        }).catch(ignore);
      }
      renderNotifyControl();
      renderNotifyDiagnostics();
    });
  });
}

/* ------------------------------------------------------------------ */
/*  Вкладка «Уведомления»: проверка работоспособности                  */
/* ------------------------------------------------------------------ */

var CHECK_MARKS = {
  ok:   { mark: '✓', tone: TONE.ok,  label: 'check.ok' },
  warn: { mark: '!', tone: TONE.mid, label: 'check.warn' },
  fail: { mark: '✕', tone: TONE.bad, label: 'check.fail' }
};

function isStandalone() {
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    window.navigator.standalone === true;
}

function isIOS() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** Список проверок: что должно сойтись, чтобы уведомление дошло. */
function notifyChecks() {
  var checks = [];
  var supported = notifySupported();
  var permission = supported ? Notification.permission : null;
  var place = pointName(currentPoint());

  checks.push(supported
    ? { state: 'ok', title: t('chk.support.ok') }
    : { state: 'fail', title: t('chk.support.fail'),
        detail: t(isIOS() ? 'chk.support.fail.ios' : 'chk.support.fail.other') });

  if (supported) {
    if (permission === 'granted') {
      checks.push({ state: 'ok', title: t('chk.perm.granted') });
    } else if (permission === 'denied') {
      checks.push({ state: 'fail', title: t('chk.perm.denied'), detail: t('chk.perm.denied.d') });
    } else {
      checks.push({ state: 'warn', title: t('chk.perm.default'), detail: t('chk.perm.default.d') });
    }
  }

  var sw = 'serviceWorker' in navigator;
  var controlled = sw && !!navigator.serviceWorker.controller;
  checks.push(controlled
    ? { state: 'ok', title: t('chk.sw.ok') }
    : { state: 'warn', title: t(sw ? 'chk.sw.inactive' : 'chk.sw.missing'),
        detail: t(sw ? 'chk.sw.inactive.d' : 'chk.sw.missing.d') });

  var on = notifyEnabled() && permission === 'granted';
  checks.push({
    state: on ? 'ok' : 'warn',
    title: t(on ? 'chk.alerts.on' : 'chk.alerts.off'),
    detail: on ? t('chk.alerts.on.d', { name: place })
         : permission === 'denied' ? t('chk.alerts.off.denied')
         : t('chk.alerts.off.d'),
    toggle: supported && permission !== 'denied' ? t(on ? 'chk.alerts.turn_off' : 'chk.alerts.turn_on') : null
  });

  if (pushConfigured()) {
    var serverOn = pushIsActive();
    checks.push(pushSupported()
      ? { state: 'ok', title: t('chk.push.ok') }
      : { state: 'fail', title: t('chk.push.fail'), detail: t('chk.push.fail.d') });

    checks.push(serverOn
      ? { state: 'ok', title: t('chk.sub.on'), detail: t('chk.sub.on.d', { name: place }) }
      : { state: 'warn', title: t('chk.sub.off'), detail: t('chk.sub.off.d') });

    checks.push(state.pushHealth === true
      ? { state: 'ok', title: t('chk.server.ok') }
      : state.pushHealth === false
        ? { state: 'fail', title: t('chk.server.fail'), detail: t('chk.server.fail.d') }
        : { state: 'warn', title: t('chk.server.pending') });
  }

  if (isIOS() && !isStandalone()) {
    checks.push({ state: 'fail', title: t('chk.mode.ios'), detail: t('chk.mode.ios.d') });
  } else {
    checks.push(isStandalone()
      ? { state: 'ok', title: t('chk.mode.app') }
      : { state: 'ok', title: t('chk.mode.tab'), detail: t('chk.mode.tab.d') });
  }

  return checks;
}

function renderNotifyDiagnostics() {
  var list = $('ntest-checks');
  if (!list) return;
  list.innerHTML = '';

  notifyChecks().forEach(function (check) {
    var look = CHECK_MARKS[check.state];
    var li = document.createElement('li');
    li.className = 'check';

    var mark = document.createElement('span');
    mark.className = 'check__mark';
    mark.textContent = look.mark;
    mark.setAttribute('aria-label', t(look.label));
    setTone(mark, look.tone);

    var title = document.createElement('span');
    title.className = 'check__title';
    title.textContent = check.title;

    li.appendChild(mark);
    li.appendChild(title);

    if (check.toggle) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn--ghost btn--mini';
      btn.textContent = check.toggle;
      btn.addEventListener('click', function () { $('notify-btn').click(); });
      li.appendChild(btn);
    }

    if (check.detail) {
      var detail = document.createElement('span');
      detail.className = 'check__detail';
      detail.textContent = check.detail;
      li.appendChild(detail);
    }

    list.appendChild(li);
  });

  var denied = notifySupported() && Notification.permission === 'denied';
  $('ntest-now').disabled = !notifySupported() || denied;
  $('ntest-later').disabled = !notifySupported() || denied;

  renderPushCard();
}

function setTestStatus(text, tone) {
  var el = $('ntest-status');
  el.textContent = text;
  setTone(el, tone || null);
}

/** Пробное уведомление: сейчас или с задержкой, чтобы успеть свернуть приложение. */
function sendTestNotification(delayMs) {
  if (!notifySupported()) return;

  var permissionReady = Notification.permission === 'granted'
    ? Promise.resolve('granted')
    : askNotificationPermission();

  permissionReady.then(function (permission) {
    renderNotifyDiagnostics();
    renderNotifyControl();

    if (permission !== 'granted') {
      setTestStatus(t('ntest.denied'), TONE.bad);
      return;
    }

    var send = function () {
      showAppNotification(t('notif.test.title'), {
        body: t('notif.test.body', { name: pointName(currentPoint()) }),
        tag: 'aurora-test'
      }).then(function (how) {
        setTestStatus(t('ntest.sent', {
          time: new Date().toLocaleTimeString(langLocale(), { timeZone: displayZone(), hourCycle: clockCycle() }),
          how: t('how.' + how)
        }), TONE.ok);
      }, function (err) {
        setTestStatus(t('ntest.failed', { reason: (err && err.message) || err }), TONE.bad);
      });
    };

    if (delayMs) {
      var seconds = Math.round(delayMs / 1000);
      setTestStatus(t('ntest.later', { sec: t('unit.seconds', { n: seconds }) }), TONE.mid);
      setTimeout(send, delayMs);
    } else {
      send();
    }
  });
}

function initNotifyTab() {
  $('ntest-now').addEventListener('click', function () { sendTestNotification(0); });
  $('ntest-later').addEventListener('click', function () { sendTestNotification(10000); });

  // Разрешение могли поменять в настройках браузера — следим, где это возможно.
  try {
    navigator.permissions.query({ name: 'notifications' }).then(function (status) {
      status.onchange = function () {
        renderNotifyDiagnostics();
        renderNotifyControl();
      };
    }, ignore);
  } catch (e) { /* API разрешений нет — обновим при возврате на вкладку */ }

  renderNotifyDiagnostics();
}

/* ------------------------------------------------------------------ */
/*  Уведомления с сервера (при закрытом приложении)                    */
/*  Подписка и обращения к серверу — в push.js, здесь только интерфейс. */
/* ------------------------------------------------------------------ */

/** Ошибка подписки или обращения к серверу — человеческим языком. */
function pushErrorText(error) {
  // У DOMException поле code числовое (у AbortError это 20), а наши коды — строки.
  var code = (error && typeof error.code === 'string') ? error.code : '';
  var name = error && error.name;

  if (code.indexOf('permission_') === 0 || name === 'NotAllowedError') return t('push.err.permission');
  if (name === 'AbortError' && !code) {
    // Chrome в режиме инкогнито отклоняет подписку так же, как при сбое сети, и определить
    // приватный режим сайт не может (намеренно), поэтому называем оба возможных объяснения.
    return t('push.err.abort');
  }
  if (code === 'subscribe_timeout') return t('push.err.subscribe_timeout');
  if (code === 'no_service_worker') return t('push.err.no_service_worker');
  if (code === 'limit') return t('push.err.limit');
  if (code === 'too_often') return t('push.err.too_often');
  if (code === 'not_subscribed') return t('push.err.not_subscribed');
  // По имени, а не instanceof: ошибка из другого окружения (iframe, воркер) под instanceof не подойдёт.
  if (name === 'TypeError' || name === 'AbortError') return t('push.err.unreachable');
  return t('push.err.generic', { reason: (error && error.message) || error });
}

function setPushStatus(text, tone) {
  var el = $('push-status');
  el.textContent = text;
  setTone(el, tone || null);
}

function renderPushCard() {
  var card = $('push-card');
  if (!card) return;

  if (!pushConfigured()) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  var supported = pushSupported();
  var permission = notifySupported() ? Notification.permission : 'denied';
  var active = pushIsActive();
  var busy = !!state.pushBusy;

  var toggle = $('push-toggle');
  toggle.textContent = t(active ? 'push.toggle.off' : 'push.toggle.on');
  toggle.setAttribute('aria-pressed', String(active));
  toggle.disabled = busy || !supported || (permission === 'denied' && !active);
  $('push-test').disabled = busy || !active;
  $('push-test-later').disabled = busy || !active;

  var hint = $('push-hint');
  if (!supported) {
    hint.textContent = t((isIOS() && !isStandalone()) ? 'push.hint.ios' : 'push.hint.unsupported');
  } else if (permission === 'denied' && !active) {
    hint.textContent = t('push.hint.denied');
  } else if (active) {
    hint.textContent = t('push.hint.on', { name: pointName(currentPoint()) });
  } else {
    hint.textContent = t('push.hint.off', { name: pointName(currentPoint()) });
  }
}

/** Операция с индикацией: блокирует кнопки, пишет статус, ошибку показывает человеку. */
function runPushAction(label, action, done) {
  state.pushBusy = true;
  renderPushCard();
  setPushStatus(label, TONE.mid);

  return action().then(function (result) {
    state.pushBusy = false;
    done(result);
    renderPushCard();
    renderNotifyControl();
    renderNotifyDiagnostics();
  }, function (error) {
    state.pushBusy = false;
    setPushStatus(pushErrorText(error), TONE.bad);
    renderPushCard();
    renderNotifyDiagnostics();
  }).catch(function (unexpected) {
    // Страховка: ошибка в самом обработчике не должна оставлять кнопки
    // заблокированными, а статус — застрявшим на «Включаем…».
    state.pushBusy = false;
    setPushStatus(t('push.err.generic', { reason: (unexpected && unexpected.message) || unexpected }), TONE.bad);
    renderPushCard();
  });
}

function refreshPushHealth() {
  if (!pushConfigured()) return;
  state.pushHealth = null;
  renderNotifyDiagnostics();
  pushHealth().then(function (ok) {
    state.pushHealth = ok;
    renderNotifyDiagnostics();
  });
}

function initPushCard() {
  $('push-toggle').addEventListener('click', function () {
    if (pushIsActive()) {
      runPushAction(t('push.busy.off'), pushUnsubscribe, function () {
        setPushStatus(t('push.done.off'));
      });
    } else {
      runPushAction(t('push.busy.on'), function () { return pushSubscribe(currentPoint().id); }, function () {
        setPushStatus(t('push.done.on'), TONE.ok);
      });
    }
  });

  $('push-test').addEventListener('click', function () {
    runPushAction(t('push.busy.test'), function () { return pushTest(0); }, function (result) {
      if (result && result.ok) setPushStatus(t('push.done.test_ok'), TONE.ok);
      else setPushStatus(t('push.done.test_rejected', { status: result && result.status }), TONE.bad);
    });
  });

  $('push-test-later').addEventListener('click', function () {
    runPushAction(t('push.busy.later'), function () { return pushTest(20); }, function () {
      setPushStatus(t('push.done.later'), TONE.mid);
    });
  });

  renderPushCard();

  // Разрешение или подписку могли поменять вне приложения — сверяемся при открытии.
  pushSync(currentPoint().id).then(function () {
    renderPushCard();
    renderNotifyControl();
    renderNotifyDiagnostics();
  });
}

/* ------------------------------------------------------------------ */
/*  Вкладки                                                            */
/* ------------------------------------------------------------------ */

var TAB_IDS = ['now', 'tonight', 'settings'];

/** Вкладка «Уведомления» стала частью «Настроек»: старые ссылки #notify и сохранённый выбор ведут туда. */
function tabFromName(name) {
  return name === 'notify' ? 'settings' : name;
}

function savedTab() {
  try {
    return localStorage.getItem(CACHE.prefix + 'tab');
  } catch (e) {
    return null;
  }
}

function saveTab(id) {
  try {
    localStorage.setItem(CACHE.prefix + 'tab', id);
  } catch (e) { /* выбор просто не переживёт перезагрузку */ }
}

/**
 * historyMode: 'push' — обычное переключение, с записью в историю, чтобы
 * работали «назад/вперёд»; 'replace' — при старте и при исправлении
 * неизвестного хэша, без новой записи.
 */
function showTab(id, historyMode) {
  id = tabFromName(id);
  if (TAB_IDS.indexOf(id) < 0) id = 'now';

  TAB_IDS.forEach(function (tab) {
    $('tab-' + tab).hidden = (tab !== id);
  });

  // Паттерн вкладок WAI-ARIA: в порядке Tab стоит только выбранная вкладка,
  // между вкладками перемещаются стрелками.
  var buttons = $('tabs').querySelectorAll('[role="tab"]');
  Array.prototype.forEach.call(buttons, function (btn) {
    var selected = btn.getAttribute('data-tab') === id;
    btn.setAttribute('aria-selected', String(selected));
    btn.tabIndex = selected ? 0 : -1;
  });

  state.tab = id;
  saveTab(id);
  // Адрес всегда соответствует открытой вкладке — в том числе после #foo.
  if (location.hash !== '#' + id) {
    if (historyMode === 'push') location.hash = '#' + id;
    else history.replaceState(null, '', '#' + id);
  }

  // Данные второй вкладки грузятся при первом открытии, а не при старте.
  if (id === 'tonight' && !state.tonight && !state.tonightLoading) loadTonight();
  if (id === 'tonight') loadOutlook(false);
  // Состояние service worker и разрешения могло измениться — показываем актуальное.
  if (id === 'settings') {
    renderNotifyDiagnostics();
    refreshPushHealth();
  }
}

function initTabs() {
  var initial = startTab(tabFromName((location.hash || '').replace('#', '')), tabFromName(savedTab() || 'now'));

  $('tabs').addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-tab]') : null;
    if (btn) showTab(btn.getAttribute('data-tab'), 'push');
  });

  // Стрелки, Home и End переключают вкладки и переводят на них фокус.
  $('tabs').addEventListener('keydown', function (e) {
    var keys = { ArrowRight: 1, ArrowLeft: -1, Home: 'first', End: 'last' };
    if (!(e.key in keys)) return;
    e.preventDefault();

    var index = TAB_IDS.indexOf(state.tab);
    var step = keys[e.key];
    if (step === 'first') index = 0;
    else if (step === 'last') index = TAB_IDS.length - 1;
    else index = (index + step + TAB_IDS.length) % TAB_IDS.length;

    showTab(TAB_IDS[index], 'push');
    $('tab-btn-' + TAB_IDS[index]).focus();
  });

  // Ссылкой с хэшем можно поделиться, работают и кнопки «назад/вперёд».
  window.addEventListener('hashchange', function () {
    showTab((location.hash || '').replace('#', '') || 'now', 'replace');
  });

  showTab(initial, 'replace');
}

/* ------------------------------------------------------------------ */
/*  Вердикт                                                            */
/* ------------------------------------------------------------------ */

function renderVerdict() {
  var v = computeVerdict(state.kp, state.cloud);
  checkHighChance(v);

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

  // Вердикт устарел настолько, насколько устарел самый старый из его входов.
  var ages = [state.kp, state.cloud]
    .filter(function (item) { return item && item.stale; })
    .map(function (item) { return item.stale; });

  applyFreshness('verdict-card', 'verdict-stale',
    ages.length ? Math.max.apply(null, ages) : null,
    'lead.verdict_saved');
}

/* ------------------------------------------------------------------ */
/*  Оркестрация                                                        */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Селектор точки                                                     */
/* ------------------------------------------------------------------ */

/** «68,97° с. ш.» / «68.97° N» / «北纬68.97°»: слова — в словарях, coord.<сторона>. */
function fmtCoord(value, positive, negative) {
  return t('coord.' + (value >= 0 ? positive : negative), { v: fmtNum(Math.abs(value).toFixed(2)) });
}

/** Подпись под заголовком и название вкладки. */
function renderPointMeta() {
  var point = currentPoint();
  var limits = kpThresholds(point);

  $('point-meta').textContent = t('meta.point', {
    lat: fmtCoord(point.lat, 'n', 's'),
    lon: fmtCoord(point.lon, 'e', 'w'),
    geo: fmtNum(point.geoLat.toFixed(1)),
    kp: fmtKp(limits.low)
  });

  // Название приложения — в <title> и манифесте; во вкладке браузера
  // впереди выбранная точка, чтобы несколько открытых вкладок различались.
  document.title = t('title.point', { name: pointName(point) });
}

function initPointSelect() {
  var select = $('point');

  POINTS.forEach(function (point) {
    var option = document.createElement('option');
    option.value = point.id;
    option.textContent = pointName(point);
    select.appendChild(option);
  });

  state.point = findPoint(savedPointId() || POINTS[0].id);
  select.value = state.point.id;
  renderPointMeta();

  select.addEventListener('change', function () {
    state.point = findPoint(select.value);
    savePointId(state.point.id);
    // Серверные уведомления привязаны к точке: подписка переезжает вместе с выбором.
    pushSync(state.point.id).then(function () {
      renderPushCard();
      renderNotifyDiagnostics();
    });
    renderPointMeta();
    renderOvation();
    renderOutlook();

    // Облачность принадлежала прежней точке — её нельзя показывать для новой.
    // Kp и его прогноз планетарные, их при смене города не перезапрашиваем.
    state.cloud = null;
    replaceWithLoading('cloud-card');
    replaceWithLoading('wx-card');
    replaceWithLoading('verdict-card');
    replaceWithLoading('window-card');

    loadCloud().then(function (cloud) {
      if (cloud === null && state.cloudPending) return; // ответ устарел
      renderDerived();
      updateStatus();
    });

    // Если по новой точке есть сохранённые данные, они уже на экране.
    renderDerived();
  });
}

/** Всё, что считается из уже загруженных данных. */
function renderDerived() {
  // Пока облачность для выбранной точки в пути и показать нечего, вердикт и
  // окно не трогаем: иначе на мгновение показалось бы «облачность: данных нет».
  // Если на экране сохранённые данные этой точки — считаем по ним.
  if (!(state.cloudPending && !state.cloud)) {
    renderVerdict();
    renderWindow();
  }
  // Ночная вкладка опирается на общий прогноз Kp: если он обновился,
  // её оценки надо пересчитать. Но только когда данные уже загружены.
  if (state.tonight) renderTonight();
}

/**
 * Строка статуса в шапке. Запоминаем ключ и момент, а не готовый текст: язык, формат
 * времени и пояс можно сменить, и строка должна пересобраться.
 */
function setStatus(key, at) {
  state.status = { key: key, at: at || null };
  renderStatus();
}

function renderStatus() {
  if (!state.status) return;
  $('updated').textContent = t(state.status.key, state.status.at ? { time: fmtTime(state.status.at) } : undefined);
}

/** Строка статуса в шапке по текущему состоянию данных. */
function updateStatus() {
  // Свежесть определяется флагом stale, а не наличием данных: после отката
  // на кэш в state лежат значения, но «Обновлено» писать про них нельзя.
  var fresh = (state.kp && !state.kp.stale) || (state.cloud && !state.cloud.stale);

  if (fresh) {
    state.lastOk = new Date();
    setStatus('status.updated', state.lastOk);
  } else if (state.kp || state.cloud) {
    setStatus('status.offline_saved');
  } else if (state.lastOk) {
    setStatus('status.offline_last', state.lastOk);
  } else {
    setStatus('status.offline_none');
  }
}

function refreshAll() {
  // Автообновление, кнопка и возврат на вкладку могут совпасть по времени —
  // второе обновление просто присоединяется к идущему.
  if (state.refreshing) return state.refreshing;

  var btn = $('refresh');
  btn.disabled = true;
  setStatus('status.refreshing');
  markLoading('verdict-card');
  markLoading('window-card');

  var tasks = [loadKp(), loadCloud(), loadForecast(), loadSolarWind(), loadOvation(false)];
  if (state.tonight) tasks.push(loadTonight());

  // Загрузчики уже положили на экран сохранённые данные — вердикт и окно
  // считаем по ним сразу, не дожидаясь сети.
  renderDerived();

  state.refreshing = Promise.all(tasks)
    .then(function () {
      renderDerived();
      updateStatus();
    })
    .finally(function () {
      btn.disabled = false;
      state.refreshing = null;
    });

  return state.refreshing;
}

/* ------------------------------------------------------------------ */
/*  Настройки отображения                                              */
/*                                                                     */
/*  Хранятся одной записью в localStorage; любое значение, которого нет */
/*  среди допустимых, заменяется значением по умолчанию — испорченная   */
/*  запись не должна ломать страницу. По умолчанию всё как было раньше. */
/* ------------------------------------------------------------------ */

var SETTINGS_DEFAULTS = { tz: 'murmansk', clock: '24', dist: 'km', temp: 'c', refresh: '5',
                          theme: 'dark', size: 'normal', start: 'last', quiet: 'off' };
var SETTINGS_CHOICES = {
  tz: ['murmansk', 'device'],
  clock: ['24', '12'],
  dist: ['km', 'mi'],
  temp: ['c', 'f'],
  refresh: ['5', '10', '30', '0'],  // минуты; 0 — не обновлять само
  theme: ['dark', 'light', 'auto'],
  size: ['normal', 'large', 'xlarge'],
  start: ['last', 'now', 'tonight'],  // last — вкладка, на которой закрыли
  quiet: ['off', '22-08', '23-07', '00-06']   // часы, когда уведомления о сиянии не присылаются
};

function loadSettings() {
  var saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(CACHE.prefix + 'settings') || '{}') || {};
  } catch (e) { /* нет хранилища или запись испорчена — работаем со значениями по умолчанию */ }

  var out = {};
  Object.keys(SETTINGS_DEFAULTS).forEach(function (name) {
    out[name] = SETTINGS_CHOICES[name].indexOf(saved[name]) >= 0 ? saved[name] : SETTINGS_DEFAULTS[name];
  });
  return out;
}

function saveSettings() {
  try {
    localStorage.setItem(CACHE.prefix + 'settings', JSON.stringify(state.settings));
  } catch (e) { /* без хранилища выбор просто не переживёт перезагрузку */ }
}

function setting(name) {
  if (!state.settings) state.settings = loadSettings();
  return state.settings[name];
}

/** Возвращает true, если значение допустимо и применено. */
function setSetting(name, value) {
  // hasOwnProperty: имя вроде «__proto__» не должно находить чужие свойства объекта.
  if (!Object.prototype.hasOwnProperty.call(SETTINGS_CHOICES, name) || SETTINGS_CHOICES[name].indexOf(value) < 0) return false;
  setting(name);
  state.settings[name] = value;
  saveSettings();
  return true;
}

function resetSettings() {
  state.settings = {};
  Object.keys(SETTINGS_DEFAULTS).forEach(function (name) { state.settings[name] = SETTINGS_DEFAULTS[name]; });
  try {
    localStorage.removeItem(CACHE.prefix + 'settings');
  } catch (e) { /* см. выше */ }
}

/** Тема с учётом «авто»: по настройке системы. */
function resolvedTheme() {
  var theme = setting('theme');
  if (theme !== 'auto') return theme;
  var light = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  return light ? 'light' : 'dark';
}

var THEME_COLORS = { dark: '#060b14', light: '#eef4f8' };

/** Тема и размер текста — атрибутами страницы; цвет строки состояния браузера — в тон теме. */
function applyAppearance() {
  var root = document.documentElement;
  var theme = resolvedTheme();
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-size', setting('size'));

  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[theme]);
}

/** Окно тихих часов {from, to} или null, если выключено. */
function quietWindow() {
  var value = setting('quiet');
  var match = /^(\d\d)-(\d\d)$/.exec(value);
  return match ? { from: Number(match[1]), to: Number(match[2]) } : null;
}

/** Часовой пояс, по которому считаются тихие часы: тот же, что показан на экране. */
function quietZone() {
  return displayZone() || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Сейчас тихие часы? Уведомления страницы в это время не показываются. */
function inQuietNow() {
  var quiet = quietWindow();
  return !!quiet && inQuietHours(new Date(), quietZone(), quiet.from, quiet.to);
}

/**
 * Что страница сообщает серверу уведомлений сверх точки: язык, тихие часы и пояс, по которому
 * они считаются. Вызывается из push.js при подписке и синхронизации.
 */
function pushPreferences() {
  var quiet = quietWindow();
  return { lang: getLang(), quiet: quiet, tz: quietZone() };
}

/** Вкладка при открытии: адрес важнее всего, затем настройка, затем последняя открытая. */
function startTab(fromHash, saved) {
  if (TAB_IDS.indexOf(fromHash) >= 0) return fromHash;
  var choice = setting('start');
  if (choice !== 'last') return choice;
  return TAB_IDS.indexOf(saved) >= 0 ? saved : 'now';
}

/** Период автообновления в мс; 0 — выключено. */
function refreshMs() {
  return Number(setting('refresh')) * 60 * 1000;
}

/**
 * Пора ли обновить данные при возврате на вкладку: только если автообновление включено
 * и с последнего удачного обновления прошло больше его периода. Выключено — только по кнопке.
 */
function refreshDue() {
  var every = refreshMs();
  return every > 0 && (!state.lastOk || Date.now() - state.lastOk.getTime() > every);
}

/** (Пере)запускает автообновление по текущей настройке. */
function armRefresh() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  var every = refreshMs();
  if (every) state.timer = setInterval(refreshAll, every);
}

/** Кнопки настроек: выбранное значение отмечено для скринридеров и для глаз. */
function renderSettings() {
  var groups = document.querySelectorAll('[data-pref]');
  Array.prototype.forEach.call(groups, function (group) {
    var name = group.getAttribute('data-pref');
    Array.prototype.forEach.call(group.querySelectorAll('[data-value]'), function (btn) {
      btn.setAttribute('aria-pressed', String(btn.getAttribute('data-value') === setting(name)));
    });
  });

  // Подписи, которые зависят от настроек: в каком поясе время и как часто идёт обновление.
  var note = $('forecast-note');
  if (note) note.textContent = t('forecast.note', { zone: t('tz.' + setting('tz')) });

  var foot = $('foot-refresh');
  if (foot) {
    var every = refreshMs();
    foot.textContent = every ? t('foot.refresh', { every: t('unit.minutes', { n: every / 60000 }) }) : t('foot.refresh_off');
  }
}

/** Всё, что показано, перерисовывается: единицы и время меняются повсюду. */
/** changed — имя изменённой настройки (или 'reset'): на сервер нужно сообщать только пояс и тихие часы. */
function afterSettingsChange(changed) {
  armRefresh();
  applyAppearance();
  renderLocalized();
  if (changed === 'tz' || changed === 'quiet' || changed === 'reset') {
    pushSync(currentPoint().id).then(renderNotifyDiagnostics);
  }
}

function initSettings() {
  // Тема «авто» следует за системой: переключили — перекрашиваемся.
  try {
    var scheme = window.matchMedia('(prefers-color-scheme: light)');
    if (scheme.addEventListener) scheme.addEventListener('change', applyAppearance);
  } catch (e) { /* без matchMedia остаётся выбор при загрузке */ }

  $('tab-settings').addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-value]') : null;
    var group = btn && btn.closest ? btn.closest('[data-pref]') : null;
    if (!btn || !group) return;
    var name = group.getAttribute('data-pref');
    if (setSetting(name, btn.getAttribute('data-value'))) afterSettingsChange(name);
  });

  $('prefs-reset').addEventListener('click', function () {
    resetSettings();
    afterSettingsChange('reset');
  });
}

/* ------------------------------------------------------------------ */
/*  Язык                                                               */
/* ------------------------------------------------------------------ */

function savedLang() {
  try {
    return localStorage.getItem(CACHE.prefix + 'lang');
  } catch (e) {
    return null;
  }
}

function saveLang(code) {
  try {
    localStorage.setItem(CACHE.prefix + 'lang', code);
  } catch (e) { /* выбор просто не переживёт перезагрузку */ }
}

/** Язык из адреса: ?lang=en. Ссылкой с таким параметром можно поделиться. */
function langFromUrl() {
  var match = /[?&]lang=([a-zA-Z-]+)/.exec(location.search || '');
  return match ? langFromTag(match[1]) : null;
}

/** Кнопки переключателя: выбранный язык отмечен для скринридеров и для глаз. */
function renderLangSwitch() {
  var buttons = document.querySelectorAll('[data-lang]');
  Array.prototype.forEach.call(buttons, function (btn) {
    btn.setAttribute('aria-pressed', String(btn.getAttribute('data-lang') === getLang()));
  });
}

/**
 * Перерисовывает всё, что зависит от языка: разметку, названия точек, подписи и
 * уже посчитанные карточки. Данные заново не запрашиваются.
 */
function applyLanguage() {
  document.documentElement.setAttribute('lang', langInfo().html);
  i18nApply(document);

  var description = document.querySelector('meta[name="description"]');
  if (description) description.setAttribute('content', t('meta.description'));
  var appTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]');
  if (appTitle) appTitle.setAttribute('content', t('meta.app_title'));

  renderLangSwitch();

  // Сообщения о ходе операции остались бы на прежнем языке — убираем.
  $('ntest-status').textContent = '';
  $('push-status').textContent = '';

  renderLocalized();
}

/** Всё, что зависит от языка и настроек и берётся из уже загруженных данных. */
function renderLocalized() {
  renderSettings();

  // Названия городов в выпадающем списке.
  var select = $('point');
  Array.prototype.forEach.call(select.options || [], function (option) {
    option.textContent = pointName(findPoint(option.value));
  });
  renderPointMeta();
  $('cloud-model').textContent = t('cloud.model', { model: weatherModelLabel() });

  if (state.kp) renderKp(state.kp);
  if (state.cloud) renderCloud(state.cloud);
  if (state.sw) renderSolarWind(state.sw);
  renderOvation();
  renderOutlook();
  if (state.forecast) renderForecast(state.forecast, state.forecastAge, false);
  renderDerived();

  refreshErrors();
  renderStatus();
  renderNotifyControl();
  renderNotifyDiagnostics();
}

function initLanguage() {
  var explicit = langFromUrl();
  if (explicit) saveLang(explicit);

  setLang(detectLang(explicit, savedLang(), navigator.languages || [navigator.language]));

  $('lang').addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-lang]') : null;
    if (!btn || btn.getAttribute('data-lang') === getLang()) return;

    setLang(btn.getAttribute('data-lang'));
    saveLang(getLang());
    // ?lang= в адресе перебивал бы сделанный выбор при каждой перезагрузке.
    if (langFromUrl()) history.replaceState(null, '', location.pathname + location.hash);
    applyLanguage();
    // Уведомления с сервера приходят на выбранном языке — сообщаем серверу о смене.
    pushSync(currentPoint().id).then(renderNotifyDiagnostics);
  });
}

function init() {
  // До появления выбора точки облачность лежала в общем ключе. У тех, кто
  // заходил раньше, он остался мусором — убираем при первом же запуске.
  cacheDrop('cloud');

  initLanguage();
  applyAppearance();
  initSettings();
  initPointSelect();
  initNotifications();
  initNotifyTab();
  initPushCard();
  initTabs();
  $('refresh').addEventListener('click', refreshAll);

  // Кнопки «Повторить» внутри карточек перезагружают только свой блок.
  document.addEventListener('click', function (e) {
    var target = e.target.closest ? e.target.closest('[data-retry]') : null;
    if (!target) return;
    var what = target.getAttribute('data-retry');
    if (what === 'tonight')  loadTonight();
    if (what === 'kp')       loadKp().then(renderDerived);
    if (what === 'cloud')    loadCloud().then(renderDerived);
    if (what === 'forecast') loadForecast().then(renderDerived);
    if (what === 'sw')       loadSolarWind().then(renderDerived);
    if (what === 'ov')       loadOvation(true);
    if (what === 'outlook')  loadOutlook(true);
  });

  applyLanguage();
  refreshAll();
  armRefresh();

  // Вернулись на вкладку после долгого отсутствия — обновляем сразу.
  document.addEventListener('visibilitychange', function () {
    // Вернулись из настроек браузера — разрешение могло поменяться.
    if (document.visibilityState === 'visible') {
      renderNotifyControl();
      renderNotifyDiagnostics();
    }

    if (document.visibilityState === 'visible' && refreshDue()) refreshAll();
  });
}

/**
 * Регистрация service worker: он кэширует оболочку приложения, чтобы дашборд
 * открывался без сети. Работает только по http(s), с file:// молча пропускаем.
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;

  try {
    navigator.serviceWorker.register('sw.js').catch(function (err) {
      // Офлайн-режим необязателен: без него дашборд работает как обычная страница.
      console.warn('Service worker не зарегистрирован:', err.message);
    });
  } catch (e) { /* см. выше */ }
}

document.addEventListener('DOMContentLoaded', init);
window.addEventListener('load', registerServiceWorker);
