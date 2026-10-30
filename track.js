/* Статистика посещений и журнал ошибок страницы — для владельца сайта в Telegram-боте.
 *
 * Посещение: раз за загрузку, через несколько секунд после неё (первый заход не должен ждать),
 * на сервер уходит язык, телефон или компьютер, открыто ли как приложение, первый ли это визит с
 * этого устройства и хост сайта, с которого пришли. Ни cookies, ни идентификаторов: посетителя за
 * сутки сервер считает по обезличенному отпечатку (worker/src/stats.js).
 *
 * Ошибки: необработанные ошибки и отклонённые обещания — текст, файл, строка, стек, версия
 * сайта и вкладка (worker/src/bugs.js). Не больше 5 за загрузку, одинаковые — один раз; ошибки
 * расширений браузера и безымянные «Script error.» не отправляются.
 *
 * Подключается сразу после config.js — раньше остальных скриптов, чтобы ловить и их ошибки.
 * Запросы — text/plain: так браузер не делает предварительный запрос CORS.
 */
(function () {
  'use strict';
  var api = typeof AURORA_CONFIG !== 'undefined' && AURORA_CONFIG.pushApi;
  if (!api || typeof fetch !== 'function' || location.protocol === 'file:') return;
  // Роботы поисковиков выполняют скрипты, но это не посетители, а их «ошибки» — шум
  // (сервер отсеивает их так же, worker/src/stats.js BOT_UA).
  if (navigator.webdriver || /bot\/|crawl|spider|slurp|lighthouse|headless|pagespeed|externalhit|google-|(google|yandex|bing|apple|petal|ahrefs|semrush|mj12|telegram|twitter|duckduck|baidu)[a-z]*bot/i.test(navigator.userAgent || '')) return;

  var MAX_BUGS = 5;
  var sentBugs = {};
  var bugCount = 0;

  function post(path, data) {
    try {
      fetch(api + path, { method: 'POST', body: JSON.stringify(data), keepalive: true, headers: { 'Content-Type': 'text/plain' } })
        .catch(function () { /* учёт второстепенен */ });
    } catch (e) { /* старый браузер */ }
  }
  function version() {
    return typeof APP_VERSION === 'string' ? APP_VERSION : null;
  }
  function lang() {
    return typeof getLang === 'function' ? getLang() : document.documentElement.lang || null;
  }

  /* ---------------- ошибки ---------------- */

  var FOREIGN = /(chrome|moz|safari(-web)?)-extension:|kaspersky|gc\.kis\.|webkit-masked-url/i;

  function reportBug(msg, src, line, col, stack) {
    msg = String(msg || '').slice(0, 300);
    if (!msg || /^Script error\.?$/.test(msg) || bugCount >= MAX_BUGS) return;
    if (FOREIGN.test(String(src || '') + ' ' + String(stack || ''))) return;
    var key = msg + '|' + src + '|' + line;
    if (sentBugs[key]) return;
    sentBugs[key] = true;
    bugCount++;
    post('/bug', {
      msg: msg, src: src ? String(src).slice(0, 300) : null, line: line || null, col: col || null,
      stack: stack ? String(stack).slice(0, 2000) : null, v: version(), page: location.hash.slice(0, 40) || null
    });
  }

  // Сбой источника данных (js/base.js noteMeteoFailure), в тот же журнал, с пометкой src: source.
  // Офлайн-посетителя не считаем: у него не работает ничего, и до сервера сообщение не дойдёт.
  window.reportProblem = function (msg) {
    if (navigator.onLine === false) return;
    reportBug(msg, 'source', null, null, null);
  };

  window.addEventListener('error', function (e) {
    if (!e || e.target !== window && e.target && e.target.nodeType) return;   // не загрузилась картинка и т. п.
    var err = e.error;
    reportBug((err && err.name ? err.name + ': ' : '') + (err && err.message || e.message), e.filename, e.lineno, e.colno, err && err.stack);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    if (!r) return;
    // Сетевые сбои и отмены ожидания — не ошибки кода: о них и так знает мониторинг источников.
    if (r.name === 'AbortError' || r.name === 'TimeoutError' || /Failed to fetch|NetworkError|Load failed|network/i.test(r.message || '')) return;
    reportBug('Promise: ' + (r.name ? r.name + ': ' : '') + (r.message || String(r)), null, null, null, r.stack);
  });

  /* ---------------- посещение ---------------- */

  function sendHit() {
    var fresh = false;
    try {
      fresh = !localStorage.getItem('aurora.seen');
      if (fresh) localStorage.setItem('aurora.seen', String(Date.now()));
    } catch (e) { /* без хранилища — не первый */ }
    var mm = function (q) { return !!(window.matchMedia && window.matchMedia(q).matches); };
    post('/hit', {
      lang: lang(), v: version(), fresh: fresh,
      mobile: mm('(pointer: coarse)') && Math.min(screen.width, screen.height) < 900,
      pwa: mm('(display-mode: standalone)') || navigator.standalone === true,
      ref: document.referrer ? document.referrer.slice(0, 200) : null
    });
  }

  function later() { setTimeout(sendHit, 3000); }
  if (document.readyState === 'complete') later();
  else window.addEventListener('load', later);
})();
