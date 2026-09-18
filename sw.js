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

/* При изменении файлов оболочки поднять версию: имя кэша сменится, install
 * загрузит файлы заново, а activate удалит предыдущую версию. */
var CACHE_VERSION = 'v7';
var CACHE_NAME = 'aurora-' + CACHE_VERSION;

var APP_SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      // cache: 'reload' — чтобы при смене версии не подхватить старые копии
      // из HTTP-кэша браузера.
      return Promise.all(APP_SHELL.map(function (path) {
        var url = new URL(path, self.registration.scope).href;
        return fetch(new Request(url, { cache: 'reload' }))
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
