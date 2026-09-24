/* Вкладка «Карта»: точки на схеме из map.js.
   Часть приложения: общие переменные и функции — глобальные, порядок подключения задан
   в index.html (см. js/README.md). */
'use strict';

/* ------------------------------------------------------------------ */
/*  Вкладка «Карта»: семь точек на схеме области, цвет — шанс на ночь. */
/*  Контуры — в map.js (собран из Natural Earth скриптом               */
/*  tools/build-map.mjs). Точки — кнопки поверх схемы: их размер не    */
/*  зависит от масштаба карты, и они доступны с клавиатуры.            */
/* ------------------------------------------------------------------ */

/* С какой стороны от точки подпись: Кировск и Апатиты в 15 км друг от друга — разводим. */
var MAP_LABEL_LEFT = { apatity: true };

/* Подписи морей: где на схеме вода. */
var MAP_SEAS = [
  { key: 'barents', lat: 69.32, lon: 35.8 },
  { key: 'white', lat: 66.9, lon: 33.1 }
];

var mapReady = false;

/** Контуры и подписи морей ставятся один раз: схема от данных не зависит. */
function initMap() {
  if (mapReady || typeof REGION_MAP === 'undefined') return;
  var svg = $('map-svg');
  if (!svg) return;
  svg.setAttribute('viewBox', '0 0 ' + REGION_MAP.width + ' ' + REGION_MAP.height);
  $('map-land').setAttribute('d', REGION_MAP.region);
  $('map-lakes').setAttribute('d', REGION_MAP.lakes);
  // Те же контуры линиями поверх слоя облаков (js/clouds.js).
  var edges = $('map-edges');
  if (edges) {
    edges.setAttribute('viewBox', '0 0 ' + REGION_MAP.width + ' ' + REGION_MAP.height);
    $('map-edge-land').setAttribute('d', REGION_MAP.region);
    $('map-edge-lakes').setAttribute('d', REGION_MAP.lakes);
  }
  $('map').style.setProperty('--map-ratio', REGION_MAP.width + ' / ' + REGION_MAP.height);

  MAP_SEAS.forEach(function (sea) {
    var el = $('map-sea-' + sea.key);
    if (!el) return;
    var pos = mapPosition(sea.lat, sea.lon);
    el.style.left = (pos.x * 100) + '%';
    el.style.top = (pos.y * 100) + '%';
  });
  mapReady = true;
}

/** Окна по точкам, если данные «Куда ехать» уже есть; иначе точки без окон. */
function mapItems() {
  var list = computeAllWindows();
  if (list) return list;
  return allPoints().map(function (point) { return { point: point, window: undefined }; });
}

function renderMap() {
  initMap();
  var box = $('map-markers');
  if (!box) return;
  box.innerHTML = '';

  var items = mapItems();
  var hasData = !!computeAllWindows();
  var selectedId = state.mapPoint || currentPoint().id;

  items.forEach(function (item) {
    var point = item.point;
    var pos = mapPosition(point.lat, point.lon);
    // Своё место за рамкой схемы на карте не показать — оно есть в списке «Куда ехать».
    if (pos.x < 0 || pos.x > 1 || pos.y < 0 || pos.y > 1) return;

    var btn = document.createElement('button');
    btn.type = 'button';
    // Своё место рядом с точкой области: подписи наехали бы друг на друга — его подпись
    // видна, только когда место выбрано (название для скринридера есть всегда).
    var crowded = point.custom && point.id !== selectedId && airKm(point, nearestBuiltin(point)) < 40;
    btn.className = 'mappt' + (MAP_LABEL_LEFT[point.id] ? ' mappt--left' : '') + (point.custom ? ' mappt--custom' : '') +
      (crowded ? ' mappt--quiet' : '') +
      (point.id === currentPoint().id ? ' mappt--current' : '') + (hasData ? '' : ' mappt--nodata');
    btn.style.left = (pos.x * 100) + '%';
    btn.style.top = (pos.y * 100) + '%';
    btn.setAttribute('data-point', point.id);
    btn.setAttribute('aria-pressed', String(point.id === selectedId));
    if (hasData) setTone(btn, placeTone(item.window));

    var dot = document.createElement('span');
    dot.className = 'mappt__dot';
    var name = document.createElement('span');
    name.className = 'mappt__name';
    name.textContent = pointName(point);

    btn.appendChild(dot);
    btn.appendChild(name);
    btn.setAttribute('aria-label', pointName(point) + ', ' +
      (hasData ? mapLevelText(item.window) : t('map.loading')));
    box.appendChild(btn);
  });

  renderMapInfo(items, selectedId, hasData);
  renderMapStatus(hasData);
  renderClouds();
}

/** Словами для скринридера: «высокий шанс», «нет темноты», «нет данных». */
function mapLevelText(win) {
  if (!win) return t('place.no_data');
  return win.polarDay ? t('place.no_dark') : levelWord(win.level);
}

function renderMapStatus(hasData) {
  var status = $('map-status');
  if (!status) return;
  if (hasData && state.tonight.stale) {
    status.textContent = t('stale.line', { lead: t('lead.calc_saved'), age: fmtAge(state.tonight.stale) });
  } else if (hasData) {
    status.textContent = '';
  } else {
    status.textContent = t(state.tonightLoading ? 'map.loading' : 'map.no_data');
  }
}

/** Под картой — подробности выбранной точки и переход к её условиям. */
function renderMapInfo(items, selectedId, hasData) {
  var info = $('map-info');
  if (!info) return;
  info.innerHTML = '';

  var item = items.filter(function (i) { return i.point.id === selectedId; })[0] || items[0];
  renderMapPick();
  if (hasData) {
    info.appendChild(buildPlaceRow(item, false));
  } else {
    var name = document.createElement('p');
    name.className = 'place__name';
    name.textContent = pointName(item.point);
    info.appendChild(name);
  }

  var open = document.createElement('button');
  open.type = 'button';
  open.className = 'btn';
  open.id = 'map-open';
  open.setAttribute('data-point', item.point.id);
  open.textContent = item.point.id === currentPoint().id ? t('map.open_current') : t('map.open', { name: pointName(item.point) });
  info.appendChild(open);
}

/** Режим «выберите место на карте»: подсказка, курсор-прицел, кнопка отмены. */
function renderMapPick() {
  var btn = $('map-pick');
  if (!btn) return;
  var full = userPlaces().length >= PLACES.max;
  if (full) state.mapPick = false;
  btn.hidden = full;
  btn.setAttribute('aria-pressed', String(state.mapPick));
  btn.textContent = t(state.mapPick ? 'map.pick.cancel' : 'map.pick');
  $('map').className = 'map' + (state.mapPick ? ' map--pick' : '');
  $('map-pick-hint').hidden = !state.mapPick;
}

function setMapPick(on) {
  state.mapPick = on;
  renderMapPick();
}

function initMapTab() {
  $('map-pick').addEventListener('click', function () { setMapPick(!state.mapPick); });
  // Нажатие на схему в режиме выбора — координаты этого места в окно «Новое место».
  $('map').addEventListener('click', function (e) {
    if (!state.mapPick) return;
    var rect = $('map').getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    var at = mapLatLon((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
    setMapPick(false);
    openPlaceDialog(at);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.mapPick) setMapPick(false);
  });

  $('map-markers').addEventListener('click', function (e) {
    if (state.mapPick) return;   // в режиме выбора точки-кнопки не перехватывают нажатие
    var btn = e.target.closest ? e.target.closest('[data-point]') : null;
    if (!btn) return;
    state.mapPoint = btn.getAttribute('data-point');
    renderMap();
  });

  // «Смотреть условия»: выбранная на карте точка становится точкой наблюдения.
  $('map-info').addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('#map-open') : null;
    if (!btn) return;
    var id = btn.getAttribute('data-point');
    if (id !== currentPoint().id) {
      $('point').value = id;
      selectPoint(id);
    }
    showTab('now', 'push');
    if (window.scrollTo) window.scrollTo(0, 0);
  });
}
