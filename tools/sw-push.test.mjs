// Тесты sw.js без браузера: обработка push, нажатие на уведомление, оболочка приложения.
// Запуск: node --test tools/sw-push.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const swCode = read('sw.js');
const configCode = "var AURORA_CONFIG = { pushApi: 'https://push.example.workers.dev', vapidPublicKey: 'KEY' };";

const SCOPE = 'https://auroramurmansk.ru/';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/device-1';

/** Окружение service worker: события собираются, всё внешнее — подделки. */
function worker({ subscription = { endpoint: ENDPOINT }, message, serverStatus = 200, windows = [], config = configCode, importFails = false, language = 'ru-RU' } = {}) {
  const w = { handlers: {}, shown: [], fetched: [], opened: [], focused: [], cached: [], cachePuts: [] };

  const sandbox = {
    console, URL, Response, Request, Promise, Error, JSON,
    location: { origin: 'https://auroramurmansk.ru' },
    navigator: { language },
    importScripts(name) {
      if (importFails) throw new Error('не удалось загрузить ' + name);
      vm.runInContext(config, w.ctx, { filename: name });
    },
    fetch: async (url, init) => {
      w.fetched.push({ url: String(url && url.url ? url.url : url), init });
      if (message === 'down') throw new TypeError('Failed to fetch');
      if (String(url).endsWith('/message')) {
        return new Response(message ? JSON.stringify(message) : '{}', { status: message ? serverStatus : 404 });
      }
      return new Response('shell', { status: 200 });
    },
    caches: {
      open: async name => ({
        put: async (url, res) => { w.cachePuts.push(url); },
        keys: async () => [],
        match: async () => undefined
      }),
      keys: async () => [],
      delete: async () => true,
      match: async () => undefined
    },
    skipWaiting: async () => {},
    clients: {
      claim: async () => {},
      matchAll: async () => windows,
      openWindow: async url => { w.opened.push(url); return {}; }
    },
    registration: {
      scope: SCOPE,
      pushManager: { getSubscription: async () => subscription },
      showNotification: async (title, options) => { w.shown.push({ title, options }); }
    },
    addEventListener(type, handler) { w.handlers[type] = handler; }
  };
  sandbox.self = sandbox;
  w.ctx = vm.createContext(sandbox);
  vm.runInContext(swCode, w.ctx, { filename: 'sw.js' });

  /** Доставляет событие и ждёт всё, что передано в waitUntil. */
  w.fire = async (type, extra = {}) => {
    const pending = [];
    const event = { waitUntil: p => pending.push(p), ...extra };
    w.handlers[type](event);
    await Promise.all(pending);
    return event;
  };
  return w;
}

test('service worker запускается, даже если config.js не загрузился', async () => {
  const w = worker({ importFails: true });
  assert.equal(typeof w.handlers.push, 'function');
  assert.equal(typeof w.handlers.install, 'function');
});

test('push: текст берётся с сервера по адресу подписки и показывается', async () => {
  const w = worker({ message: { title: 'Высокий шанс увидеть сияние — Мурманск', body: 'Kp 4,3 · облачность 12%' } });
  await w.fire('push');

  const call = w.fetched.find(f => f.url.endsWith('/message'));
  assert.equal(call.url, 'https://push.example.workers.dev/message');
  assert.equal(call.init.method, 'POST');
  assert.deepEqual(JSON.parse(call.init.body), { endpoint: ENDPOINT });

  assert.equal(w.shown.length, 1);
  assert.equal(w.shown[0].title, 'Высокий шанс увидеть сияние — Мурманск');
  assert.equal(w.shown[0].options.body, 'Kp 4,3 · облачность 12%');
  assert.equal(w.shown[0].options.icon, 'https://auroramurmansk.ru/icons/icon-192.png');
  assert.equal(w.shown[0].options.tag, 'aurora-high');
  assert.equal(w.shown[0].options.lang, 'ru');
  assert.equal(w.shown[0].options.data.url, 'https://auroramurmansk.ru/#now');
});

test('push: сервер недоступен — всё равно показываем уведомление (браузеры требуют его на каждый push)', async () => {
  const w = worker({ message: 'down' });
  await w.fire('push');
  assert.equal(w.shown.length, 1);
  assert.equal(w.shown[0].title, 'Возможно северное сияние');
});

test('push: сервер ответил 404 (сообщения нет) — общее уведомление', async () => {
  const w = worker({ message: null });
  await w.fire('push');
  assert.equal(w.shown.length, 1);
  assert.equal(w.shown[0].title, 'Возможно северное сияние');
});

test('push: подписки в браузере уже нет — уведомление всё равно показывается, к серверу не идём', async () => {
  const w = worker({ subscription: null, message: { title: 'x', body: 'y' } });
  await w.fire('push');
  assert.equal(w.shown.length, 1);
  assert.equal(w.fetched.length, 0);
});

test('push: адрес сервера не настроен — общее уведомление', async () => {
  const w = worker({ config: "var AURORA_CONFIG = { pushApi: '', vapidPublicKey: '' };" });
  await w.fire('push');
  assert.equal(w.shown[0].title, 'Возможно северное сияние');
  assert.equal(w.fetched.length, 0);
});

test('push: приложение открыто и в фокусе — лишнего уведомления нет', async () => {
  const w = worker({
    message: { title: 'Высокий шанс', body: 'x' },
    windows: [{ visibilityState: 'visible', focused: true, url: SCOPE }]
  });
  await w.fire('push');
  assert.equal(w.shown.length, 0);
});

test('push: приложение открыто, но в фоне — уведомление показывается', async () => {
  for (const win of [{ visibilityState: 'hidden', focused: false }, { visibilityState: 'visible', focused: false }]) {
    const w = worker({ message: { title: 'Высокий шанс', body: 'x' }, windows: [{ ...win, url: SCOPE }] });
    await w.fire('push');
    assert.equal(w.shown.length, 1, JSON.stringify(win));
  }
});

test('пробное уведомление показывается всегда, даже когда приложение перед глазами', async () => {
  const w = worker({
    message: { title: 'Пробное уведомление', body: 'работает', test: true },
    windows: [{ visibilityState: 'visible', focused: true, url: SCOPE }]
  });
  await w.fire('push');
  assert.equal(w.shown.length, 1);
  assert.equal(w.shown[0].options.tag, 'aurora-test');
});

test('нажатие на уведомление: возвращает фокус открытому приложению', async () => {
  const focused = [];
  const w = worker({ windows: [{ url: SCOPE + '?x=1', focus: async () => { focused.push(1); } }] });
  let closed = false;
  await w.fire('notificationclick', { notification: { close: () => { closed = true; }, data: { url: SCOPE + '#now' } } });
  assert.equal(closed, true);
  assert.equal(focused.length, 1);
  assert.equal(w.opened.length, 0);
});

test('нажатие на уведомление: приложения нет — открывает', async () => {
  const w = worker({ windows: [{ url: 'https://other.example/', focus: async () => {} }] });
  await w.fire('notificationclick', { notification: { close() {}, data: { url: SCOPE + '#now' } } });
  assert.deepEqual(w.opened, [SCOPE + '#now']);
});

test('обращения к серверу уведомлений service worker не перехватывает (другой источник)', async () => {
  const w = worker();
  let responded = false;
  w.handlers.fetch({
    request: { method: 'POST', url: 'https://push.example.workers.dev/subscribe', mode: 'cors' },
    respondWith: () => { responded = true; }
  });
  assert.equal(responded, false);

  w.handlers.fetch({
    request: { method: 'GET', url: 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json', mode: 'cors' },
    respondWith: () => { responded = true; }
  });
  assert.equal(responded, false, 'данные NOAA и Open-Meteo по-прежнему идут в сеть напрямую');
});

test('установка кэширует всю оболочку, включая core.js, config.js и push.js', async () => {
  const w = worker();
  await w.fire('install');
  const cached = w.cachePuts.map(u => u.replace(SCOPE, ''));
  for (const file of ['', 'index.html', 'styles.css', 'app.js', 'core.js', 'config.js', 'push.js', 'manifest.json', 'icons/icon-192.png'])
    assert.ok(cached.includes(file), 'в оболочке нет ' + (file || './'));
});

test('каждый скрипт из index.html лежит в оболочке service worker', () => {
  const html = read('index.html');
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  assert.ok(scripts.length >= 4);
  const shell = swCode.slice(swCode.indexOf('var APP_SHELL'), swCode.indexOf('];', swCode.indexOf('var APP_SHELL')));
  for (const s of scripts) assert.ok(shell.includes("'" + s + "'"), s + ' не в APP_SHELL: офлайн-режим сломается');
});

test('push: общее уведомление — на языке браузера, чужие языки получают английский', async () => {
  const cases = [
    ['ru-RU', 'Возможно северное сияние', 'ru'],
    ['zh-CN', '可能出现极光', 'zh'],
    ['zh-Hans', '可能出现极光', 'zh'],
    ['en-US', 'Northern lights possible', 'en'],
    ['fr-FR', 'Northern lights possible', 'en'],
    ['', 'Northern lights possible', 'en']
  ];
  for (const [language, title, lang] of cases) {
    const w = worker({ message: null, language });
    await w.fire('push');
    assert.equal(w.shown[0].title, title, language);
    assert.equal(w.shown[0].options.lang, lang, language);
    assert.doesNotMatch(w.shown[0].options.body, language.startsWith('ru') ? /^$/ : /[А-Яа-я]/, language);
  }
});

test('push: текст, который собрал сервер, показывается как есть, а язык уведомления берётся из ответа', async () => {
  const w = worker({ message: { title: 'High chance of aurora — Murmansk', body: 'Kp 5.0', lang: 'en' }, language: 'ru-RU' });
  await w.fire('push');
  assert.equal(w.shown[0].title, 'High chance of aurora — Murmansk');
  assert.equal(w.shown[0].options.lang, 'en');
});

test('установка качает файлы с меткой версии (мимо кэша CDN), а хранит под обычными адресами', async () => {
  const w = worker();
  await w.fire('install');
  const version = /CACHE_VERSION = '([^']+)'/.exec(swCode)[1];
  const shellFetches = w.fetched.filter(f => f.url.startsWith(SCOPE));
  assert.ok(shellFetches.length > 20);
  for (const f of shellFetches) {
    assert.ok(f.url.endsWith('?v=' + version), 'без метки версии: ' + f.url);
    assert.equal(f.init && f.init.cache, undefined, 'Request несёт cache сам');
  }
  assert.ok(w.cachePuts.every(u => !u.includes('?v=')), 'в кэше — обычные адреса, по ним и ищет страница');
  assert.ok(w.cachePuts.includes(SCOPE + 'index.html'));
});
