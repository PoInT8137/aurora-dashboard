/* Клиент сервера уведомлений (worker/): подписка браузера на push.
 *
 * Работает только если в config.js заданы адрес сервера и ключ VAPID, иначе
 * приложение о нём просто не знает. Файл не трогает DOM: интерфейс живёт в
 * app.js, здесь — только подписка, синхронизация и обращения к серверу.
 */
'use strict';

var PUSH_FLAG_KEY = 'aurora.push';

/**
 * Сколько ждать ответа браузера на подписку. Если браузер не может достучаться до
 * своего push-сервиса, subscribe() бывает висит очень долго, а человек всё это
 * время смотрел бы на «Включаем…».
 */
var PUSH_SUBSCRIBE_TIMEOUT_MS = 30000;

function pushConfigured() {
  return typeof AURORA_CONFIG !== 'undefined' &&
    !!AURORA_CONFIG.pushApi && !!AURORA_CONFIG.vapidPublicKey;
}

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** Хранилище может быть недоступно (приватный режим) — тогда просто «выключено». */
function pushFlagOn() {
  try {
    return localStorage.getItem(PUSH_FLAG_KEY) === 'on';
  } catch (e) {
    return false;
  }
}

function setPushFlag(on) {
  try {
    localStorage.setItem(PUSH_FLAG_KEY, on ? 'on' : 'off');
  } catch (e) { /* без хранилища включение не переживёт перезагрузку */ }
}

/** Включены ли уведомления с сервера. Пока они включены, страница сама не уведомляет. */
function pushIsActive() {
  return pushConfigured() && pushFlagOn();
}

/** Ключ VAPID из base64url в байты — в таком виде его ждёт pushManager.subscribe. */
function pushKeyBytes(b64u) {
  var pad = '='.repeat((4 - (b64u.length % 4)) % 4);
  var raw = atob((b64u + pad).replace(/-/g, '+').replace(/_/g, '/'));
  var out = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function pushFail(code, message) {
  var error = new Error(message || code);
  error.code = code;
  return error;
}

/** Запрос к серверу уведомлений: JSON в обе стороны, таймаут, понятные ошибки. */
function pushRequest(path, body) {
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, 12000);

  return fetch(AURORA_CONFIG.pushApi + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: ctrl.signal
  })
    .then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var error = pushFail(data.error || ('http_' + res.status));
          error.status = res.status;
          throw error;
        }
        return data;
      });
    })
    .finally(function () { clearTimeout(timer); });
}

/** Сервер отвечает? Для проверки на вкладке «Уведомления». */
function pushHealth() {
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, 6000);
  return fetch(AURORA_CONFIG.pushApi + '/health', { signal: ctrl.signal, cache: 'no-store' })
    .then(function (res) { return res.ok; }, function () { return false; })
    .finally(function () { clearTimeout(timer); });
}

/**
 * Регистрация service worker. Если он не зарегистрирован вовсе (например, страница
 * открыта по file://), ready не выполнится никогда — ждём не дольше 8 секунд.
 */
function pushRegistration() {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise(function (resolve, reject) {
      setTimeout(function () { reject(pushFail('no_service_worker')); }, 8000);
    })
  ]);
}

/** Разрешение: современный вариант с промисом и старый с колбэком (Safari). */
function pushAskPermission() {
  return new Promise(function (resolve) {
    var result = Notification.requestPermission(resolve);
    if (result && result.then) result.then(resolve);
  });
}

function sameKey(subscription) {
  var current = subscription.options && subscription.options.applicationServerKey;
  if (!current) return true;   // старые браузеры не отдают ключ — считаем, что наш

  var a = new Uint8Array(current);
  var b = pushKeyBytes(AURORA_CONFIG.vapidPublicKey);
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Подписка браузера: существующая, если она наша, иначе новая. Подписка с
 * другим ключом (ключ VAPID сменили) для сервера бесполезна — push по ней
 * отклонялся бы, поэтому её заменяем.
 * Возвращает { subscription, created }.
 */
function pushEnsureSubscription(registration) {
  var subscribe = function () {
    var attempt = registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: pushKeyBytes(AURORA_CONFIG.vapidPublicKey)
    });

    var timer;
    var timeout = new Promise(function (resolve, reject) {
      timer = setTimeout(function () { reject(pushFail('subscribe_timeout')); }, PUSH_SUBSCRIBE_TIMEOUT_MS);
    });

    return Promise.race([attempt, timeout])
      .then(function (subscription) { return { subscription: subscription, created: true }; })
      .finally(function () { clearTimeout(timer); });
  };

  return registration.pushManager.getSubscription().then(function (existing) {
    if (!existing) return subscribe();
    if (sameKey(existing)) return { subscription: existing, created: false };
    return existing.unsubscribe().then(subscribe);
  });
}

/**
 * Включает уведомления: разрешение, подписка браузера, регистрация на сервере.
 * Если сервер подписку не принял, созданная только что браузерная отзывается —
 * иначе браузер считал бы себя подписанным, а уведомления не приходили бы.
 */
function pushSubscribe(pointId) {
  var registration;

  return pushRegistration()
    .then(function (reg) {
      registration = reg;
      return pushAskPermission();
    })
    .then(function (permission) {
      if (permission !== 'granted') throw pushFail('permission_' + permission);
      return pushEnsureSubscription(registration);
    })
    .then(function (result) {
      return pushRequest('/subscribe', pushSubscription(result.subscription.endpoint, pointId))
        .then(function () {
          setPushFlag(true);
          return result.subscription;
        }, function (error) {
          if (!result.created) throw error;
          return result.subscription.unsubscribe().then(
            function () { throw error; },
            function () { throw error; });
        });
    });
}

/**
 * Тело запроса на подписку: адрес, точка и предпочтения страницы — язык уведомления, тихие часы
 * и пояс, по которому они считаются (pushPreferences() из app.js). Без страницы предпочтений
 * нет, и сервер оставляет прежние.
 */
function pushSubscription(endpoint, pointId) {
  var body = { endpoint: endpoint, point: pointId };
  if (typeof pushPreferences === 'function') {
    var preferences = pushPreferences();
    Object.keys(preferences).forEach(function (key) { body[key] = preferences[key]; });
  }
  return body;
}

/** Выключает уведомления. Флаг гасится первым: даже при сбое сети страница снова уведомляет сама. */
function pushUnsubscribe() {
  setPushFlag(false);

  return pushRegistration()
    .then(function (registration) { return registration.pushManager.getSubscription(); })
    .then(function (subscription) {
      if (!subscription) return null;
      var endpoint = subscription.endpoint;
      return subscription.unsubscribe().then(function () {
        // Запись на сервере — best effort: если сервер недоступен, push-сервис
        // ответит 410 на первую же отправку, и запись удалится сама.
        return pushRequest('/unsubscribe', { endpoint: endpoint }).catch(function () { return null; });
      });
    });
}

/**
 * Синхронизация при открытии приложения и смене точки: сообщает серверу
 * актуальную точку и чинит потерянную подписку. Результат:
 *   'off' — выключено, 'revoked' — разрешение отозвано, 'ok' — всё в порядке,
 *   'error' — сервер недоступен (повторим при следующем открытии).
 */
function pushSync(pointId) {
  if (!pushConfigured() || !pushSupported() || !pushFlagOn()) return Promise.resolve('off');

  // Разрешение отозвали в настройках браузера — включённым больше не считаем.
  if (Notification.permission !== 'granted') {
    setPushFlag(false);
    return Promise.resolve('revoked');
  }

  return pushRegistration()
    .then(pushEnsureSubscription)   // потерянную подписку оформляем заново: разрешение уже есть
    .then(function (result) {
      return pushRequest('/subscribe', pushSubscription(result.subscription.endpoint, pointId));
    })
    .then(function () { return 'ok'; }, function () { return 'error'; });
}

/** Пробное уведомление с сервера; delaySeconds — чтобы успеть закрыть приложение. */
function pushTest(delaySeconds) {
  return pushRegistration()
    .then(function (registration) { return registration.pushManager.getSubscription(); })
    .then(function (subscription) {
      if (!subscription) throw pushFail('not_subscribed');
      return pushRequest('/test', { endpoint: subscription.endpoint, delay: delaySeconds || 0 });
    });
}
