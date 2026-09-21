/* Расчётное ядро дашборда северного сияния.
 *
 * Общий код сайта и сервера уведомлений (worker/): по нему решается, высокий
 * ли шанс увидеть сияние. Вынесен в отдельный файл, чтобы сайт и уведомление
 * не могли разойтись: иначе push сообщил бы «высокий», а на сайте оказался бы
 * «средний».
 *
 * Файл не зависит от DOM и подключается двумя способами:
 *   • в браузере — обычным <script>, все имена становятся глобальными;
 *   • в worker — импортом ради побочного эффекта, результат лежит в
 *     globalThis.AuroraCore.
 */
'use strict';

/* ------------------------------------------------------------------ */
/*  Данные                                                             */
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
 *
 * km и drive — приблизительное расстояние по автодорогам от Мурманска и время
 * в пути летом. Маршрутный API намеренно не подключён: значения меняются редко,
 * а зависимость от ещё одного сервиса стоила бы дороже точности.
 */
var POINTS = [
  { id: 'murmansk',    name: 'Мурманск',   lat: 68.9678, lon: 33.0992, geoLat: 64.87, light: 'high',    km: 0,   drive: null,   note: '' },
  { id: 'teriberka',   name: 'Териберка',  lat: 69.1609, lon: 35.1453, geoLat: 64.78, light: 'minimal', km: 120, drive: '2,5 ч', note: 'последний участок грунтовый' },
  { id: 'monchegorsk', name: 'Мончегорск', lat: 67.9397, lon: 32.8739, geoLat: 63.94, light: 'medium',  km: 110, drive: '1,5 ч', note: '' },
  { id: 'lovozero',    name: 'Ловозеро',   lat: 68.0056, lon: 35.0187, geoLat: 63.72, light: 'low',     km: 175, drive: '2,5 ч', note: '' },
  { id: 'kirovsk',     name: 'Кировск',    lat: 67.6148, lon: 33.6727, geoLat: 63.53, light: 'medium',  km: 205, drive: '3 ч',   note: '' },
  { id: 'apatity',     name: 'Апатиты',    lat: 67.5827, lon: 33.4134, geoLat: 63.53, light: 'medium',  km: 185, drive: '2,5 ч', note: '' },
  { id: 'kandalaksha', name: 'Кандалакша', lat: 67.1512, lon: 32.4128, geoLat: 63.26, light: 'medium',  km: 280, drive: '4 ч',   note: '' }
];

var LIGHT_POLLUTION = {
  high:    { label: 'сильная',    hint: 'Городская засветка сильная: за городом, в 15–20 км от огней, слабое сияние видно заметно лучше.' },
  medium:  { label: 'заметная',   hint: 'Засветка заметная — стоит отъехать на несколько километров от освещённых улиц.' },
  low:     { label: 'слабая',     hint: 'Засветка слабая — достаточно отойти от фонарей.' },
  minimal: { label: 'минимальная', hint: 'Засветки практически нет — условия для наблюдения идеальные.' }
};

/* Точка, под которую подобраны пороги баллов за Kp: от неё считается сдвиг. */
var REFERENCE_POINT_ID = 'murmansk';

/*
 * Порог противоречивости: если оценка по ярусам и суммарная облачность
 * расходятся сильнее, доверять данным нельзя — показываем предупреждение
 * и не ставим высокий балл за облачность.
 */
var CLOUD_CONFLICT_LIMIT = 30;

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

var DARK_USABLE = -6;  // ниже этой высоты Солнца сияние уже различимо
var DARK_FULL = -12;   // полная темнота

/**
 * Модель Open-Meteo: и сайт, и сервер уведомлений должны запрашивать одну и ту
 * же, иначе они видели бы разную облачность. Почему выбрана именно она и чем
 * плох автовыбор best_match — в комментарии к CONFIG в app.js и в README.
 */
var WEATHER_MODEL = 'icon_eu';

/* ------------------------------------------------------------------ */
/*  Расчёт                                                             */
/* ------------------------------------------------------------------ */

function findPoint(id) {
  for (var i = 0; i < POINTS.length; i++) {
    if (POINTS[i].id === id) return POINTS[i];
  }
  return POINTS[0];
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

/* ------------------------------------------------------------------ */
/*  Уровень вердикта                                                   */
/* ------------------------------------------------------------------ */

/** Балл за Kp (0..3) для точки наблюдения. */
function kpScoreAt(kp, point) {
  var t = kpThresholds(point);
  if (kp >= t.high) return 3;
  if (kp >= t.mid) return 2;
  if (kp >= t.low) return 1;
  return 0;
}

/**
 * Уровень вердикта: 'high' | 'mid' | 'low'.
 *
 * ks и cs — баллы за Kp и облачность (0..3) либо null, если данных нет. Если
 * известен только один фактор, считаем по нему и выше среднего не поднимаемся.
 * alt — высота Солнца: при светлом небе сияние не различить ни при каком Kp,
 * а в неполной темноте высокий уровень не ставим.
 */
function verdictLevel(ks, cs, alt) {
  var level;

  if (ks === null || cs === null) {
    var only = (ks !== null) ? ks : cs;
    level = only >= 1 ? 'mid' : 'low';
  } else {
    var product = ks * cs; // 0..9
    level = product >= 6 ? 'high' : (product >= 2 ? 'mid' : 'low');
  }

  if (alt > DARK_USABLE) level = 'low';
  else if (alt > DARK_FULL && level === 'high') level = 'mid';

  return level;
}

/**
 * Уровень для сервера уведомлений: те же баллы и те же правила, что у
 * computeVerdict на сайте, но без текстов и без обращения к DOM.
 *
 *   kpValue — текущее Kp или null;
 *   cloud   — { value, conflict } из cloudFromCurrent или null;
 *   date    — момент, для которого считаем высоту Солнца.
 *
 * Возвращает null, если не из чего считать, иначе { level, ks, cs, alt }.
 */
function quickLevel(kpValue, cloud, point, date) {
  var ks = kpValue !== null ? kpScoreAt(kpValue, point) : null;
  var cs = cloud ? cloudScore(cloud.value, cloud.conflict) : null;
  if (ks === null && cs === null) return null;

  var alt = solarAltitude(date, point.lat, point.lon);
  return { level: verdictLevel(ks, cs, alt), ks: ks, cs: cs, alt: alt };
}

/**
 * Облачность из объекта current ответа Open-Meteo.
 *
 * Итог считается по ярусам; суммарное поле модели служит перекрёстной
 * проверкой — сильное расхождение означает, что одно из полей врёт, а какое —
 * неизвестно, поэтому данным доверяем лишь частично (conflict).
 * Возвращает null, если в ответе нет ни ярусов, ни общей облачности.
 */
function cloudFromCurrent(cur) {
  var total = cur ? num(cur.cloud_cover) : null;
  var layers = cur ? readLayers(cur) : {};
  var effective = cur ? effectiveCloud(layers) : null;

  if (effective === null && total === null) return null;

  var conflict = (effective !== null && total !== null)
    && Math.abs(effective - total) > CLOUD_CONFLICT_LIMIT;

  return {
    value: effective !== null ? effective : total,
    byLayers: effective !== null,
    conflict: conflict,
    total: total,
    layers: layers
  };
}

/* ------------------------------------------------------------------ */
/*  Луна: фаза, высота, восход и заход                                 */
/*                                                                     */
/*  Полная Луна над горизонтом заметно глушит слабое сияние: небо      */
/*  светлеет, и контраст падает. Считается локально, как высота        */
/*  Солнца, без запросов. В уровень вердикта Луна не входит (как и     */
/*  засветка): это фактор и пояснение, а не прогноз.                   */
/*                                                                     */
/*  Положение Луны — усечённая теория Ж. Меёса («Астрономические       */
/*  алгоритмы», гл. 47): 37 главных членов по долготе, 28 по широте.   */
/*  Точность порядка 0,03°, то есть минуты во времени фаз и восходов.  */
/*  Проверено по данным Морской обсерватории США (tools/moon.test.mjs). */
/* ------------------------------------------------------------------ */

/**
 * Высота центра диска, на которой считается восход и заход: верхний край
 * касается горизонта с поправкой на рефракцию (34') и полудиаметр диска (~15').
 */
var MOON_HORIZON = -0.83;

// Периодические члены долготы: [D, M, M', F, коэффициент в 1e-6 градуса]
var MOON_LON_TERMS = [
  [0, 0, 1, 0, 6288774], [2, 0, -1, 0, 1274027], [2, 0, 0, 0, 658314], [0, 0, 2, 0, 213618],
  [0, 1, 0, 0, -185116], [0, 0, 0, 2, -114332], [2, 0, -2, 0, 58793], [2, -1, -1, 0, 57066],
  [2, 0, 1, 0, 53322], [2, -1, 0, 0, 45758], [0, 1, -1, 0, -40923], [1, 0, 0, 0, -34720],
  [0, 1, 1, 0, -30383], [2, 0, 0, -2, 15327], [0, 0, 1, 2, -12528], [0, 0, 1, -2, 10980],
  [4, 0, -1, 0, 10675], [0, 0, 3, 0, 10034], [4, 0, -2, 0, 8548], [2, 1, -1, 0, -7888],
  [2, 1, 0, 0, -6766], [1, 0, -1, 0, -5163], [1, 1, 0, 0, 4987], [2, -1, 1, 0, 4036],
  [2, 0, 2, 0, 3994], [4, 0, 0, 0, 3861], [2, 0, -3, 0, 3665], [0, 1, -2, 0, -2689],
  [2, 0, -1, 2, -2602], [2, -1, -2, 0, 2390], [1, 0, 1, 0, -2348], [2, -2, 0, 0, 2236],
  [0, 1, 2, 0, -2120], [0, 2, 0, 0, -2069], [2, -2, -1, 0, 2048], [2, 0, 1, -2, -1773],
  [2, 0, 0, 2, -1595]
];

// Периодические члены широты: [D, M, M', F, коэффициент в 1e-6 градуса]
var MOON_LAT_TERMS = [
  [0, 0, 0, 1, 5128122], [0, 0, 1, 1, 280602], [0, 0, 1, -1, 277693], [2, 0, 0, -1, 173237],
  [2, 0, -1, 1, 55413], [2, 0, -1, -1, 46271], [2, 0, 0, 1, 32573], [0, 0, 2, 1, 17198],
  [2, 0, 1, -1, 9266], [0, 0, 2, -1, 8822], [2, -1, 0, -1, 8216], [2, 0, -2, -1, 4324],
  [2, 0, 1, 1, 4200], [2, 1, 0, -1, -3359], [2, -1, -1, 1, 2463], [2, -1, 0, 1, 2211],
  [2, -1, -1, -1, 2065], [0, 1, -1, -1, -1870], [4, 0, -1, -1, 1828], [0, 1, 0, 1, -1794],
  [0, 0, 0, 3, -1749], [0, 1, -1, 1, -1565], [1, 0, 0, 1, -1491], [0, 1, 1, 1, -1475],
  [0, 1, 1, -1, -1410], [0, 1, 0, -1, -1344], [1, 0, 0, -1, -1335], [0, 0, 3, 1, 1107]
];

/** Юлианских столетий от J2000. */
function moonCenturies(date) {
  return (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 86400000 / 36525;
}

/**
 * Эклиптическое положение Луны: долгота и широта (градусы), расстояние (км).
 * Поправка E учитывает уменьшение эксцентриситета орбиты Земли: члены с
 * множителем M (аномалия Солнца) умножаются на E, с 2M — на E².
 */
function moonPosition(date) {
  var rad = Math.PI / 180;
  var T = moonCenturies(date);

  var Lm = 218.3164477 + 481267.88123421 * T;      // средняя долгота Луны
  var D  = 297.8501921 + 445267.1114034 * T;       // средняя элонгация
  var M  = 357.5291092 + 35999.0502909 * T;        // средняя аномалия Солнца
  var Mm = 134.9633964 + 477198.8675055 * T;       // средняя аномалия Луны
  var F  = 93.2720950 + 483202.0175233 * T;        // аргумент широты
  var E  = 1 - 0.002516 * T;

  function sum(terms, useSin) {
    var total = 0;
    for (var i = 0; i < terms.length; i++) {
      var t = terms[i];
      var arg = (t[0] * D + t[1] * M + t[2] * Mm + t[3] * F) * rad;
      var w = Math.abs(t[1]) === 1 ? E : (Math.abs(t[1]) === 2 ? E * E : 1);
      total += t[4] * w * Math.sin(arg);
    }
    return total;
  }

  var A1 = (119.75 + 131.849 * T) * rad;
  var A2 = (53.09 + 479264.290 * T) * rad;
  var A3 = (313.45 + 481266.484 * T) * rad;

  var sl = sum(MOON_LON_TERMS)
    + 3958 * Math.sin(A1) + 1962 * Math.sin((Lm - F) * rad) + 318 * Math.sin(A2);
  var sb = sum(MOON_LAT_TERMS)
    - 2235 * Math.sin(Lm * rad) + 382 * Math.sin(A3)
    + 175 * Math.sin(A1 - F * rad) + 175 * Math.sin(A1 + F * rad)
    + 127 * Math.sin((Lm - Mm) * rad) - 115 * Math.sin((Lm + Mm) * rad);

  // Расстояние: четыре главных члена дают точность около 0,3 %, а нужно оно только
  // для параллакса (около 57') и фазового угла.
  var r = 385000.56
    + (-20905.355 * Math.cos(Mm * rad)
       - 3699.111 * Math.cos((2 * D - Mm) * rad)
       - 2955.968 * Math.cos(2 * D * rad)
       - 569.925 * Math.cos(2 * Mm * rad));

  return {
    lon: (((Lm + sl / 1e6) % 360) + 360) % 360,
    lat: sb / 1e6,
    distance: r
  };
}

/** Долгота Солнца и его расстояние (км): то же упрощение, что в solarAltitude. */
function sunLongitude(date) {
  var rad = Math.PI / 180;
  var d = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 86400000;
  var g = (357.529 + 0.98560028 * d) * rad;
  var q = 280.459 + 0.98564736 * d;
  return {
    lon: (((q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) % 360) + 360) % 360,
    distance: 149597870.7 * (1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g))
  };
}

/**
 * Освещённая доля диска (0..1) и возраст фазы. Освещённость считается по фазовому
 * углу i из треугольника Земля—Луна—Солнце: k = (1 + cos i) / 2. Луна «растёт»,
 * пока её долгота больше солнечной (elongation от 0 до 180°).
 */
function moonPhase(date) {
  var rad = Math.PI / 180;
  var moon = moonPosition(date);
  var sun = sunLongitude(date);

  var elong = (((moon.lon - sun.lon) % 360) + 360) % 360;          // 0 — новолуние, 180 — полнолуние
  var cosPsi = Math.cos(moon.lat * rad) * Math.cos(elong * rad);   // геоцентрическая элонгация
  var psi = Math.acos(Math.max(-1, Math.min(1, cosPsi)));
  var i = Math.atan2(sun.distance * Math.sin(psi), moon.distance - sun.distance * cosPsi);

  return {
    illumination: (1 + Math.cos(i)) / 2,
    elongation: elong,
    waxing: elong < 180
  };
}

/** Название фазы по элонгации: восемь привычных состояний. */
function moonPhaseName(phase) {
  var e = phase.elongation;
  if (e < 22.5 || e >= 337.5) return 'Новолуние';
  if (e < 67.5)  return 'Молодая Луна';
  if (e < 112.5) return 'Первая четверть';
  if (e < 157.5) return 'Прибывающая Луна';
  if (e < 202.5) return 'Полнолуние';
  if (e < 247.5) return 'Убывающая Луна';
  if (e < 292.5) return 'Последняя четверть';
  return 'Старая Луна';
}

/**
 * Высота центра диска Луны над горизонтом (градусы) для точки на Земле.
 * Учтён суточный параллакс: Луна так близко, что с поверхности Земли она
 * видна ниже, чем из центра, до градуса.
 */
function moonAltitude(date, lat, lon) {
  var rad = Math.PI / 180;
  var T = moonCenturies(date);
  var d = T * 36525;
  var pos = moonPosition(date);
  var eps = (23.439291 - 0.0130042 * T) * rad;
  var lam = pos.lon * rad, bet = pos.lat * rad;

  var ra = Math.atan2(Math.sin(lam) * Math.cos(eps) - Math.tan(bet) * Math.sin(eps), Math.cos(lam));
  var dec = Math.asin(Math.sin(bet) * Math.cos(eps) + Math.cos(bet) * Math.sin(eps) * Math.sin(lam));

  var gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  var lst = (((gmst + 24) % 24) + lon / 15) * 15 * rad;
  var H = lst - ra;

  var alt = Math.asin(
    Math.sin(lat * rad) * Math.sin(dec) +
    Math.cos(lat * rad) * Math.cos(dec) * Math.cos(H)
  );

  var parallax = Math.asin(6378.14 / pos.distance);
  return (alt - parallax * Math.cos(alt)) / rad;
}

/**
 * Восходы и заходы Луны в интервале [from, to] для точки. Высота сканируется с
 * шагом 10 минут, момент пересечения уточняется делением пополам до секунды.
 * Возвращает список { type: 'rise' | 'set', at: Date } по возрастанию времени.
 */
function moonEvents(from, to, lat, lon) {
  var STEP = 10 * 60000;
  var events = [];
  var t = from.getTime();
  var end = to.getTime();
  var prev = moonAltitude(new Date(t), lat, lon) - MOON_HORIZON;

  while (t < end) {
    var next = Math.min(t + STEP, end);
    var cur = moonAltitude(new Date(next), lat, lon) - MOON_HORIZON;

    if ((prev < 0) !== (cur < 0)) {
      var lo = t, hi = next, rising = cur >= 0;
      while (hi - lo > 1000) {
        var mid = (lo + hi) / 2;
        var up = moonAltitude(new Date(mid), lat, lon) - MOON_HORIZON >= 0;
        if (up === rising) hi = mid; else lo = mid;
      }
      events.push({ type: rising ? 'rise' : 'set', at: new Date(Math.round((lo + hi) / 2)) });
    }
    prev = cur;
    t = next;
  }
  return events;
}

/**
 * Насколько Луна мешает наблюдению: none | weak | moderate | strong.
 * Зависит от освещённости и от высоты: низкая Луна светит в основном по горизонту
 * и небо над головой почти не засвечивает, поэтому вклад растёт до 25° высоты.
 */
function moonImpact(illumination, altitude) {
  if (altitude <= MOON_HORIZON) return { level: 'none', effective: 0 };
  var effective = illumination * Math.min(1, Math.max(0, altitude - MOON_HORIZON) / 25);
  var level = effective < 0.1 ? 'none' : (effective < 0.3 ? 'weak' : (effective < 0.55 ? 'moderate' : 'strong'));
  return { level: level, effective: effective };
}

/** Состояние Луны в момент date для точки: фаза, освещённость, высота, помеха. */
function moonInfo(date, lat, lon) {
  var phase = moonPhase(date);
  var altitude = moonAltitude(date, lat, lon);
  var impact = moonImpact(phase.illumination, altitude);
  return {
    illumination: phase.illumination,
    waxing: phase.waxing,
    phase: moonPhaseName(phase),
    altitude: altitude,
    up: altitude > MOON_HORIZON,
    impact: impact.level,
    effective: impact.effective
  };
}

/**
 * Луна за интервал [from, to]: сколько времени над горизонтом, когда взойдёт или
 * зайдёт и какова наибольшая помеха. Для окна наблюдения и для ночи в целом.
 */
function moonSummary(from, to, lat, lon) {
  var STEP = 10 * 60000;
  var start = from.getTime(), end = Math.max(to.getTime(), start);
  var mid = new Date((start + end) / 2);
  var order = { none: 0, weak: 1, moderate: 2, strong: 3 };

  var worst = 'none', worstEffective = 0, up = 0, total = 0;
  for (var t = start; t <= end; t += STEP) {
    var info = moonInfo(new Date(t), lat, lon);
    total++;
    if (info.up) up++;
    if (order[info.impact] > order[worst]) worst = info.impact;
    if (info.effective > worstEffective) worstEffective = info.effective;
    if (end === start) break;
  }

  var events = moonEvents(new Date(start), new Date(end), lat, lon);
  var atMid = moonInfo(mid, lat, lon);
  return {
    illumination: atMid.illumination,
    phase: atMid.phase,
    waxing: atMid.waxing,
    upShare: total ? up / total : 0,
    rise: (events.filter(function (e) { return e.type === 'rise'; })[0] || {}).at || null,
    set: (events.filter(function (e) { return e.type === 'set'; })[0] || {}).at || null,
    impact: worst,
    effective: worstEffective
  };
}

globalThis.AuroraCore = {
  POINTS: POINTS,
  LIGHT_POLLUTION: LIGHT_POLLUTION,
  REFERENCE_POINT_ID: REFERENCE_POINT_ID,
  CLOUD_CONFLICT_LIMIT: CLOUD_CONFLICT_LIMIT,
  CLOUD_LAYERS: CLOUD_LAYERS,
  DARK_USABLE: DARK_USABLE,
  DARK_FULL: DARK_FULL,
  WEATHER_MODEL: WEATHER_MODEL,
  findPoint: findPoint,
  parseUtc: parseUtc,
  solarAltitude: solarAltitude,
  kpThresholds: kpThresholds,
  kpScoreAt: kpScoreAt,
  cloudScore: cloudScore,
  normalizeRows: normalizeRows,
  pickKpValue: pickKpValue,
  readKpSeries: readKpSeries,
  num: num,
  effectiveCloud: effectiveCloud,
  readLayers: readLayers,
  verdictLevel: verdictLevel,
  quickLevel: quickLevel,
  cloudFromCurrent: cloudFromCurrent,
  MOON_HORIZON: MOON_HORIZON,
  moonPosition: moonPosition,
  moonPhase: moonPhase,
  moonPhaseName: moonPhaseName,
  moonAltitude: moonAltitude,
  moonEvents: moonEvents,
  moonImpact: moonImpact,
  moonInfo: moonInfo,
  moonSummary: moonSummary
};
