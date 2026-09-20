// Песочница: запускает app.js (и core.js) в Node без браузера, чтобы проверять
// расчёты на тысячах комбинаций входных данных. DOM заменён заглушкой,
// которая принимает любые вызовы, — расчёты от него не зависят.
import vm from 'node:vm';

/** Заглушка «что угодно»: любое свойство и любой вызов дают ещё одну заглушку. */
const stub = () => new Proxy(function () {}, {
  get: (_t, p) => (p === Symbol.toPrimitive ? () => '' : p === 'then' ? undefined : stub()),
  apply: () => stub(),
  construct: () => stub(),
  set: () => true,
  has: () => true
});

/**
 * sources — список [имя файла, исходный код] в порядке подключения.
 * options.now — зафиксированный момент (мс) или options.clock = { now } — меняемый;
 * options.fetch — подмена fetch; options.getElement(id) — подмена document.getElementById.
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
        : (prop in target ? target[prop] : (prop === 'then' ? undefined : stub()))
    }),
    window: { addEventListener() {}, matchMedia: () => ({ matches: false }), navigator: { userAgent: '', platform: '', maxTouchPoints: 0 } },
    navigator: { userAgent: '', platform: '', maxTouchPoints: 0 },
    location: { href: 'http://localhost/', hash: '', search: '', protocol: 'http:', hostname: 'localhost' },
    history: { replaceState() {} },
    performance: { now: () => 0 },
    localStorage,
    fetch: options.fetch
  };

  const ctx = vm.createContext(sandbox);
  for (const [name, code] of sources) vm.runInContext(code, ctx, { filename: name });
  return ctx;
}

/** JSON-снимок значения: одинаково сериализует объекты из разных контекстов. */
export const snap = value => JSON.stringify(value);
