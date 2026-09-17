/* Дашборд северного сияния — Мурманск.
   Чистый JS, без зависимостей. Все запросы — публичные API с CORS. */
'use strict';

/* ------------------------------------------------------------------ */
/*  Настройки                                                          */
/* ------------------------------------------------------------------ */

/*
 * Точки наблюдения в Мурманской области.
 *
 * Координаты проверены по открытому геокодеру Open-Meteo (данные GeoNames).
 *
 * geoLat — геомагнитная широта в дипольном приближении IGRF (эпоха ~2025,
 * северный геомагнитный полюс 80.7° с. ш., 72.7° з. д.):
 *
 *   sin(φm) = sin(φ)·sin(φp) + cos(φ)·cos(φp)·cos(λ − λp)
 *
 * Это не строгая скорректированная геомагнитная широта (CGM), которой
 * пользуются в авроральной науке: в этом регионе расхождение до полуградуса,
 * то есть до четверти единицы Kp — меньше шага самих данных NOAA.
 *
 * Заметная деталь: Териберка географически севернее Мурманска, а геомагнитно
 * чуть южнее — геомагнитная сетка наклонена, и Териберка лежит восточнее.
 * Её преимущество перед городом не в широте, а в отсутствии засветки.
 *
 * light — уровень засветки, в расчёт не входит: только пояснение к вердикту.
 */
var POINTS = [
  { id: 'murmansk',    name: 'Мурманск',   lat: 68.9678, lon: 33.0992, geoLat: 64.87, light: 'high' },
  { id: 'teriberka',   name: 'Териберка',  lat: 69.1609, lon: 35.1453, geoLat: 64.78, light: 'minimal' },
  { id: 'monchegorsk', name: 'Мончегорск', lat: 67.9397, lon: 32.8739, geoLat: 63.94, light: 'medium' },
  { id: 'lovozero',    name: 'Ловозеро',   lat: 68.0056, lon: 35.0187, geoLat: 63.72, light: 'low' },
  { id: 'kirovsk',     name: 'Кировск',    lat: 67.6148, lon: 33.6727, geoLat: 63.53, light: 'medium' },
  { id: 'apatity',     name: 'Апатиты',    lat: 67.5827, lon: 33.4134, geoLat: 63.53, light: 'medium' },
  { id: 'kandalaksha', name: 'Кандалакша', lat: 67.1512, lon: 32.4128, geoLat: 63.26, light: 'medium' }
];

var LIGHT_POLLUTION = {
  high:    { label: 'сильная',    hint: 'Городская засветка сильная: за городом, в 15–20 км от огней, слабое сияние видно заметно лучше.' },
  medium:  { label: 'заметная',   hint: 'Засветка заметная — стоит отъехать на несколько километров от освещённых улиц.' },
  low:     { label: 'слабая',     hint: 'Засветка слабая — достаточно отойти от фонарей.' },
  minimal: { label: 'минимальная', hint: 'Засветки практически нет — условия для наблюдения идеальные.' }
};

/* Точка, под которую подобраны пороги баллов за Kp: от неё считается сдвиг. */
var REFERENCE_POINT_ID = 'murmansk';

var CONFIG = {
  tz: 'Europe/Moscow',
  timeoutMs: 12000,        // таймаут одного запроса
  retries: 1,              // одна автоматическая повторная попытка
  refreshMs: 5 * 60 * 1000, // автообновление раз в 5 минут

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
  weatherModel: 'icon_eu'
};

/** Человекочитаемые названия моделей для подписи в карточке. */
var WEATHER_MODEL_LABELS = {
  best_match:           'автовыбор Open-Meteo',
  icon_eu:              'ICON-EU · DWD, сетка 7 км',
  icon_seamless:        'ICON · DWD',
  icon_global:          'ICON Global · DWD, 13 км',
  metno_seamless:       'MET Nordic · MET Norway',
  ecmwf_ifs025:         'IFS 0,25° · ECMWF',
  gfs_seamless:         'GFS · NOAA',
  ukmo_seamless:        'UKMO · Met Office',
  meteofrance_seamless: 'ARPEGE/AROME · Météo-France'
};

function weatherModelLabel() {
  return WEATHER_MODEL_LABELS[CONFIG.weatherModel] || CONFIG.weatherModel;
}

/*
 * Порог противоречивости: если оценка по ярусам и суммарная облачность
 * расходятся сильнее, доверять данным нельзя — показываем предупреждение
 * и не ставим высокий балл за облачность.
 */
var CLOUD_CONFLICT_LIMIT = 30;

var URLS = {
  kpNow:      'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json',
  kpNowAlt:   'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json',
  kpForecast: 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json'
};

/** Адрес погоды для выбранной точки. */
function weatherUrl(point) {
  return 'https://api.open-meteo.com/v1/forecast'
    + '?latitude=' + point.lat + '&longitude=' + point.lon
    + '&current=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,temperature_2m'
    + '&hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high'
    + '&models=' + CONFIG.weatherModel
    + '&forecast_days=2&timezone=UTC';
}

/**
 * Веса ярусов облачности. Сияние светится на высоте 100–300 км, выше любых
 * облаков, поэтому важна только прозрачность слоя:
 *   нижний  — водяной, оптически плотный, за stratus не видно ничего;
 *   средний — тоже в основном непрозрачен, но altocumulus чаще рваный;
 *   верхний — ледяные кристаллы, перистые облака сияние просвечивает,
 *             теряя контраст, но не скрывая полностью.
 */
var CLOUD_LAYERS = [
  { key: 'low',  field: 'cloud_cover_low',  label: 'Нижний',  weight: 1.0 },
  { key: 'mid',  field: 'cloud_cover_mid',  label: 'Средний', weight: 0.8 },
  { key: 'high', field: 'cloud_cover_high', label: 'Верхний', weight: 0.35 }
];

// Текущее состояние: null — данных нет (ошибка или ещё не загрузились).
var state = { point: null, kp: null, cloud: null, forecast: null, lastOk: null };

/* ------------------------------------------------------------------ */
/*  Точка наблюдения                                                   */
/* ------------------------------------------------------------------ */

function findPoint(id) {
  for (var i = 0; i < POINTS.length; i++) {
    if (POINTS[i].id === id) return POINTS[i];
  }
  return POINTS[0];
}

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
  if (str instanceof Date) return isNaN(str.getTime()) ? null : str;
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

/** Возраст данных словами: «12 минут назад», «1 час 5 минут назад». */
function fmtAge(ms) {
  var mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 1) return 'меньше минуты назад';
  if (mins < 60) return mins + ' ' + plural(mins, 'минуту', 'минуты', 'минут') + ' назад';

  var hours = Math.floor(mins / 60);
  var rest = mins % 60;
  var out = hours + ' ' + plural(hours, 'час', 'часа', 'часов');
  if (rest) out += ' ' + rest + ' ' + plural(rest, 'минуту', 'минуты', 'минут');
  return out + ' назад';
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

/**
 * Переключает карточку между «свежо» и «данные из кэша».
 * ageMs === null — данные живые.
 */
function applyFreshness(cardId, staleId, ageMs, lead) {
  if (ageMs === null || ageMs === undefined) {
    setState(cardId, 'ok');
    return;
  }

  var note = $(staleId);
  if (note) {
    var text = note.querySelector('.stale__text');
    if (text) text.textContent = (lead || 'Нет связи. Данные') + ' ' + fmtAge(ageMs);
  }
  setState(cardId, 'stale');
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

/**
 * Пороги баллов за Kp для точки наблюдения.
 *
 * Экваториальная граница аврорального овала опускается примерно на 2°
 * геомагнитной широты на каждую единицу Kp, то есть овал оказывается над
 * головой при Kp ≈ (67° − φm) / 2. Для Мурманска это ≈ 1,1, и пороги 1/2/3,
 * подобранные под него, уже это отражают. Поэтому шкала не считается заново,
 * а якорится на Мурманск и сдвигается для остальных точек:
 *
 *   сдвиг = (φm Мурманска − φm точки) / 2
 *
 * Кандалакше, например, нужно почти на целую единицу Kp больше, чем
 * Мурманску, — это соответствует 200 км разницы по меридиану.
 */
function kpThresholds(point) {
  var reference = findPoint(REFERENCE_POINT_ID);
  var shift = (reference.geoLat - point.geoLat) / 2;
  return { low: 1 + shift, mid: 2 + shift, high: 3 + shift };
}

/** Балл за Kp (0..3) для выбранной точки. */
function kpScore(kp, point) {
  var t = kpThresholds(point || currentPoint());
  if (kp >= t.high) return 3;
  if (kp >= t.mid) return 2;
  if (kp >= t.low) return 1;
  return 0;
}

function kpText(kp, point) {
  point = point || currentPoint();
  var score = kpScore(kp, point);
  var t = kpThresholds(point);

  if (score === 3) {
    return kp >= t.high + 2
      ? 'Магнитная буря — сияние вероятно и южнее'
      : 'Повышенная активность — овал сияния над точкой';
  }
  if (score === 2) return 'Умеренная активность — сияние возможно на севере неба';
  if (score === 1) return 'Слабая активность — шанс на бледную дугу у горизонта';
  return 'Магнитное поле спокойно';
}

function kpTone(kp, point) {
  var score = kpScore(kp, point);
  if (score === 3) return TONE.ok;
  if (score >= 1) return TONE.mid;
  return TONE.bad;
}

/**
 * Балл за облачность (0..3). При противоречивых данных высокий балл не
 * ставим: ярусы могут говорить о чистом небе, а суммарный показатель той же
 * модели — о сплошной облачности, и какой из них верен, мы не знаем.
 */
function cloudScore(pct, conflict) {
  var score;
  if (pct <= 25) score = 3;
  else if (pct <= 50) score = 2;
  else if (pct <= 75) score = 1;
  else score = 0;

  return conflict ? Math.min(2, score) : score;
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
  var ks = kp !== null ? kpScore(kp.value, currentPoint()) : null;
  var cs = cloud !== null ? cloudScore(cloud.value, cloud.conflict) : null;

  if (ks === null && cs === null) return null; // считать не из чего

  var partial = (ks === null || cs === null);
  var factors = [];

  factors.push(ks !== null ? 'Kp ' + fmtKp(kp.value) : 'Kp: данных нет');
  factors.push(cs !== null ? 'Облачность ' + cloud.value + '%' : 'Облачность: данных нет');
  if (cloud && cloud.conflict) factors.push('Данные об облачности противоречивы');

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
  var point = currentPoint();
  var alt = solarAltitude(new Date(), point.lat, point.lon);
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
    hint = 'Хорошие условия: активность есть, небо достаточно чистое. Смотрите на север.';
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

  // Засветка в расчёт не входит — только пояснение. Упоминаем её, когда
  // небо в принципе стоит смотреть: при полярном дне или сплошных облаках
  // совет отъехать от фонарей бесполезен.
  var light = LIGHT_POLLUTION[point.light];
  factors.push('Засветка: ' + light.label);
  if (light && !tooLight && level !== 'low') hint += ' ' + light.hint;

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
      kp.stale = null;
      state.kp = kp;
      cacheSave('kp', { value: kp.value, time: kp.time });
      renderKp(kp);
      return kp;
    })
    .catch(function (err) {
      var cached = cacheLoad('kp');

      if (cached) {
        var kp = {
          value: cached.payload.value,
          time: toDate(cached.payload.time),
          stale: cached.age
        };
        state.kp = kp;
        renderKp(kp);
        return kp;
      }

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

  applyFreshness('kp-card', 'kp-stale', kp.stale);
}

/* ------------------------------------------------------------------ */
/*  Облачность                                                         */
/* ------------------------------------------------------------------ */

/** Число из ответа API или null. */
function num(value) {
  if (value === undefined || value === null) return null;
  var parsed = parseFloat(value);
  return isFinite(parsed) ? parsed : null;
}

/**
 * Эффективная облачность — доля неба, сквозь которую сияние не пробьётся.
 *
 * Модель случайного перекрытия ярусов: каждый ярус перекрывает направление
 * с вероятностью «покрытие × вес», прозрачность неба — произведение
 * прозрачностей ярусов:
 *
 *   итог = 1 − (1 − low) · (1 − 0,8·mid) · (1 − 0,35·high)
 *
 * Простое сложение процентов дважды считает перекрытие: оно эквивалентно
 * допущению, что ярусы расходятся и закрывают максимум неба, а реальная
 * многоярусная облачность обычно фронтальная и вертикально скоррелированная.
 * На сплошных ярусах обе формулы совпадают, но в смешанном небе сумма
 * упиралась в потолок 100 % на 57 % пространства значений и теряла
 * различающую способность там, где она как раз нужна.
 *
 * Произведение при весах ≤ 1 само не выходит за 100 %, поэтому ограничение
 * сверху больше не требуется.
 *
 * Если API не отдал ярусы, возвращаем null, и вызывающий код берёт общий
 * показатель облачности.
 */
function effectiveCloud(layers) {
  var clear = 1; // доля неба, через которую сияние ещё видно
  var known = 0;

  CLOUD_LAYERS.forEach(function (layer) {
    var value = layers[layer.key];
    if (value === null) return;
    clear *= 1 - layer.weight * value / 100;
    known++;
  });

  if (!known) return null;
  return Math.round(100 * (1 - clear));
}

/** Ярусы облачности из объекта current или строки hourly. */
function readLayers(source, index) {
  var layers = {};
  CLOUD_LAYERS.forEach(function (layer) {
    var raw = source[layer.field];
    layers[layer.key] = num(index === undefined ? raw : (raw ? raw[index] : null));
  });
  return layers;
}

function loadCloud() {
  setState('cloud-card', 'loading');

  var point = currentPoint();

  return fetchJson(weatherUrl(point))
    .then(function (data) {
      var cur = data && data.current;
      var total = cur ? num(cur.cloud_cover) : null;
      var layers = cur ? readLayers(cur) : {};
      var effective = cur ? effectiveCloud(layers) : null;

      // Без ярусов оценка всё равно возможна — по общей облачности.
      if (effective === null && total === null) {
        throw new Error('в ответе нет облачности');
      }

      // Оценка по ярусам и суммарное поле модели должны быть согласованы.
      // Сильное расхождение означает, что одно из полей врёт, а какое —
      // неизвестно, поэтому данным доверяем лишь частично.
      var conflict = (effective !== null && total !== null)
        && Math.abs(effective - total) > CLOUD_CONFLICT_LIMIT;

      var cloud = {
        value: effective !== null ? effective : total,
        byLayers: effective !== null,
        conflict: conflict,
        total: total,
        layers: layers,
        temp: num(cur.temperature_2m) === null ? null : Math.round(num(cur.temperature_2m)),
        time: parseUtc(cur.time),
        soon: pickCloudIn(data, 3),
        hours: readHourlyCloud(data),
        stale: null
      };
      state.cloud = cloud;
      cacheSave(cloudCacheKey(point), cloud);
      renderCloud(cloud);
      return cloud;
    })
    .catch(function (err) {
      var cached = cacheLoad(cloudCacheKey(point));

      if (cached) {
        var cloud = cached.payload;
        cloud.time = toDate(cloud.time);
        cloud.stale = cached.age;

        // Прогноз «через 3 часа» мог уже стать прошлым — тогда не показываем его.
        if (cloud.soon) {
          cloud.soon.time = toDate(cloud.soon.time);
          if (!cloud.soon.time || cloud.soon.time.getTime() < Date.now()) cloud.soon = null;
        }

        state.cloud = cloud;
        renderCloud(cloud);
        return cloud;
      }

      state.cloud = null;
      $('cloud-error').textContent = 'Open-Meteo недоступен: ' + err.message + '.';
      setState('cloud-card', 'error');
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
    warn.textContent = 'Данные об облачности противоречивы: по ярусам ' + cloud.value +
      '%, а суммарный показатель той же модели — ' + Math.round(cloud.total) +
      '%. Такое расхождение физически невозможно, поэтому высокий балл за облачность не ставится.';
  }

  var parts = [];
  if (cloud.temp !== null) parts.push((cloud.temp > 0 ? '+' : '') + cloud.temp + ' °C');
  if (cloud.soon) parts.push('к ' + fmtTime(cloud.soon.time) + ' — ' + cloud.soon.value + '%');
  if (cloud.time) parts.push('данные на ' + fmtTime(cloud.time));
  $('cloud-meta').textContent = parts.join(' · ');

  applyFreshness('cloud-card', 'cloud-stale', cloud.stale);
}

/** Полоски по ярусам и пояснение к весам. */
function renderCloudLayers(cloud) {
  var box = $('cloud-layers');
  var note = $('cloud-note');

  if (!cloud.byLayers) {
    // Ярусов нет — показываем только общий показатель и говорим об этом прямо.
    box.hidden = true;
    note.textContent = 'Ярусы облачности недоступны — показан суммарный показатель.';
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
    return layer.label.toLowerCase() + ' ×' + weight.replace('.', ',');
  }).join(', ');

  note.textContent = 'Итог — с учётом перекрытия ярусов, веса: ' + weights +
    '. Перистые облака верхнего яруса сияние просвечивает, поэтому их вклад меньше.' +
    (cloud.total !== null ? ' Суммарная облачность по модели — ' + Math.round(cloud.total) + '%.' : '');
}

/* ------------------------------------------------------------------ */
/*  Прогноз Kp на 3 суток                                              */
/* ------------------------------------------------------------------ */

function loadForecast() {
  setState('forecast-card', 'loading');

  return fetchJson(URLS.kpForecast)
    .then(function (data) {
      var source = normalizeRows(data);
      var rows = buildForecastRows(source);

      if (!rows.length) throw new Error('нет актуальных значений');

      // Кэшируем исходные строки, а не готовые ячейки: за время хранения часть
      // трёхчасовок уйдёт в прошлое, и при восстановлении их надо отфильтровать
      // заново — иначе подсветка «сейчас» встанет не на ту ячейку.
      cacheSave('forecast', source);
      state.forecast = rows;
      renderForecast(rows, null);
      return rows;
    })
    .catch(function (err) {
      var cached = cacheLoad('forecast');

      if (cached) {
        var rows = buildForecastRows(cached.payload);
        if (rows.length) {
          state.forecast = rows;
          renderForecast(rows, cached.age);
          return rows;
        }
        cacheDrop('forecast'); // весь сохранённый прогноз уже в прошлом
      }

      $('forecast-error').textContent = 'Прогноз NOAA недоступен: ' + err.message + '.';
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

function renderForecast(rows, ageMs) {
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

  applyFreshness('forecast-card', 'forecast-stale', ageMs === undefined ? null : ageMs);
}

/* ------------------------------------------------------------------ */
/*  Окно наблюдения на ближайшую ночь                                  */
/*                                                                     */
/*  Новых запросов не требует: почасовая облачность и трёхчасовой      */
/*  прогноз Kp уже загружены, высота Солнца считается локально.        */
/* ------------------------------------------------------------------ */

var DARK_USABLE = -6;  // ниже этой высоты Солнца сияние уже различимо
var DARK_FULL = -12;   // полная темнота

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
function hourLevel(kp, cloudPct, alt, conflict) {
  var cs = cloudScore(cloudPct, conflict);
  var level;

  if (kp === null) {
    // Без прогноза Kp судим только по небу и выше среднего не поднимаемся.
    level = cs >= 3 ? 1 : 0;
  } else {
    var product = kpScore(kp, currentPoint()) * cs;
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
function computeNightWindow(cloud, kpRows, kpNow) {
  if (!cloud || !cloud.hours || !cloud.hours.length) return null;

  var point = currentPoint();
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
    h.level = hourLevel(h.kp === undefined ? null : h.kp, h.cloud, h.alt, cloud.conflict);
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
    valueEl.textContent = 'Темноты не будет';
    hintEl.textContent = 'В ближайшие двое суток Солнце не опускается достаточно низко — ' +
      'полярный день. Сияние не увидеть при любой магнитной активности.';
    metaEl.textContent = '';
    applyFreshness('window-card', 'window-stale', state.cloud.stale, 'Расчёт по сохранённым данным:');
    return;
  }

  var tone = win.level === 2 ? TONE.ok : (win.level === 1 ? TONE.mid : TONE.bad);
  setTone($('window-card'), tone);
  setTone(valueEl, tone);

  valueEl.textContent = fmtTime(win.from) + ' — ' + fmtTime(win.to);

  var quality = win.level === 2 ? 'высокий шанс'
    : (win.level === 1 ? 'средний шанс' : 'лучшее из возможного, но условия плохие');

  var cloudText = win.cloudMin === win.cloudMax
    ? 'облачность ' + win.cloudMin + '%'
    : 'облачность ' + win.cloudMin + '–' + win.cloudMax + '%';

  var parts = [quality, cloudText];
  if (win.kpMax !== null) parts.push('Kp до ' + fmtKp(win.kpMax));
  parts.push(win.fullDark ? 'полная темнота' : 'неполная темнота');

  hintEl.textContent = parts.join(' · ') + '.';

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
    kp.textContent = (h.kp === null || h.kp === undefined) ? '—' : 'Kp ' + fmtKp(h.kp);

    cell.appendChild(time);
    cell.appendChild(cloud);
    cell.appendChild(kp);
    list.appendChild(cell);
  });

  var meta = 'Ночь с ' + fmtTime(win.night[0].time) + ' до ' +
    fmtTime(new Date(win.night[win.night.length - 1].time.getTime() + 3600000)) +
    '. В ячейках — облачность и прогнозное Kp на каждый час.';
  if (win.noKp) meta += ' Прогноз Kp недоступен, учтены только облачность и темнота.';
  metaEl.textContent = meta;

  applyFreshness('window-card', 'window-stale', state.cloud.stale, 'Расчёт по сохранённым данным:');
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

  // Вердикт устарел настолько, насколько устарел самый старый из его входов.
  var ages = [state.kp, state.cloud]
    .filter(function (item) { return item && item.stale; })
    .map(function (item) { return item.stale; });

  applyFreshness('verdict-card', 'verdict-stale',
    ages.length ? Math.max.apply(null, ages) : null,
    'Оценка по сохранённым данным:');
}

/* ------------------------------------------------------------------ */
/*  Оркестрация                                                        */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Селектор точки                                                     */
/* ------------------------------------------------------------------ */

function fmtCoord(value, positive, negative) {
  return Math.abs(value).toFixed(2).replace('.', ',') + '° ' + (value >= 0 ? positive : negative);
}

/** Подпись под заголовком и название вкладки. */
function renderPointMeta() {
  var point = currentPoint();
  var t = kpThresholds(point);

  $('point-meta').textContent =
    fmtCoord(point.lat, 'с. ш.', 'ю. ш.') + ', ' + fmtCoord(point.lon, 'в. д.', 'з. д.') +
    ' · геомагнитная широта ' + point.geoLat.toFixed(1).replace('.', ',') + '°' +
    ' · сияние заметно от Kp ' + fmtKp(t.low);

  document.title = 'Северное сияние — ' + point.name;
}

function initPointSelect() {
  var select = $('point');

  POINTS.forEach(function (point) {
    var option = document.createElement('option');
    option.value = point.id;
    option.textContent = point.name;
    select.appendChild(option);
  });

  state.point = findPoint(savedPointId() || POINTS[0].id);
  select.value = state.point.id;
  renderPointMeta();

  select.addEventListener('change', function () {
    state.point = findPoint(select.value);
    savePointId(state.point.id);
    renderPointMeta();

    // Облачность принадлежала прежней точке — её нельзя показывать для новой.
    state.cloud = null;
    setState('cloud-card', 'loading');
    setState('window-card', 'loading');

    refreshAll();
  });
}

/** Всё, что считается из уже загруженных данных. */
function renderDerived() {
  renderVerdict();
  renderWindow();
}

function refreshAll() {
  var btn = $('refresh');
  btn.disabled = true;
  $('updated').textContent = 'Обновляем…';
  setState('verdict-card', 'loading');
  setState('window-card', 'loading');

  return Promise.all([loadKp(), loadCloud(), loadForecast()])
    .then(function () {
      renderDerived();

      // Свежесть определяется флагом stale, а не наличием данных: после отката
      // на кэш в state лежат значения, но «Обновлено» писать про них нельзя.
      var fresh = (state.kp && !state.kp.stale) || (state.cloud && !state.cloud.stale);

      if (fresh) {
        state.lastOk = new Date();
        $('updated').textContent = 'Обновлено в ' + fmtTime(state.lastOk);
      } else if (state.kp || state.cloud) {
        $('updated').textContent = 'Нет связи · показаны сохранённые данные';
      } else {
        $('updated').textContent = state.lastOk
          ? 'Нет связи · последние данные в ' + fmtTime(state.lastOk)
          : 'Нет связи с сервисами данных';
      }
    })
    .finally(function () { btn.disabled = false; });
}

function init() {
  // До появления выбора точки облачность лежала в общем ключе. У тех, кто
  // заходил раньше, он остался мусором — убираем при первом же запуске.
  cacheDrop('cloud');

  initPointSelect();
  $('cloud-model').textContent = 'Модель прогноза: ' + weatherModelLabel();
  $('refresh').addEventListener('click', refreshAll);

  // Кнопки «Повторить» внутри карточек перезагружают только свой блок.
  document.addEventListener('click', function (e) {
    var target = e.target.closest ? e.target.closest('[data-retry]') : null;
    if (!target) return;
    var what = target.getAttribute('data-retry');
    if (what === 'kp')       loadKp().then(renderDerived);
    if (what === 'cloud')    loadCloud().then(renderDerived);
    if (what === 'forecast') loadForecast().then(renderDerived);
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
