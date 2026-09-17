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
  refreshMs: 5 * 60 * 1000, // автообновление раз в 5 минут

  /*
   * Модель Open-Meteo. best_match для Мурманска выбирает MET Norway: её
   * ответ совпадает с models=metno_seamless во всех полях и на всех часах.
   *
   * У этой модели ярусы и суммарная облачность несогласованы: на 48-часовом
   * ряду в трети часов нарушается неравенство max(ярусы) <= всего <= сумма
   * ярусов (например ярусы 8/4/0 при суммарной облачности 90 %). Какое из
   * двух полей врёт — неизвестно: те же ярусы 8/13/0 отдают knmi_seamless и
   * dmi_seamless с согласованной суммой 15 %, но суммарные 72 % совпадают у
   * icon_eu и gfs_seamless. Поэтому итог считается по ярусам, а суммарное
   * поле используется как перекрёстная проверка (CLOUD_CONFLICT_LIMIT).
   *
   * Альтернатива с согласованными полями — 'icon_eu': за те же 48 часов ни
   * одного нарушения, среднее расхождение 2 п.п. Модель грубее (7 км против
   * локальной скандинавской сетки), но её ярусы и сумма не противоречат
   * друг другу.
   */
  weatherModel: 'best_match'
};

/*
 * Порог противоречивости: если оценка по ярусам и суммарная облачность
 * расходятся сильнее, доверять данным нельзя — показываем предупреждение
 * и не ставим высокий балл за облачность.
 */
var CLOUD_CONFLICT_LIMIT = 30;

var URLS = {
  kpNow:      'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json',
  kpNowAlt:   'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json',
  kpForecast: 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json',
  weather:    'https://api.open-meteo.com/v1/forecast'
    + '?latitude=' + CONFIG.lat + '&longitude=' + CONFIG.lon
    + '&current=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,temperature_2m'
    + '&hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high'
    + '&models=' + CONFIG.weatherModel
    + '&forecast_days=2&timezone=UTC'
};

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
  var ks = kp !== null ? kpScore(kp.value) : null;
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

  return fetchJson(URLS.weather)
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
        stale: null
      };
      state.cloud = cloud;
      cacheSave('cloud', cloud);
      renderCloud(cloud);
      return cloud;
    })
    .catch(function (err) {
      var cached = cacheLoad('cloud');

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
      renderForecast(rows, null);
      return rows;
    })
    .catch(function (err) {
      var cached = cacheLoad('forecast');

      if (cached) {
        var rows = buildForecastRows(cached.payload);
        if (rows.length) {
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

function refreshAll() {
  var btn = $('refresh');
  btn.disabled = true;
  $('updated').textContent = 'Обновляем…';
  setState('verdict-card', 'loading');

  return Promise.all([loadKp(), loadCloud(), loadForecast()])
    .then(function () {
      renderVerdict();

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
