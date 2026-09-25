/* Service worker дашборда северного сияния.
 *
 * Кэшируется только оболочка приложения и по стратегии cache-first.
 * Данные NOAA SWPC и Open-Meteo не кэшируются вообще: их свежесть уже
 * обеспечивает localStorage со своей отсечкой в три часа и пометкой возраста,
 * а два кэша с разными правилами устаревания давали бы противоречивые
 * показания. Запросы к ним просто не перехватываются — без respondWith
 * браузер отправляет их в сеть сам.
 */
'use strict';

// Адрес сервера уведомлений. Файл общий со страницей; если его не удалось загрузить,
// service worker всё равно должен запуститься: остальное приложение от него не зависит.
try { importScripts('config.js'); } catch (e) { /* без настроек push просто не работает */ }

/* При изменении файлов оболочки поднять версию: имя кэша сменится, install
 * загрузит файлы заново, а activate удалит предыдущую версию. */
var CACHE_VERSION = 'v41';
var CACHE_NAME = 'aurora-' + CACHE_VERSION;

var APP_SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'js/base.js',
  'js/places.js',
  'js/reports.js',
  'js/now.js',
  'js/night.js',
  'js/tonight.js',
  'js/history.js',
  'js/map-tab.js',
  'js/clouds.js',
  'js/notify.js',
  'js/page.js',
  'js/share.js',
  'js/settings.js',
  'core.js',
  'map.js',
  'splash.js',
  'vendor/qrcode.js',
  'i18n.js',
  'lang/ru.js',
  'lang/en.js',
  'lang/zh.js',
  'config.js',
  'push.js',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      // cache: 'reload' — мимо HTTP-кэша браузера. ?v=<версия> — мимо кэша CDN GitHub Pages:
      // он держит файлы до 10 минут, и новый sw.js мог приехать раньше остальных файлов —
      // тогда в кэш новой версии легли бы старые копии и остались там до следующей версии
      // (так было с v39). Хранится файл под обычным адресом, без метки.
      return Promise.all(APP_SHELL.map(function (path) {
        var url = new URL(path, self.registration.scope).href;
        var fresh = url + (url.indexOf('?') < 0 ? '?' : '&') + 'v=' + CACHE_VERSION;
        return fetch(new Request(fresh, { cache: 'reload' }))
          .then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status + ' для ' + path);
            return cache.put(url, response);
          });
      }));
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (name) {
        // Свои кэши прошлых версий удаляем, чужие не трогаем.
        if (name.indexOf('aurora-') === 0 && name !== CACHE_NAME) {
          return caches.delete(name);
        }
        return null;
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;

  // Не наше дело: методы кроме GET и любые чужие источники (NOAA, Open-Meteo).
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then(function (cached) {
      if (cached) return cached;

      return fetch(request).catch(function () {
        // Сети нет и в кэше ничего нет. Для навигации отдаём оболочку —
        // иначе приложение не открылось бы вовсе.
        if (request.mode === 'navigate') {
          return caches.match(new URL('index.html', self.registration.scope).href);
        }
        return Response.error();
      });
    })
  );
});

/* Нажатие на уведомление: открыть приложение или вернуть фокус открытому. */
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || self.registration.scope;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (windows) {
      for (var i = 0; i < windows.length; i++) {
        if (windows[i].url.indexOf(self.registration.scope) === 0 && 'focus' in windows[i]) {
          return windows[i].focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});

/**
 * Пришёл push. Полезной нагрузки в нём нет (сервер шлёт пустой push), поэтому текст
 * запрашиваем у сервера сами. Если сервер недоступен — показываем общее уведомление:
 * браузеры требуют показывать уведомление на каждый push, иначе покажут своё.
 */
self.addEventListener('push', function (event) {
  event.waitUntil(showPushNotification());
});

/* Общий текст на случай, когда сервер не ответил. Выбранный на сайте язык воркеру недоступен
   (localStorage у него нет), поэтому ориентируемся на язык браузера; уведомление,
   которое собрал сам сервер, приходит уже на языке подписки. */
var FALLBACK_TEXT = {
  ru: { title: 'Возможно северное сияние', body: 'Условия для наблюдения изменились — откройте приложение.' },
  en: { title: 'Northern lights possible', body: 'Viewing conditions have changed — open the app.' },
  zh: { title: '可能出现极光', body: '观测条件已发生变化——请打开应用查看。' }
};

function browserLang() {
  var tag = String((self.navigator && self.navigator.language) || '').toLowerCase();
  if (tag.indexOf('ru') === 0) return 'ru';
  if (tag.indexOf('zh') === 0) return 'zh';
  return 'en';
}

function showPushNotification() {
  var api = (typeof AURORA_CONFIG !== 'undefined' && AURORA_CONFIG.pushApi) || '';
  var lang = browserLang();
  var fallback = FALLBACK_TEXT[lang];

  return self.registration.pushManager.getSubscription()
    .then(function (subscription) {
      if (!subscription || !api) return null;
      return fetch(api + '/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
        cache: 'no-store'
      }).then(function (res) { return res.ok ? res.json() : null; });
    })
    .catch(function () { return null; })
    .then(function (message) {
      var msg = message || fallback;

      return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (windows) {
        // Приложение открыто и перед глазами — уведомление лишнее. Пробное показываем
        // всегда: человек как раз проверяет, что оно доходит.
        var inFront = windows.some(function (w) { return w.visibilityState === 'visible' && w.focused; });
        if (inFront && !msg.test) return null;

        var icon = new URL('icons/icon-192.png', self.registration.scope).href;
        return self.registration.showNotification(msg.title, {
          body: msg.body,
          icon: icon,
          badge: icon,
          lang: msg.lang || lang,
          tag: msg.test ? 'aurora-test' : 'aurora-high',
          renotify: true,
          data: { url: self.registration.scope + '#now' }
        });
      });
    });
}
