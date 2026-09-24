// Тексты уведомлений с сервера. Язык — тот, что человек выбрал на сайте: страница
// присылает его при подписке и при смене языка, сервер хранит его рядом с подпиской.
// Названия точек берутся из общего ядра (point.names); остальные слова — только серверные.

export const LANGS = ['ru', 'en', 'zh'];

/** Подписки, оформленные до появления выбора языка, — русские. */
export const DEFAULT_LANG = 'ru';

/** Язык из запроса: один из известных или null (не указан либо мусор). */
export function normalizeLang(value) {
  return LANGS.includes(value) ? value : null;
}

/** Пояс IANA, который знает Intl: иначе null (мусор, слишком длинная строка). */
export function normalizeZone(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return null;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

/**
 * Тихие часы из запроса: { from, to } — целые 0–23, не равные друг другу.
 * Возвращает { set: false }, если поле не присылали или оно негодное (прежнее значение остаётся),
 * { set: true, from: null, to: null } для явного null (выключить) и { set: true, from, to }.
 */
export function normalizeQuiet(body) {
  if (!Object.prototype.hasOwnProperty.call(body, 'quiet')) return { set: false };
  if (body.quiet === null) return { set: true, from: null, to: null };

  const q = body.quiet;
  const hour = v => Number.isInteger(v) && v >= 0 && v <= 23;
  if (q && typeof q === 'object' && hour(q.from) && hour(q.to) && q.from !== q.to) {
    return { set: true, from: q.from, to: q.to };
  }
  return { set: false };
}

/** Название точки на языке подписчика. */
export function pointName(point, lang) {
  return (point.names && point.names[lang]) || point.name;
}

const kpText = (value, lang) => (lang === 'ru' ? value.toFixed(1).replace('.', ',') : value.toFixed(1));

const ALERT = {
  ru: {
    title: name => 'Высокий шанс увидеть сияние — ' + name,
    body: (kp, cloud) => 'Kp ' + kp + ' · облачность ' + cloud + '% · тёмное небо. Смотрите на север.'
  },
  en: {
    title: name => 'High chance of aurora — ' + name,
    body: (kp, cloud) => 'Kp ' + kp + ' · cloud cover ' + cloud + '% · dark sky. Look north.'
  },
  zh: {
    title: name => '极光机会大——' + name,
    body: (kp, cloud) => 'Kp ' + kp + ' · 云量 ' + cloud + '% · 夜空漆黑。请朝北看。'
  }
};

// Средний шанс — для тех, кто выбрал «сообщать и о среднем».
const ALERT_MID = {
  ru: {
    title: name => 'Средний шанс увидеть сияние — ' + name,
    body: (kp, cloud) => 'Kp ' + kp + ' · облачность ' + cloud + '%. Слабое сияние возможно — смотрите на север, подальше от огней.'
  },
  en: {
    title: name => 'Moderate chance of aurora — ' + name,
    body: (kp, cloud) => 'Kp ' + kp + ' · cloud cover ' + cloud + '%. A faint aurora is possible — look north, away from lights.'
  },
  zh: {
    title: name => '极光机会中等——' + name,
    body: (kp, cloud) => 'Kp ' + kp + ' · 云量 ' + cloud + '%。可能出现微弱极光——请远离灯光朝北看。'
  }
};

// «Небо скоро откроется»: сейчас облака, но просвет обещан в ближайшие часы.
const SKY = {
  ru: {
    title: name => 'Небо скоро откроется — ' + name,
    body: (time, cloud, kp) => 'Облака должны разойтись к ' + time + ' (облачность около ' + cloud + '%). Kp ' + kp + ' — сияние возможно, приготовьтесь.'
  },
  en: {
    title: name => 'The sky should clear soon — ' + name,
    body: (time, cloud, kp) => 'Clouds are expected to break by ' + time + ' (cloud cover about ' + cloud + '%). Kp ' + kp + ' — aurora is possible, get ready.'
  },
  zh: {
    title: name => '天空即将放晴——' + name,
    body: (time, cloud, kp) => '云层预计在 ' + time + ' 前散开（云量约 ' + cloud + '%）。Kp ' + kp + '——可能出现极光，请做好准备。'
  }
};

// Ранний сигнал: поле солнечного ветра повернуло на юг, Kp ещё не вырос.
const BZ = {
  ru: {
    title: name => 'Сияние может начаться в ближайший час — ' + name,
    body: (bz, cloud, strong) => 'Магнитное поле солнечного ветра ' + (strong ? 'резко ' : '') + 'повернуло на юг: Bz ' + bz +
      ' нТл. Небо тёмное, облачность ' + cloud + '%. Выходите заранее и смотрите на север.'
  },
  en: {
    title: name => 'Aurora may start within the hour — ' + name,
    body: (bz, cloud, strong) => 'The solar wind magnetic field has turned ' + (strong ? 'sharply ' : '') + 'south: Bz ' + bz +
      ' nT. Dark sky, cloud cover ' + cloud + '%. Head out early and look north.'
  },
  zh: {
    title: name => '极光可能在一小时内出现——' + name,
    body: (bz, cloud, strong) => '太阳风磁场' + (strong ? '急剧' : '') + '转向南：Bz ' + bz +
      ' nT。夜空漆黑，云量 ' + cloud + '%。请提前出门，朝北看。'
  }
};

const TEST = {
  ru: {
    title: 'Пробное уведомление',
    body: name => 'Сервер уведомлений работает. О высоком шансе в точке «' + name + '» сообщим так же — даже когда приложение закрыто.'
  },
  en: {
    title: 'Test notification',
    body: name => 'The notification server is working. We will report a high chance at “' + name + '” the same way — even when the app is closed.'
  },
  zh: {
    title: '测试通知',
    body: name => '通知服务器运行正常。“' + name + '”的极光机会变大时也会这样通知您——即使应用已关闭。'
  }
};

/** level — 'high' (по умолчанию) или 'mid' для тех, кто выбрал «сообщать и о среднем». */
export function alertMessage(point, kp, cloud, nowMs, lang = DEFAULT_LANG, level = 'high') {
  const texts = (level === 'mid' ? ALERT_MID : ALERT)[normalizeLang(lang) || DEFAULT_LANG];
  const code = normalizeLang(lang) || DEFAULT_LANG;
  return {
    title: texts.title(pointName(point, code)),
    body: texts.body(kpText(kp.value, code), cloud.value),
    lang: code,
    at: nowMs
  };
}

/** «Небо скоро откроется»: clear — { time (мс), cloud (%) }; время — по поясу подписчика (или МСК). */
export function skyMessage(point, kp, clear, nowMs, lang = DEFAULT_LANG, tz) {
  const code = normalizeLang(lang) || DEFAULT_LANG;
  const zone = normalizeZone(tz) || 'Europe/Moscow';
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(clear.time));
  return {
    title: SKY[code].title(pointName(point, code)),
    body: SKY[code].body(time, clear.cloud, kpText(kp.value, code)),
    lang: code,
    kind: 'sky',
    at: nowMs
  };
}

/** Ранний сигнал о Bz: level — 'strong' | 'south' (из bzLevel). */
export function bzMessage(point, bz, cloud, level, nowMs, lang = DEFAULT_LANG) {
  const code = normalizeLang(lang) || DEFAULT_LANG;
  const value = (Math.round(bz * 10) / 10).toFixed(1);
  return {
    title: BZ[code].title(pointName(point, code)),
    body: BZ[code].body((code === 'ru' ? value.replace('.', ',') : value).replace('-', '−'), cloud.value, level === 'strong'),
    lang: code,
    kind: 'bz',
    at: nowMs
  };
}

/** pointRef — точка из ядра либо, если её уже нет в списке, просто её id. */
export function testMessage(pointRef, nowMs, lang = DEFAULT_LANG) {
  const code = normalizeLang(lang) || DEFAULT_LANG;
  const name = typeof pointRef === 'object' && pointRef ? pointName(pointRef, code) : String(pointRef);
  return {
    title: TEST[code].title,
    body: TEST[code].body(name),
    lang: code,
    test: true,
    at: nowMs
  };
}
