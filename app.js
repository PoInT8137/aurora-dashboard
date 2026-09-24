/* Дашборд северного сияния — Мурманская область. Точка входа: запуск и регистрация
   service worker. Сам код приложения — в js/*.js (порядок подключения — в index.html),
   расчёты — в core.js. Чистый JS, без зависимостей и сборки. */
'use strict';

function init() {
  // До появления выбора точки облачность лежала в общем ключе. У тех, кто
  // заходил раньше, он остался мусором — убираем при первом же запуске.
  cacheDrop('cloud');

  initLanguage();
  applyAppearance();
  initSettings();
  initPointSelect();
  initPlaces();
  initMapTab();
  initClouds();
  initNightChart();
  initShare();
  initNotifications();
  initNotifyTab();
  initPushCard();
  initTabs();
  $('refresh').addEventListener('click', refreshAll);

  // Кнопки «Повторить» внутри карточек перезагружают только свой блок.
  document.addEventListener('click', function (e) {
    var target = e.target.closest ? e.target.closest('[data-retry]') : null;
    if (!target) return;
    var what = target.getAttribute('data-retry');
    if (what === 'tonight')  loadTonight();
    if (what === 'kp')       loadKp().then(renderDerived);
    if (what === 'cloud')    loadCloud().then(renderDerived);
    if (what === 'forecast') loadForecast().then(renderDerived);
    if (what === 'sw')       loadSolarWind().then(renderDerived);
    if (what === 'ov')       loadOvation(true);
    if (what === 'outlook')  loadOutlook(true);
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

    if (document.visibilityState === 'visible' && refreshDue()) refreshAll();
  });
}

/**
 * Регистрация service worker: он кэширует оболочку приложения, чтобы дашборд
 * открывался без сети. Работает только по http(s), с file:// молча пропускаем.
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;

  try {
    navigator.serviceWorker.register('sw.js').catch(function (err) {
      // Офлайн-режим необязателен: без него дашборд работает как обычная страница.
      console.warn('Service worker не зарегистрирован:', err.message);
    });
  } catch (e) { /* см. выше */ }
}

document.addEventListener('DOMContentLoaded', init);
window.addEventListener('load', registerServiceWorker);
