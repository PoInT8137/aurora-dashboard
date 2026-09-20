// Тесты push.js без браузера: подделка pushManager, Notification и сервера.
// Запуск: node --test tools/push-client.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('../push.js', import.meta.url), 'utf8');

// Открытый ключ в том виде, как его хранит config.js: base64url от 65 байт.
const KEY_BYTES = Uint8Array.from({ length: 65 }, (_, i) => (i * 7 + 4) % 256);
const b64u = bytes => Buffer.from(bytes).toString('base64url');
const PUBLIC_KEY = b64u(KEY_BYTES);
const OTHER_KEY = b64u(KEY_BYTES.map(b => b ^ 0xff));

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/device-1';

/** Собирает окружение «браузер»: разрешение, подписки, сервер. */
function world({ permission = 'default', asks = 'granted', existing = null, server = {}, configured = true, hasServiceWorker = true } = {}) {
  const w = { permission, asks, sub: existing, requests: [], subscribeCalls: 0, unsubscribed: 0, store: new Map() };

  const makeSub = (endpoint = ENDPOINT, key = KEY_BYTES) => ({
    endpoint,
    options: { applicationServerKey: key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) },
    unsubscribe: async () => { w.unsubscribed++; w.sub = null; return true; }
  });
  w.makeSub = makeSub;
  if (existing) w.sub = existing;

  const registration = {
    pushManager: {
      getSubscription: async () => w.sub,
      subscribe: async opts => {
        w.subscribeCalls++;
        w.lastSubscribe = opts;
        if (w.subscribeHangs) return new Promise(() => {});   // браузер не может достучаться до push-сервиса
        if (w.subscribeError) throw w.subscribeError;
        w.sub = makeSub();
        return w.sub;
      }
    }
  };

  const Notification = {
    get permission() { return w.permission; },
    requestPermission(cb) {
      w.permission = w.asks;
      if (cb) { cb(w.asks); return undefined; }
      return Promise.resolve(w.asks);
    }
  };

  const fetch = async (url, init = {}) => {
    const path = String(url).replace('https://push.example.workers.dev', '');
    const body = init.body ? JSON.parse(init.body) : null;
    w.requests.push({ path, body });
    const handler = server[path];
    const { status = 200, json = { ok: true } } = typeof handler === 'function' ? handler(body) : (handler || {});
    if (status === 'network') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(json), { status });
  };

  const sandbox = {
    console, setTimeout, clearTimeout, AbortController, Response, Uint8Array, atob,
    navigator: hasServiceWorker ? { serviceWorker: { ready: Promise.resolve(registration) } } : {},
    window: { PushManager: function () {}, Notification },   // как в браузере: оба на window
    Notification,
    fetch,
    localStorage: {
      getItem: k => (w.store.has(k) ? w.store.get(k) : null),
      setItem: (k, v) => { w.store.set(k, String(v)); },
      removeItem: k => { w.store.delete(k); }
    },
    AURORA_CONFIG: configured ? { pushApi: 'https://push.example.workers.dev', vapidPublicKey: PUBLIC_KEY } : { pushApi: '', vapidPublicKey: '' }
  };
  w.ctx = vm.createContext(sandbox);
  vm.runInContext(code, w.ctx, { filename: 'push.js' });
  w.flag = () => w.store.get('aurora.push') ?? null;
  return w;
}

test('настроено ли: пустой config.js отключает всё', () => {
  assert.equal(world({ configured: true }).ctx.pushConfigured(), true);
  assert.equal(world({ configured: false }).ctx.pushConfigured(), false);
  const w = world({ configured: false });
  w.store.set('aurora.push', 'on');
  assert.equal(w.ctx.pushIsActive(), false, 'без настройки «включено» быть не может');
});

test('поддержка браузером требует service worker, PushManager и Notification', () => {
  assert.equal(world().ctx.pushSupported(), true);
  assert.equal(world({ hasServiceWorker: false }).ctx.pushSupported(), false);
});

test('ключ VAPID превращается в те же 65 байт', () => {
  const bytes = world().ctx.pushKeyBytes(PUBLIC_KEY);
  assert.equal(bytes.length, 65);
  assert.deepEqual([...bytes], [...KEY_BYTES]);
});

test('включение: разрешение → подписка браузера с нашим ключом → регистрация точки на сервере', async () => {
  const w = world();
  const sub = await w.ctx.pushSubscribe('teriberka');

  assert.equal(sub.endpoint, ENDPOINT);
  assert.equal(w.lastSubscribe.userVisibleOnly, true, 'без этого браузеры не принимают подписку');
  assert.deepEqual([...new Uint8Array(w.lastSubscribe.applicationServerKey)], [...KEY_BYTES]);
  assert.deepEqual(w.requests, [{ path: '/subscribe', body: { endpoint: ENDPOINT, point: 'teriberka' } }]);
  assert.equal(w.flag(), 'on');
  assert.equal(w.ctx.pushIsActive(), true);
});

test('включение: разрешение уже выдано — не спрашиваем ещё раз через диалог, но подписываемся', async () => {
  const w = world({ permission: 'granted' });
  await w.ctx.pushSubscribe('murmansk');
  assert.equal(w.flag(), 'on');
});

test('включение: пользователь отказал — ничего не создаётся и на сервер не идёт', async () => {
  for (const answer of ['denied', 'default']) {
    const w = world({ asks: answer });
    await assert.rejects(() => w.ctx.pushSubscribe('murmansk'), e => e.code === 'permission_' + answer);
    assert.equal(w.subscribeCalls, 0);
    assert.equal(w.requests.length, 0);
    assert.equal(w.flag(), null);
  }
});

test('включение: старый Safari отвечает через колбэк, а не промис', async () => {
  const w = world();
  w.ctx.Notification.requestPermission = cb => { w.permission = 'granted'; setTimeout(() => cb('granted'), 5); };
  await w.ctx.pushSubscribe('murmansk');
  assert.equal(w.flag(), 'on');
});

test('сервер отклонил подписку — созданная только что браузерная отзывается, флаг не ставится', async () => {
  const w = world({ server: { '/subscribe': { status: 503, json: { error: 'limit' } } } });
  await assert.rejects(() => w.ctx.pushSubscribe('murmansk'), e => e.code === 'limit' && e.status === 503);
  assert.equal(w.unsubscribed, 1, 'иначе браузер считал бы себя подписанным без ответа на той стороне');
  assert.equal(w.sub, null);
  assert.equal(w.flag(), null);
});

test('сервер недоступен при включении — то же самое', async () => {
  const w = world({ server: { '/subscribe': { status: 'network' } } });
  await assert.rejects(() => w.ctx.pushSubscribe('murmansk'), e => e instanceof TypeError);
  assert.equal(w.unsubscribed, 1);
  assert.equal(w.flag(), null);
});

test('сервер отклонил, но подписка браузера была раньше — её не трогаем', async () => {
  const w = world({ permission: 'granted', server: { '/subscribe': { status: 503, json: { error: 'limit' } } } });
  w.sub = w.makeSub();
  await assert.rejects(() => w.ctx.pushSubscribe('murmansk'));
  assert.equal(w.unsubscribed, 0);
  assert.ok(w.sub);
});

test('браузер не смог связаться со своим push-сервисом — ошибка доходит до интерфейса', async () => {
  const w = world();
  w.subscribeError = Object.assign(new Error('push service error'), { name: 'AbortError' });
  await assert.rejects(() => w.ctx.pushSubscribe('murmansk'), e => e.name === 'AbortError');
  assert.equal(w.requests.length, 0);
  assert.equal(w.flag(), null);
});

test('подписка с чужим ключом VAPID заменяется: по ней сервер не смог бы отправить', async () => {
  const w = world({ permission: 'granted' });
  const otherBytes = Uint8Array.from(Buffer.from(OTHER_KEY, 'base64url'));
  w.sub = w.makeSub(ENDPOINT, otherBytes);

  await w.ctx.pushSubscribe('murmansk');
  assert.equal(w.unsubscribed, 1, 'старую отозвали');
  assert.equal(w.subscribeCalls, 1, 'оформили новую');
});

test('подписка с нашим ключом переиспользуется, повторно не создаётся', async () => {
  const w = world({ permission: 'granted' });
  w.sub = w.makeSub();
  await w.ctx.pushSubscribe('murmansk');
  assert.equal(w.subscribeCalls, 0);
  assert.equal(w.unsubscribed, 0);
});

test('выключение: флаг гаснет первым, подписка отзывается, сервер уведомляется', async () => {
  const w = world({ permission: 'granted' });
  await w.ctx.pushSubscribe('murmansk');
  w.requests.length = 0;

  await w.ctx.pushUnsubscribe();
  assert.equal(w.flag(), 'off');
  assert.equal(w.unsubscribed, 1);
  assert.deepEqual(w.requests, [{ path: '/unsubscribe', body: { endpoint: ENDPOINT } }]);
});

test('выключение при недоступном сервере всё равно выключает', async () => {
  const w = world({ permission: 'granted', server: { '/unsubscribe': { status: 'network' } } });
  await w.ctx.pushSubscribe('murmansk');
  await w.ctx.pushUnsubscribe();
  assert.equal(w.flag(), 'off');
  assert.equal(w.sub, null);
});

test('выключение без подписки не падает', async () => {
  const w = world();
  w.store.set('aurora.push', 'on');
  await w.ctx.pushUnsubscribe();
  assert.equal(w.flag(), 'off');
});

test('синхронизация: выключено — ничего не делает и ни к чему не обращается', async () => {
  const w = world({ permission: 'granted' });
  assert.equal(await w.ctx.pushSync('murmansk'), 'off');
  assert.equal(w.requests.length, 0);
});

test('синхронизация: сообщает серверу актуальную точку', async () => {
  const w = world({ permission: 'granted' });
  await w.ctx.pushSubscribe('murmansk');
  w.requests.length = 0;

  assert.equal(await w.ctx.pushSync('kandalaksha'), 'ok');
  assert.deepEqual(w.requests, [{ path: '/subscribe', body: { endpoint: ENDPOINT, point: 'kandalaksha' } }]);
});

test('синхронизация: браузер потерял подписку — оформляется заново без вопросов', async () => {
  const w = world({ permission: 'granted' });
  await w.ctx.pushSubscribe('murmansk');
  w.sub = null;                                   // очистили данные сайта, подписка пропала
  w.subscribeCalls = 0;

  assert.equal(await w.ctx.pushSync('murmansk'), 'ok');
  assert.equal(w.subscribeCalls, 1);
  assert.ok(w.sub);
});

test('синхронизация: разрешение отозвали — «включено» гаснет', async () => {
  const w = world({ permission: 'granted' });
  await w.ctx.pushSubscribe('murmansk');
  w.permission = 'denied';

  assert.equal(await w.ctx.pushSync('murmansk'), 'revoked');
  assert.equal(w.flag(), 'off');
  assert.equal(w.ctx.pushIsActive(), false);
});

test('синхронизация: сервер недоступен — «error», а включённость не теряется', async () => {
  const w = world({ permission: 'granted' });
  await w.ctx.pushSubscribe('murmansk');
  w.ctx.fetch = async () => { throw new TypeError('Failed to fetch'); };

  assert.equal(await w.ctx.pushSync('murmansk'), 'error');
  assert.equal(w.flag(), 'on', 'сеть пропала не навсегда — повторим при следующем открытии');
});

test('пробное уведомление: адрес подписки и задержка уходят на сервер', async () => {
  const w = world({ permission: 'granted' });
  await w.ctx.pushSubscribe('murmansk');
  w.requests.length = 0;

  await w.ctx.pushTest(20);
  assert.deepEqual(w.requests, [{ path: '/test', body: { endpoint: ENDPOINT, delay: 20 } }]);
  await w.ctx.pushTest();
  assert.equal(w.requests[1].body.delay, 0);
});

test('пробное уведомление без подписки — понятная ошибка, а не обращение к серверу', async () => {
  const w = world({ permission: 'granted' });
  await assert.rejects(() => w.ctx.pushTest(0), e => e.code === 'not_subscribed');
  assert.equal(w.requests.length, 0);
});

test('ошибки сервера несут код и статус: слишком часто, нет подписки', async () => {
  const w = world({ permission: 'granted', server: { '/test': { status: 429, json: { error: 'too_often' } } } });
  await w.ctx.pushSubscribe('murmansk');
  await assert.rejects(() => w.ctx.pushTest(0), e => e.code === 'too_often' && e.status === 429);
});

test('проверка сервера: отвечает — true, недоступен или не 200 — false', async () => {
  const w = world();
  w.ctx.fetch = async () => new Response('{"ok":true}', { status: 200 });
  assert.equal(await w.ctx.pushHealth(), true);
  w.ctx.fetch = async () => new Response('x', { status: 500 });
  assert.equal(await w.ctx.pushHealth(), false);
  w.ctx.fetch = async () => { throw new TypeError('offline'); };
  assert.equal(await w.ctx.pushHealth(), false);
});

test('браузер не отвечает на подписку — по таймауту понятная ошибка, а не вечное ожидание', async () => {
  const w = world();
  w.subscribeHangs = true;
  w.ctx.PUSH_SUBSCRIBE_TIMEOUT_MS = 40;

  const started = Date.now();
  await assert.rejects(() => w.ctx.pushSubscribe('murmansk'), e => e.code === 'subscribe_timeout');
  assert.ok(Date.now() - started < 1000);
  assert.equal(w.requests.length, 0, 'на сервер ничего не ушло');
  assert.equal(w.flag(), null);
});
