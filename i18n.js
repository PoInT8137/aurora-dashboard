/* Переводы интерфейса: русский, английский, китайский (упрощённый).
 *
 * Слова лежат в словарях lang/ru.js, lang/en.js, lang/zh.js, а этот файл — только
 * механика: выбор языка, подстановка значений, множественные числа и разметка.
 * Зависимостей нет; в Node подключается так же, как в браузере.
 *
 * Ключ словаря — плоская строка вида «kp.calm». Значение — либо строка с
 * подстановками {имя}, либо объект вариантов множественного числа
 * { one, few, many, other }: нужный выбирает Intl.PluralRules по params.n.
 * Нет ключа в текущем языке — берётся английский, затем русский, затем сам ключ.
 */
'use strict';

var I18N_LANGS = [
  { code: 'ru', name: 'Русский', locale: 'ru-RU', html: 'ru' },
  { code: 'en', name: 'English', locale: 'en-GB', html: 'en' },
  { code: 'zh', name: '中文',    locale: 'zh-CN', html: 'zh-CN' }
];

/* Язык для тех, чей браузер не говорит ни на одном из трёх: туристам английский понятнее. */
var I18N_FALLBACK = 'en';

var i18nDicts = {};
var i18nLang = 'ru';
var i18nRules = {};

function i18nRegister(code, dict) {
  i18nDicts[code] = dict;
}

function i18nKnown(code) {
  return I18N_LANGS.some(function (lang) { return lang.code === code; });
}

function langInfo(code) {
  for (var i = 0; i < I18N_LANGS.length; i++) {
    if (I18N_LANGS[i].code === (code || i18nLang)) return I18N_LANGS[i];
  }
  return I18N_LANGS[0];
}

function getLang() {
  return i18nLang;
}

/** Меняет язык; неизвестный код игнорируется. Возвращает действующий язык. */
function setLang(code) {
  if (i18nKnown(code)) i18nLang = code;
  return i18nLang;
}

/** Код нашего языка по тегу браузера: «zh-Hans-CN» → zh, «ru-RU» → ru; иначе null. */
function langFromTag(tag) {
  var base = String(tag || '').toLowerCase().split(/[-_]/)[0];
  return i18nKnown(base) ? base : null;
}

/**
 * Какой язык показать. Приоритет: явный выбор в адресе (?lang=), сохранённый
 * выбор, языки браузера по порядку предпочтений, затем английский.
 */
function detectLang(fromUrl, saved, browserLangs) {
  if (i18nKnown(fromUrl)) return fromUrl;
  if (i18nKnown(saved)) return saved;

  var list = browserLangs || [];
  for (var i = 0; i < list.length; i++) {
    var code = langFromTag(list[i]);
    if (code) return code;
  }
  return I18N_FALLBACK;
}

function i18nLookup(key) {
  var order = [i18nLang, 'en', 'ru'];
  for (var i = 0; i < order.length; i++) {
    var dict = i18nDicts[order[i]];
    if (dict && Object.prototype.hasOwnProperty.call(dict, key)) return dict[key];
  }
  return undefined;
}

function hasKey(key) {
  return i18nLookup(key) !== undefined;
}

function pluralCategory(n) {
  var locale = langInfo().locale;
  if (!i18nRules[locale]) i18nRules[locale] = new Intl.PluralRules(locale);
  return i18nRules[locale].select(n);
}

/** Перевод по ключу с подстановкой {имя} из params; для объектов — по params.n. */
function t(key, params) {
  var value = i18nLookup(key);
  if (value === undefined) return key;

  if (value !== null && typeof value === 'object') {
    var category = pluralCategory(params && params.n !== undefined ? params.n : 1);
    value = value[category] !== undefined ? value[category] : value.other;
  }

  return String(value).replace(/\{(\w+)\}/g, function (match, name) {
    return params && params[name] !== undefined ? params[name] : match;
  });
}

/** Локаль для дат и времени. Часовой пояс остаётся московским — задаёт вызывающий. */
function langLocale() {
  return langInfo().locale;
}

/** Десятичный разделитель: запятая только в русском. */
function fmtNum(text) {
  return i18nLang === 'ru' ? String(text).replace('.', ',') : String(text);
}

/** Название точки на текущем языке. */
function pointName(point) {
  return (point.names && point.names[i18nLang]) || point.name;
}

/**
 * Переводит разметку: data-i18n="ключ" заменяет текст элемента (только у листовых
 * элементов — вложенное пропадёт), data-i18n-attr="атрибут:ключ;атрибут:ключ" — атрибуты.
 */
function i18nApply(root) {
  var i, el, pairs, j, bits;

  var texts = root.querySelectorAll('[data-i18n]');
  for (i = 0; i < texts.length; i++) {
    el = texts[i];
    el.textContent = t(el.getAttribute('data-i18n'));
  }

  var attrs = root.querySelectorAll('[data-i18n-attr]');
  for (i = 0; i < attrs.length; i++) {
    el = attrs[i];
    pairs = el.getAttribute('data-i18n-attr').split(';');
    for (j = 0; j < pairs.length; j++) {
      bits = pairs[j].split(':');
      if (bits.length === 2) el.setAttribute(bits[0].trim(), t(bits[1].trim()));
    }
  }
}
