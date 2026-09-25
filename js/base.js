/* Основа: настройки, точка наблюдения, утилиты, кэш последних удачных ответов.
   Часть приложения: общие переменные и функции — глобальные, порядок подключения задан
   в index.html (см. js/README.md). */
'use strict';

/* ------------------------------------------------------------------ */
/*  Настройки                                                          */
/* ------------------------------------------------------------------ */

/* Версия сайта — та же, что у кэша service worker (sw.js, CACHE_VERSION): видна в подвале. */
var APP_VERSION = 'v43';

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

/** Адрес почасовой облачности сразу для всех точек (и своих мест): один запрос вместо семи. */
function allPointsWeatherUrl() {
  var points = allPoints();
  return 'https://api.open-meteo.com/v1/forecast'
    + '?latitude=' + points.map(function (p) { return p.lat; }).join(',')
    + '&longitude=' + points.map(function (p) { return p.lon; }).join(',')
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
              lastLevel: null, pushBusy: false, pushHealth: null, pushServer: null,
              status: null, errors: {}, settings: null, timer: null, sw: null, ov: null, outlook: null,
              mapPoint: null, nightHour: null, places: null, mapPick: false, reports: null, reportBusy: false, history: null, accuracy: null, meteoViaServer: false,
              cloudGrid: null, cloudGridLoading: null, cloudGridError: false, cloudHour: 0, cloudsOn: undefined, shareLang: null, shareMatrix: null };

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
var OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';

/**
 * Запасной путь к Open-Meteo — через сервер уведомлений (worker/src/meteo.js), с теми же
 * параметрами; null — не Open-Meteo или сервер не настроен.
 */
function meteoFallbackUrl(url) {
  if (typeof pushConfigured !== 'function' || !pushConfigured()) return null;
  url = String(url);
  if (url.indexOf(OPEN_METEO + '?') !== 0) return null;
  return AURORA_CONFIG.pushApi + '/meteo' + url.slice(OPEN_METEO.length);
}

/* Прямой запрос к Open-Meteo ждём недолго и не повторяем: если сеть его не пускает, запрос
   часто не отклоняется, а повисает (так бывает, когда провайдер блокирует адреса хостинга).
   Запасной путь через сервер уведомлений должен начаться за секунды, а не за полминуты. */
var METEO_DIRECT_TIMEOUT_MS = 6000;
var METEO_VIA_SERVER_MS = 24 * 60 * 60 * 1000;   // сколько помнить, что напрямую не проходит

/** Прямой путь к Open-Meteo недавно не работал — сначала сервер. Помнится сутки и между сеансами. */
function meteoViaServer() {
  if (state.meteoViaServer) return true;
  try {
    var at = Number(localStorage.getItem(CACHE.prefix + 'meteoViaServer')) || 0;
    return Date.now() - at < METEO_VIA_SERVER_MS;
  } catch (e) { return false; }
}

function rememberMeteoViaServer() {
  state.meteoViaServer = true;
  try { localStorage.setItem(CACHE.prefix + 'meteoViaServer', String(Date.now())); } catch (e) { /* до конца сеанса */ }
}

/**
 * JSON по адресу. Open-Meteo бывает недоступен именно отсюда: сеть не пускает к нему (запрос
 * отклоняется или повисает), адрес выбрал суточный лимит (ответ 429 без CORS-заголовков, и
 * браузер видит «нет соединения»). Тогда тот же запрос уходит через сервер уведомлений, и сутки
 * запросы к Open-Meteo сначала идут через него — не ждать каждый раз отказа. Если вдруг не
 * отвечает сервер — пробуем напрямую.
 */
/*
 * Данные NOAA — сначала через сервер уведомлений (worker/src/noaa.js): он отдаёт те же файлы в
 * компактном виде (солнечный ветер — 30 КБ вместо 1 МБ, OVATION — 10 КБ вместо 900 КБ) и
 * выручает, если сеть не пускает к NOAA. Прямой запрос к NOAA — запасной путь.
 */
var NOAA_ON_SERVER = {
  'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json': 'kp',
  'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json': 'kp-3h',
  'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json': 'kp-forecast',
  'https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json': 'sw-mag',
  'https://services.swpc.noaa.gov/products/summary/solar-wind-speed.json': 'sw-speed',
  'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json': 'ovation',
  'https://services.swpc.noaa.gov/text/27-day-outlook.txt': 'outlook'
};
var NOAA_SERVER_TIMEOUT_MS = 8000;

function noaaServerUrl(url) {
  if (typeof pushConfigured !== 'function' || !pushConfigured()) return null;
  var key = Object.prototype.hasOwnProperty.call(NOAA_ON_SERVER, url) ? NOAA_ON_SERVER[url] : null;
  return key ? AURORA_CONFIG.pushApi + '/noaa/' + key : null;
}

function fetchJson(url, attempt, as) {
  var noaa = attempt ? null : noaaServerUrl(String(url));
  if (noaa) {
    return fetchJsonDirect(noaa, CONFIG.retries, as, NOAA_SERVER_TIMEOUT_MS).catch(function () {
      return fetchJsonDirect(url, 0, as);   // сервер не ответил — напрямую к NOAA, как раньше
    });
  }

  var viaServer = attempt ? null : meteoFallbackUrl(url);
  if (!viaServer) return fetchJsonDirect(url, attempt, as);

  var direct = function () { return fetchJsonDirect(url, CONFIG.retries, as, METEO_DIRECT_TIMEOUT_MS); };
  var server = function () { return fetchJsonDirect(viaServer, 0, as); };

  if (meteoViaServer()) {
    return server().catch(function (err) {
      return direct().catch(function () { throw err; });
    });
  }
  return direct().catch(function (err) {
    return server().then(function (data) {
      rememberMeteoViaServer();
      return data;
    }, function () { throw err; });   // не помог и сервер — показываем исходную причину
  });
}

/** timeoutMs — своё ожидание вместо CONFIG.timeoutMs; attempt = CONFIG.retries — без повтора. */
function fetchJsonDirect(url, attempt, as, timeoutMs) {
  attempt = attempt || 0;

  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || CONFIG.timeoutMs);

  // cache: 'no-store' — чтобы браузер не отдал вчерашний Kp из кэша
  return fetch(url, { signal: ctrl.signal, cache: 'no-store' })
    .then(function (res) {
      // 429 — источник ограничил запросы с этого адреса: повтор через секунду только усугубит.
      if (res.status === 429) throw appError('rate_limit');
      if (!res.ok) throw appError('http', { status: res.status });
      return as === 'text' ? res.text() : res.json();
    })
    .catch(function (err) {
      if (err && err.code === 'rate_limit') throw err;
      if (attempt < CONFIG.retries) {
        return new Promise(function (resolve) { setTimeout(resolve, 900); })
          .then(function () { return fetchJsonDirect(url, attempt + 1, as); });
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
