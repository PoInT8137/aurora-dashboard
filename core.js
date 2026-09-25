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
 * names — название на каждом языке интерфейса (name — русское, для старых потребителей).
 * km и driveH — приблизительное расстояние по автодорогам от Мурманска и время
 * в пути летом в часах; noteKey — ключ пометки о дороге в словарях (note.*).
 * Маршрутный API намеренно не подключён: значения меняются редко,
 * а зависимость от ещё одного сервиса стоила бы дороже точности.
 */
var POINTS = [
  { id: 'murmansk',    name: 'Мурманск',   names: { ru: 'Мурманск',   en: 'Murmansk',    zh: '摩尔曼斯克' }, lat: 68.9678, lon: 33.0992, geoLat: 64.87, light: 'high',    km: 0,   driveH: null, noteKey: '' },
  { id: 'teriberka',   name: 'Териберка',  names: { ru: 'Териберка',  en: 'Teriberka',   zh: '捷里别尔卡' }, lat: 69.1609, lon: 35.1453, geoLat: 64.78, light: 'minimal', km: 120, driveH: 2.5,  noteKey: 'unpaved' },
  { id: 'monchegorsk', name: 'Мончегорск', names: { ru: 'Мончегорск', en: 'Monchegorsk', zh: '蒙切哥尔斯克' }, lat: 67.9397, lon: 32.8739, geoLat: 63.94, light: 'medium',  km: 110, driveH: 1.5,  noteKey: '' },
  { id: 'lovozero',    name: 'Ловозеро',   names: { ru: 'Ловозеро',   en: 'Lovozero',    zh: '洛沃泽罗' }, lat: 68.0056, lon: 35.0187, geoLat: 63.72, light: 'low',     km: 175, driveH: 2.5,  noteKey: '' },
  { id: 'kirovsk',     name: 'Кировск',    names: { ru: 'Кировск',    en: 'Kirovsk',     zh: '基洛夫斯克' }, lat: 67.6148, lon: 33.6727, geoLat: 63.53, light: 'medium',  km: 205, driveH: 3,    noteKey: '' },
  { id: 'apatity',     name: 'Апатиты',    names: { ru: 'Апатиты',    en: 'Apatity',     zh: '阿帕季特' }, lat: 67.5827, lon: 33.4134, geoLat: 63.53, light: 'medium',  km: 185, driveH: 2.5,  noteKey: '' },
  { id: 'kandalaksha', name: 'Кандалакша', names: { ru: 'Кандалакша', en: 'Kandalaksha', zh: '坎达拉克沙' }, lat: 67.1512, lon: 32.4128, geoLat: 63.26, light: 'medium',  km: 280, driveH: 4,    noteKey: '' }
];

/* Уровни засветки. Подписи и пояснения — в словарях (light.<уровень>.label / .hint). */
var LIGHT_LEVELS = ['high', 'medium', 'low', 'minimal'];

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
  { key: 'low',  field: 'cloud_cover_low',  weight: 1.0 },
  { key: 'mid',  field: 'cloud_cover_mid',  weight: 0.8 },
  { key: 'high', field: 'cloud_cover_high', weight: 0.35 }
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

/* Северный геомагнитный полюс в дипольном приближении IGRF (эпоха ~2025) — тот же, по которому
   посчитаны geoLat точек выше. */
var GEOMAGNETIC_POLE = { lat: 80.7, lon: -72.7 };

/** Геомагнитная широта (дипольное приближение) для любого места: для своих точек наблюдения. */
function geomagneticLatitude(lat, lon) {
  var r = Math.PI / 180;
  var p = GEOMAGNETIC_POLE;
  var s = Math.sin(lat * r) * Math.sin(p.lat * r) + Math.cos(lat * r) * Math.cos(p.lat * r) * Math.cos((lon - p.lon) * r);
  return Math.round(Math.asin(Math.max(-1, Math.min(1, s))) / r * 100) / 100;
}

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
/*  Солнечный ветер: что будет в ближайший час.                        */
/*                                                                     */
/*  Kp описывает прошедшие три часа. Спутники в точке L1 (1,5 млн км к  */
/*  Солнцу) видят солнечный ветер за 30–90 минут до того, как он дойдёт */
/*  до Земли. Главное для сияния — Bz, север-юг магнитного поля ветра:  */
/*  когда он устойчиво направлен на юг (отрицательный), энергия ветра   */
/*  проходит в магнитосферу, и через полчаса-час может начаться         */
/*  суббуря. Уровень вердикта от этого не меняется — это подсказка.    */
/* ------------------------------------------------------------------ */

var L1_DISTANCE_KM = 1500000;
var SW_STALE_MS = 30 * 60 * 1000;      // данные старше получаса — не «сейчас»
var SW_WINDOW_MS = 2 * 60 * 60 * 1000; // ряд для графика и оценки — два часа

/** Средний Bz за последние minutes минут ряда (ряд по возрастанию времени). */
function meanBz(series, minutes) {
  var end = series[series.length - 1].time;
  var sum = 0, n = 0;
  for (var i = series.length - 1; i >= 0 && end - series[i].time < minutes * 60000; i--) {
    sum += series[i].bz;
    n++;
  }
  return n ? sum / n : null;
}

/**
 * Поминутный ряд магнитного поля NOAA RTSW (json/rtsw/rtsw_mag_1m.json) в сводку.
 * В файле сутки данных от нескольких спутников, новые сверху; основной поток помечен active.
 * Возвращает null, если свежих данных нет, иначе
 * { time, bz, bt, level, southMinutes, series: [{ time (мс), bz }] за два часа }.
 * level: strong — Bz в среднем ≤ −10 нТл за 15 минут; south — ≤ −5 за 20 минут;
 * weak — сейчас южный, но слабо или недолго; north — северный.
 */
function solarWindSummary(rows, nowMs) {
  if (!Array.isArray(rows)) return null;

  // Ряды по спутникам: смешивать их нельзя — у каждого свои приборы и своя задержка.
  var groups = {};
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row) continue;
    var time = parseUtc(row.time_tag);
    var bz = num(row.bz_gsm);
    if (!time || bz === null) continue;
    var t = time.getTime();
    if (t > nowMs + 5 * 60000 || nowMs - t > SW_WINDOW_MS) continue;
    var key = String(row.source || 'main');
    var group = groups[key] || (groups[key] = { source: key, active: false, series: [], last: 0 });
    if (row.active !== false) group.active = true;
    group.series.push({ time: t, bz: bz, bt: num(row.bt) });
    if (t > group.last) group.last = t;
  }

  // Основной поток NOAA (active) — если он свежий. Бывает, что основной спутник замолкает, а
  // остальные передают (25.09.2026: SOLAR1 молчал почти час, IMAP и ACE — нет): тогда берём
  // самый свежий из остальных, а не объявляем, что данных нет.
  var chosen = null;
  Object.keys(groups).forEach(function (key) {
    var g = groups[key];
    if (nowMs - g.last > SW_STALE_MS) return;
    if (!chosen || (g.active && !chosen.active) || (g.active === chosen.active && g.last > chosen.last)) chosen = g;
  });
  if (!chosen) return null;

  var series = chosen.series;
  var bt = null;
  series.sort(function (a, b) { return a.time - b.time; });
  var last = series[series.length - 1];

  // Текущее значение — среднее за 5 минут: поминутные отсчёты заметно дрожат.
  var now = meanBz(series, 5);
  for (i = series.length - 1; i >= 0 && bt === null; i--) bt = series[i].bt;

  // Сколько минут подряд Bz южный: от последнего отсчёта назад до первого северного.
  var southSince = null;
  for (i = series.length - 1; i >= 0 && series[i].bz < 0; i--) southSince = series[i].time;
  var southMinutes = southSince === null ? 0 : Math.round((last.time - southSince) / 60000);

  var level;
  var mean15 = meanBz(series, 15), mean20 = meanBz(series, 20);
  if (mean15 <= -10) level = 'strong';
  else if (mean20 <= -5) level = 'south';
  else if (now < 0) level = 'weak';
  else level = 'north';

  return {
    time: new Date(last.time),
    bz: Math.round(now * 10) / 10,
    bt: bt === null ? null : Math.round(bt * 10) / 10,
    level: level,
    southMinutes: southMinutes,
    source: chosen.source,
    fallback: !chosen.active,   // основной спутник молчит — показаны данные запасного
    series: series.map(function (p) { return { time: p.time, bz: p.bz }; })
  };
}

/** Через сколько минут ветер, измеренный в L1, дойдёт до Земли; null без скорости. */
function solarWindLeadMinutes(speedKmS) {
  var v = num(speedKmS);
  if (v === null || v < 150 || v > 3000) return null;   // вне физических значений — не доверяем
  return Math.round(L1_DISTANCE_KM / v / 60);
}

/* ------------------------------------------------------------------ */
/*  NOAA OVATION: вероятность сияния на ближайшие 30–90 минут.         */
/*                                                                     */
/*  Модель считает по солнечному ветру вероятность увидеть сияние       */
/*  прямо над головой на сетке 1°×1°. Сияние светится на высоте         */
/*  100–300 км и видно у северного горизонта за несколько сотен         */
/*  километров, поэтому кроме клетки точки берётся максимум в поле      */
/*  зрения: до OVATION_VIEW_LAT° к северу и ±OVATION_VIEW_LON° по        */
/*  долготе (на 65–70° с. ш. это около 550 × 250 км).                   */
/* ------------------------------------------------------------------ */

var OVATION_VIEW_LAT = 5;
var OVATION_VIEW_LON = 3;
var OVATION_STALE_MS = 90 * 60 * 1000;   // наблюдение старше полутора часов — уже не прогноз

/**
 * Ответ json/ovation_aurora_latest.json → { observed, forecast, points: { id: { overhead, view } } }
 * для переданных точек, либо null (нет данных, чужой формат, данные устарели).
 */
function ovationSummary(data, points, nowMs) {
  if (!data || !Array.isArray(data.coordinates)) return null;

  var observed = parseUtc(data['Observation Time']);
  var forecast = parseUtc(data['Forecast Time']);
  if (!observed || nowMs - observed.getTime() > OVATION_STALE_MS) return null;

  var grid = {};
  var count = 0;
  for (var i = 0; i < data.coordinates.length; i++) {
    var c = data.coordinates[i];
    if (!Array.isArray(c) || c.length < 3) continue;
    var v = num(c[2]);
    if (v === null) continue;
    grid[c[0] + ':' + c[1]] = Math.max(0, Math.min(100, v));
    count++;
  }
  if (!count) return null;

  var cell = function (lon, lat) {
    var value = grid[(((lon % 360) + 360) % 360) + ':' + lat];
    return value === undefined ? null : value;
  };

  var out = {};
  points.forEach(function (point) {
    var lat = Math.round(point.lat), lon = Math.round(point.lon);
    var overhead = cell(lon, lat);
    var view = overhead;
    for (var dLat = 0; dLat <= OVATION_VIEW_LAT; dLat++) {
      for (var dLon = -OVATION_VIEW_LON; dLon <= OVATION_VIEW_LON; dLon++) {
        var value = lat + dLat > 90 ? null : cell(lon + dLon, lat + dLat);
        if (value !== null && (view === null || value > view)) view = value;
      }
    }
    if (overhead !== null) out[point.id] = { overhead: overhead, view: view };
  });

  return { observed: observed, forecast: forecast, points: out };
}

/* ------------------------------------------------------------------ */
/*  Прогноз NOAA на 27 дней — для выбора дат поездки.                  */
/*                                                                     */
/*  Строится по вращению Солнца (оборот ~27 суток): активные области и  */
/*  корональные дыры, давшие бурю, через оборот часто дают её снова.    */
/*  Точность невысокая, облака неизвестны — это ориентир, а не прогноз  */
/*  на конкретную ночь. «Наибольший Kp» — максимум из восьми трёхчасовок */
/*  за сутки UTC.                                                       */
/* ------------------------------------------------------------------ */

var MONTHS_EN = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
var BRIGHT_MOON = 0.7;   // освещённость, при которой Луна заметно мешает слабому сиянию

/**
 * Текст text/27-day-outlook.txt → { issued: Date|null, days: [{ date: 'YYYY-MM-DD', flux, a, kp }] }
 * или null, если строк с данными нет.
 */
function parseOutlook27(text) {
  if (typeof text !== 'string') return null;

  var issued = null;
  var match = /^:Issued:\s*(\d{4}) (\w{3}) (\d{1,2}) (\d{2})(\d{2}) UTC/m.exec(text);
  if (match && MONTHS_EN[match[2]]) {
    issued = new Date(Date.UTC(+match[1], MONTHS_EN[match[2]] - 1, +match[3], +match[4], +match[5]));
  }

  var days = [];
  var rows = /^(\d{4}) (\w{3}) (\d{1,2})\s+(\d+)\s+(\d+)\s+(\d+)\s*$/gm;
  var row;
  while ((row = rows.exec(text))) {
    var month = MONTHS_EN[row[2]];
    var kp = Number(row[6]);
    if (!month || kp > 9) continue;
    var date = new Date(Date.UTC(+row[1], month - 1, +row[3]));
    days.push({ date: date.toISOString().slice(0, 10), flux: Number(row[4]), a: Number(row[5]), kp: kp });
  }
  return days.length ? { issued: issued, days: days } : null;
}

/**
 * Дни прогноза с сегодняшнего (по UTC) для точки: уровень по порогам точки, будет ли ночь
 * тёмной и насколько светит Луна — то и другое в местную полночь (21:00 UTC, UTC+3).
 * level: high — Kp не ниже порога «высокого» для точки, mid — «среднего», low — ниже.
 */
function outlookDays(outlook, point, nowMs) {
  if (!outlook || !outlook.days) return [];
  var today = new Date(nowMs).toISOString().slice(0, 10);

  return outlook.days.filter(function (day) { return day.date >= today; }).map(function (day) {
    var midnight = new Date(day.date + 'T21:00:00Z');
    var score = kpScoreAt(day.kp, point);
    var moon = moonPhase(midnight).illumination;
    return {
      date: day.date,
      kp: day.kp,
      level: score >= 3 ? 'high' : (score === 2 ? 'mid' : 'low'),
      dark: solarAltitude(midnight, point.lat, point.lon) <= DARK_USABLE,
      moon: moon,
      // Яркая Луна глушит слабое сияние, но сильная буря видна и так — как и в вердикте.
      moonOk: moon < BRIGHT_MOON || day.kp >= kpThresholds(point).high + 2
    };
  });
}

/**
 * Лучшие даты: подряд идущие дни с высоким уровнем, тёмной ночью и без яркой Луны
 * (или с бурей настолько сильной, что Луна ей не помеха).
 * Сильнее отрезки — раньше в отборе, но возвращаются по порядку дат; не больше limit.
 */
function outlookBestRanges(days, limit) {
  var ranges = [];
  var current = null;
  var nextDay = function (iso) { return new Date(Date.parse(iso + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10); };
  days.forEach(function (day) {
    var good = day.level === 'high' && day.dark && day.moonOk;
    // Отрезок — только подряд идущие даты: пропуск в таблице его разрывает.
    if (good && current && nextDay(current.to) === day.date) {
      current.to = day.date;
      current.kp = Math.max(current.kp, day.kp);
    } else if (good) {
      current = { from: day.date, to: day.date, kp: day.kp };
      ranges.push(current);
    } else {
      current = null;
    }
  });

  return ranges
    .map(function (r, i) { return { range: r, i: i }; })
    .sort(function (x, y) { return y.range.kp - x.range.kp || x.i - y.i; })
    .slice(0, limit || 3)
    .sort(function (x, y) { return x.i - y.i; })
    .map(function (x) { return x.range; });
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
 * Тихие часы: попадает ли момент в окно [from, to) по местным часам пояса tz.
 * Окно может переходить через полночь (23 → 7). from === to — окна нет.
 * tz — название пояса IANA; без него берётся пояс машины. Неизвестный пояс — не тихо:
 * лучше лишнее уведомление, чем пропущенное сияние.
 */
function inQuietHours(date, tz, from, to) {
  if (typeof from !== 'number' || typeof to !== 'number' || from === to) return false;
  if (!(from >= 0 && from <= 23 && to >= 0 && to <= 23)) return false;

  var hour;
  try {
    var options = { hour: '2-digit', hourCycle: 'h23' };
    if (tz) options.timeZone = tz;
    hour = Number(new Intl.DateTimeFormat('en-GB', options).format(date));
  } catch (e) {
    return false;
  }
  if (!isFinite(hour)) return false;

  return from < to ? (hour >= from && hour < to) : (hour >= from || hour < to);
}

/** Ошибка с кодом: страница показывает перевод по коду, сообщение остаётся для журнала. */
function codedError(code, message) {
  var error = new Error(message);
  error.code = code;
  return error;
}

/**
 * NOAA отдаёт данные в двух форматах: массив объектов (/json/...) и массив
 * массивов с заголовком в первой строке (/products/..., исторический формат).
 * Приводим оба к массиву объектов с ключами в нижнем регистре.
 */
function normalizeRows(data) {
  if (!Array.isArray(data) || !data.length) throw codedError('empty', 'empty response');

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

  if (!rows.length) throw codedError('no_rows', 'no rows with data');
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
  if (!isFinite(value)) throw codedError('bad_kp', 'invalid Kp value');
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

/** Фаза по элонгации: один из восьми ключей (слова — в словарях интерфейса, moon.phase.*). */
function moonPhaseName(phase) {
  var e = phase.elongation;
  if (e < 22.5 || e >= 337.5) return 'new';
  if (e < 67.5)  return 'waxing_crescent';
  if (e < 112.5) return 'first_quarter';
  if (e < 157.5) return 'waxing_gibbous';
  if (e < 202.5) return 'full';
  if (e < 247.5) return 'waning_gibbous';
  if (e < 292.5) return 'last_quarter';
  return 'waning_crescent';
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
  LIGHT_LEVELS: LIGHT_LEVELS,
  codedError: codedError,
  inQuietHours: inQuietHours,
  solarWindSummary: solarWindSummary,
  solarWindLeadMinutes: solarWindLeadMinutes,
  ovationSummary: ovationSummary,
  parseOutlook27: parseOutlook27,
  outlookDays: outlookDays,
  outlookBestRanges: outlookBestRanges,
  BRIGHT_MOON: BRIGHT_MOON,
  REFERENCE_POINT_ID: REFERENCE_POINT_ID,
  CLOUD_CONFLICT_LIMIT: CLOUD_CONFLICT_LIMIT,
  CLOUD_LAYERS: CLOUD_LAYERS,
  DARK_USABLE: DARK_USABLE,
  DARK_FULL: DARK_FULL,
  WEATHER_MODEL: WEATHER_MODEL,
  findPoint: findPoint,
  geomagneticLatitude: geomagneticLatitude,
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
