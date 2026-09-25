// Песочница: запускает app.js (и core.js) в Node без браузера, чтобы проверять
// расчёты на тысячах комбинаций входных данных. DOM заменён заглушкой,
// которая принимает любые вызовы, — расчёты от него не зависят.
import vm from 'node:vm';
import fs from 'node:fs';

/** Заглушка «что угодно»: любое свойство и любой вызов дают ещё одну заглушку. */
const stub = () => new Proxy(function () {}, {
  get: (_t, p) => (p === Symbol.toPrimitive ? () => '' : p === 'then' ? undefined : stub()),
  apply: () => stub(),
  construct: () => stub(),
  set: () => true,
  has: () => true
});

/** Схема карты, движок переводов и словари — всё, что app.js ждёт от страницы до себя. */
const I18N_FILES = ['map.js', 'i18n.js', 'lang/ru.js', 'lang/en.js', 'lang/zh.js'];

/** Части приложения из js/ — в том порядке, в каком их подключает index.html. */
export const APP_PARTS = [...fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  .matchAll(/<script src="(js\/[\w-]+\.js)"><\/script>/g)].map(m => m[1]);

/** Весь код приложения одной строкой — для тестов, которые проверяют исходник, а не поведение. */
export function appSource() {
  return [...APP_PARTS, 'app.js'].map(name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8')).join('\n');
}

/**
 * Тесты перечисляют скрипты по старинке: config, core, push, app. Движок переводов, словари,
 * схема карты и части приложения из js/ нужны app.js всегда, поэтому вставляются перед ним,
 * если тест их не указал сам.
 */
function withI18n(sources) {
  const names = sources.map(([name]) => name);
  if (!names.includes('app.js') || names.includes('i18n.js')) return sources;

  const extra = [...I18N_FILES, ...APP_PARTS].map(name => [name, fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8')]);
  const at = names.indexOf('app.js');
  return [...sources.slice(0, at), ...extra, ...sources.slice(at)];
}

/**
 * sources — список [имя файла, исходный код] в порядке подключения.
 * options.now — зафиксированный момент (мс) или options.clock = { now } — меняемый;
 * options.fetch — подмена fetch; options.getElement(id) — подмена document.getElementById; options.createElement — подмена document.createElement.
 */
export function loadApp(sources, options = {}) {
  const store = new Map();

  // «Сейчас» задаётся числом (options.now) либо объектом { now }, который тест
  // может менять по ходу, — расчёты окна наблюдения и высоты Солнца зависят от времени.
  const clock = options.clock || (options.now === undefined ? null : { now: options.now });
  const FakeDate = !clock ? Date : class extends Date {
    constructor(...args) { if (args.length) super(...args); else super(clock.now); }
    static now() { return clock.now; }
  };

  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); }
  };

  const sandbox = {
    console, setTimeout, clearTimeout, AbortController, URL, Response, DOMException,
    setInterval: () => 0, clearInterval: () => {},
    Date: FakeDate,
    // getElementById отдаёт элементы, которые подставил тест (options.getElement), иначе заглушку.
    document: new Proxy({}, {
      get: (target, prop) => prop === 'getElementById'
        ? (id => (options.getElement && options.getElement(id)) || stub())
        : (prop === 'createElement' && options.createElement)
          ? options.createElement
          : (prop in target ? target[prop] : (prop === 'then' ? undefined : stub()))
    }),
    window: { addEventListener() {}, matchMedia: () => ({ matches: false }), navigator: { userAgent: '', platform: '', maxTouchPoints: 0 } },
    navigator: { userAgent: '', platform: '', maxTouchPoints: 0 },
    location: { href: 'http://localhost/', hash: '', search: '', protocol: 'http:', hostname: 'localhost' },
    history: { replaceState() {} },
    performance: { now: () => 0 },
    localStorage,
    fetch: noaaAware(options)
  };

  const ctx = vm.createContext(sandbox);
  for (const [name, code] of withI18n(sources)) vm.runInContext(code, ctx, { filename: name });
  return ctx;
}

/*
 * Данные NOAA страница сначала берёт через сервер (/noaa/<имя>, js/base.js NOAA_ON_SERVER), и
 * сервер отдаёт их в том же формате. Тесты подменяют fetch по адресам NOAA, поэтому запрос к
 * серверу здесь переводится обратно в адрес NOAA: прежние тесты проверяют и путь через сервер.
 * options.rawFetch — отдать подмене адрес как есть (для тестов самого пути через сервер).
 */
const NOAA_ON_SERVER = Object.fromEntries([...fs.readFileSync(new URL('../js/base.js', import.meta.url), 'utf8')
  .matchAll(/'(https:\/\/services\.swpc\.noaa\.gov\/[^']+)': '([\w-]+)'/g)].map(m => [m[2], m[1]]));

function noaaAware(options) {
  const fetchFn = options.fetch;
  if (!fetchFn || options.rawFetch) return fetchFn;
  return (url, init) => {
    const m = /\/noaa\/([\w-]+)$/.exec(String(url));
    return fetchFn(m && NOAA_ON_SERVER[m[1]] ? NOAA_ON_SERVER[m[1]] : url, init);
  };
}

/** JSON-снимок значения: одинаково сериализует объекты из разных контекстов. */
export const snap = value => JSON.stringify(value);
