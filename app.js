/* Дашборд северного сияния — Мурманская область. Точка входа: запуск и регистрация
   service worker. Сам код приложения — в js/*.js (порядок подключения — в index.html),
   расчёты — в core.js. Чистый JS, без зависимостей и сборки. */
'use strict';

function init() {
  // До появления выбора точки облачность лежала в общем ключе. У тех, кто
  // заходил раньше, он остался мусором — убираем при первом же запуске.
  if (typeof cacheDrop === 'function') cacheDrop('cloud');
  // Проверяем перед вызовом: недогруз одного скрипта не роняет всю страницу.
  if (typeof initLanguage === 'function') initLanguage();
  if (typeof applyAppearance === 'function') applyAppearance();
  if (typeof initSettings === 'function') initSettings();
  if (typeof initPointSelect === 'function') initPointSelect();
  if (typeof initPlaces === 'function') initPlaces();
  if (typeof initReports === 'function') initReports();
  if (typeof renderWebcams === 'function') renderWebcams();
  if (typeof initMapTab === 'function') initMapTab();
  if (typeof initClouds === 'function') initClouds();
  if (typeof initNightChart === 'function') initNightChart();
  if (typeof initSolarWindChart === 'function') initSolarWindChart();
  if (typeof initShare === 'function') initShare();
  if (typeof initInstallHint === 'function') initInstallHint();
  if (typeof initNotifications === 'function') initNotifications();
  if (typeof initNotifyTab === 'function') initNotifyTab();
  if (typeof initPushCard === 'function') initPushCard();
  if (typeof initTabs === 'function') initTabs();
  if (typeof initSkyDepth === 'function') initSkyDepth();
  if (typeof initHeroSky === 'function') initHeroSky();
  if (typeof initTopMenu === 'function') initTopMenu();
  if (typeof $ === 'function' && $('refresh')) $('refresh').addEventListener('click', refreshAll);

  // Кнопки «Повторить» внутри карточек перезагружают только свой блок.
  document.addEventListener('click', function (e) {
    var target = e.target.closest ? e.target.closest('[data-retry]') : null;
    if (!target) return;
    var what = target.getAttribute('data-retry');
    // После повтора — и вердикт, и строка статуса: иначе в шапке оставалось «Нет связи».
    var after = function () { renderDerived(); updateStatus(); };
    if (what === 'tonight')  loadTonight(true);
    if (what === 'kp')       loadKp().then(after);
    if (what === 'cloud')    loadCloud().then(after);
    if (what === 'forecast') loadForecast().then(after);
    if (what === 'sw')       loadSolarWind().then(after);
    if (what === 'ov')       loadOvation(true).then(after);
    if (what === 'outlook')  loadOutlook(true);
    if (what === 'history')  loadHistory(true);
  });

  applyLanguage();
  refreshAll();
  armRefresh();

  // Вернулись на вкладку после долгого отсутствия — обновляем сразу.
  document.addEventListener('visibilitychange', function () {
    // Вернулись из настроек браузера — разрешение могло поменяться.
    if (document.visibilityState === 'visible') {
      renderNotifyControl();
      renderNotifyDiagnostics();
    }

    // Таймер заново: иначе он мог сработать через секунды после этого обновления.
    if (document.visibilityState === 'visible' && refreshDue()) { refreshAll(); armRefresh(); }
  });
}

/* Регистрация service worker: оболочка приложения открывается без сети. Только по http(s). */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || (location.protocol !== 'https:' && location.hostname !== 'localhost')) return;
  if (registerServiceWorker.done) return;   // и после загрузки данных, и при включении push
  registerServiceWorker.done = true;
  try {
    // Офлайн-режим необязателен: без него дашборд работает как обычная страница.
    navigator.serviceWorker.register('sw.js').catch(function (err) { console.warn('Service worker не зарегистрирован:', err.message); });
  } catch (e) { /* см. выше */ }
}

/* Слушатели service worker — сразу при загрузке, а не при регистрации (она ждёт до 15 с):
   новый sw.js берёт управление за 1–3 с, и поздний слушатель пропускал controllerchange. */
(function watchServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Новая версия взяла управление (skipWaiting + claim) — одна перезагрузка, чтобы исправления
  // пришли сразу. При первой установке контроллера не было — страница и так свежая.
  var hadController = !!navigator.serviceWorker.controller;
  var reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (!hadController || reloaded) return;
    reloaded = true;
    location.reload();
  });
  // Нажали на уведомление при открытом приложении — sw.js просит показать вкладку из него.
  navigator.serviceWorker.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'show-tab' && typeof showTab === 'function') showTab(e.data.tab, 'push');
  });
  // Установленное приложение возобновляется, а не открывается заново: проверяем версию сами.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible' || !navigator.serviceWorker.getRegistration) return;
    navigator.serviceWorker.getRegistration().then(function (r) { if (r) r.update().catch(function () {}); }, function () {});
  });
})();

document.addEventListener('DOMContentLoaded', init);

/* Service worker при установке заново скачивает все файлы оболочки. При первом заходе на
   медленной сети это отбирало канал у данных — регистрируем, когда первое обновление данных
   закончилось (но не позже чем через 15 секунд). */
window.addEventListener('load', function () {
  var registered = false;
  var go = function () {
    if (registered) return;
    registered = true;
    registerServiceWorker();
  };
  var first = (typeof state !== 'undefined' && state.refreshing) || null;
  if (first) first.then(go, go);
  else go();
  setTimeout(go, 15000);
});
