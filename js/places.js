/* Свои места наблюдения: хранятся в браузере и считаются так же, как семь точек области.
   Часть приложения: общие переменные и функции — глобальные, порядок подключения задан
   в index.html (см. js/README.md). */
'use strict';

/* ------------------------------------------------------------------ */
/*  Свои места                                                         */
/*                                                                     */
/*  Место — название и координаты. Всё остальное для расчёта           */
/*  выводится: геомагнитная широта — по той же формуле, что у точек    */
/*  области (geomagneticLatitude в core.js), отсюда и пороги Kp;       */
/*  расстояние — от Мурманска по прямой. Засветку и дорогу мы не       */
/*  знаем — они просто не показываются.                                */
/*                                                                     */
/*  Сервер уведомлений знает только семь точек, поэтому для своего     */
/*  места уведомления с сервера приходят по ближайшей из них.          */
/* ------------------------------------------------------------------ */

var PLACES = {
  max: 5,
  nameMax: 40,
  // Пороги Kp подобраны для высоких широт: южнее и дальше место не принимается.
  latMin: 60, latMax: 72, lonMin: 20, lonMax: 50,
  idPrefix: 'my-'
};

/** Координата из строки: «68,97», «68.97», « 33 » → число; иначе null. */
function parseCoord(text) {
  var s = String(text === undefined || text === null ? '' : text).trim().replace(',', '.');
  if (!/^[-+]?\d{1,3}(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

/** Обе координаты из одной строки — «68.97, 33.10» или «68,97 33,10»; иначе null. */
function parseCoordPair(text) {
  var m = /^\s*([-+]?\d{1,3}(?:[.,]\d+)?)\s*[,;\s]\s*([-+]?\d{1,3}(?:[.,]\d+)?)\s*$/.exec(String(text || ''));
  if (!m) return null;
  var lat = parseCoord(m[1]), lon = parseCoord(m[2]);
  return lat === null || lon === null ? null : { lat: lat, lon: lon };
}

/** Название без управляющих символов и лишних пробелов, не длиннее nameMax. */
function cleanPlaceName(text) {
  return String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, PLACES.nameMax);
}

/** Ошибка ввода — ключ словаря — либо null, если место годится. */
function placeError(lat, lon) {
  if (typeof lat !== 'number' || typeof lon !== 'number' || !isFinite(lat) || !isFinite(lon)) return 'place.err.coords';
  if (lat < PLACES.latMin || lat > PLACES.latMax || lon < PLACES.lonMin || lon > PLACES.lonMax) return 'place.err.region';
  return null;
}

/** Расстояние по прямой, км (гаверсинус). */
function airKm(a, b) {
  var r = Math.PI / 180;
  var dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Точка в том же виде, что точки области (core.js POINTS), плюс custom: true. */
function makePlace(id, name, lat, lon) {
  lat = Math.round(lat * 10000) / 10000;
  lon = Math.round(lon * 10000) / 10000;
  var origin = POINTS[0];
  return {
    id: id,
    custom: true,
    name: name,
    lat: lat,
    lon: lon,
    geoLat: geomagneticLatitude(lat, lon),
    light: null,          // засветка неизвестна — не показывается
    km: Math.max(1, Math.round(airKm(origin, { lat: lat, lon: lon }))),
    driveH: null,
    noteKey: ''
  };
}

/** Сохранённые места; испорченные записи пропускаются, лишние сверх max отбрасываются. */
function loadPlaces() {
  var raw = null;
  try { raw = JSON.parse(localStorage.getItem(CACHE.prefix + 'places') || '[]'); } catch (e) { raw = []; }
  if (!Array.isArray(raw)) return [];
  var out = [];
  var seen = {};
  raw.forEach(function (item) {
    if (!item || typeof item !== 'object' || out.length >= PLACES.max) return;
    var id = String(item.id || '');
    var name = cleanPlaceName(item.name);
    if (id.indexOf(PLACES.idPrefix) !== 0 || seen[id] || !name) return;
    if (placeError(item.lat, item.lon)) return;
    seen[id] = true;
    out.push(makePlace(id, name, item.lat, item.lon));
  });
  return out;
}

function savePlaces() {
  try {
    localStorage.setItem(CACHE.prefix + 'places', JSON.stringify(userPlaces().map(function (p) {
      return { id: p.id, name: p.name, lat: p.lat, lon: p.lon };
    })));
  } catch (e) { /* без хранилища место проживёт до перезагрузки */ }
}

function userPlaces() {
  if (!state.places) state.places = loadPlaces();
  return state.places;
}

/** Все точки: семь точек области и свои места — для списка, «Куда ехать» и карты. */
function allPoints() {
  return POINTS.concat(userPlaces());
}

/** Точка по id — своя или из области; неизвестная — null. */
function findPlace(id) {
  var list = allPoints();
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

/** Точка по id; неизвестная (например, удалённое место) — первая точка области. */
function pointById(id) {
  return findPlace(id) || POINTS[0];
}

/** Ближайшая из семи точек области: по ней для своего места работают уведомления с сервера. */
function nearestBuiltin(point) {
  var best = POINTS[0], bestKm = Infinity;
  POINTS.forEach(function (p) {
    var km = airKm(point, p);
    if (km < bestKm) { best = p; bestKm = km; }
  });
  return best;
}

/** Точка, на которую оформлена подписка на сервере: сама точка или ближайшая к своему месту. */
function pushPoint() {
  var point = currentPoint();
  return point.custom ? nearestBuiltin(point) : point;
}

/**
 * Добавляет место. Возвращает { place } или { error: ключ словаря }.
 * Пустое название — «Моё место N».
 */
function addPlace(name, lat, lon) {
  var list = userPlaces();
  if (list.length >= PLACES.max) return { error: 'place.err.max' };
  var error = placeError(lat, lon);
  if (error) return { error: error };

  var n = 1;
  while (findPlace(PLACES.idPrefix + n)) n++;
  var clean = cleanPlaceName(name) || t('place.default_name', { n: list.length + 1 });
  var place = makePlace(PLACES.idPrefix + n, clean, lat, lon);
  list.push(place);
  savePlaces();
  return { place: place };
}

function removePlace(id) {
  var list = userPlaces();
  var before = list.length;
  state.places = list.filter(function (p) { return p.id !== id; });
  if (state.places.length !== before) savePlaces();
  return state.places.length !== before;
}

/** Доли схемы карты (0..1) → широта и долгота: обратное к mapPosition (проекция линейна). */
function mapLatLon(x, y) {
  var m = REGION_MAP;
  return {
    lat: Math.round((m.latMax - y * (m.latMax - m.latMin)) * 10000) / 10000,
    lon: Math.round((m.lonMin + x * (m.lonMax - m.lonMin)) * 10000) / 10000
  };
}

/* ------------------------------------------------------------------ */
/*  Интерфейс: список точек, окно добавления, раздел в настройках      */
/* ------------------------------------------------------------------ */

var ADD_PLACE = '__add';

/** Выпадающий список: семь точек, «Мои места» и пункт «Добавить своё место…». */
function renderPointOptions() {
  var select = $('point');
  if (!select) return;
  select.innerHTML = '';
  POINTS.forEach(function (point) { select.appendChild(pointOption(point)); });

  var mine = userPlaces();
  if (mine.length) {
    var group = document.createElement('optgroup');
    group.label = t('places.group');
    mine.forEach(function (point) { group.appendChild(pointOption(point)); });
    select.appendChild(group);
  }
  if (mine.length < PLACES.max) {
    var add = document.createElement('option');
    add.value = ADD_PLACE;
    add.textContent = t('places.add_option');
    select.appendChild(add);
  }
  select.value = currentPoint().id;
}

function pointOption(point) {
  var option = document.createElement('option');
  option.value = point.id;
  option.textContent = pointName(point);
  return option;
}

/** Окно «Новое место»; prefill — координаты с карты или null. */
function openPlaceDialog(prefill) {
  var dialog = $('place-dialog');
  if (!dialog) return;
  $('place-name').value = '';
  $('place-lat').value = prefill ? fmtCoordInput(prefill.lat) : '';
  $('place-lon').value = prefill ? fmtCoordInput(prefill.lon) : '';
  setPlaceStatus(null);
  if (dialog.showModal) dialog.showModal();
  else dialog.setAttribute('open', '');
  var first = $('place-name');
  if (first.focus) first.focus();
}

function closePlaceDialog() {
  var dialog = $('place-dialog');
  if (dialog.close) dialog.close();
  else dialog.removeAttribute('open');
}

/** Координата для поля ввода: четыре знака, запятая по-русски. */
function fmtCoordInput(value) {
  return fmtNum(Number(value).toFixed(4));
}

function setPlaceStatus(key, params) {
  $('place-status').textContent = key ? t(key, params) : '';
}

/** Сохранение из окна: проверка, добавление и сразу выбор нового места. */
function submitPlace() {
  var latText = $('place-lat').value, lonText = $('place-lon').value;
  // Обе координаты, вставленные в поле широты, — частый случай при копировании с карт.
  var pair = parseCoordPair(latText);
  if (pair && !String(lonText).trim()) { latText = pair.lat; lonText = pair.lon; }

  var result = addPlace($('place-name').value, parseCoord(latText), parseCoord(lonText));
  if (result.error) {
    setPlaceStatus(result.error, { n: PLACES.max });
    return false;
  }
  closePlaceDialog();
  placesChanged();
  $('point').value = result.place.id;
  selectPoint(result.place.id);
  return true;
}

/** «Где я сейчас»: координаты устройства в поля окна. В браузере они и остаются. */
function locatePlace() {
  if (!navigator.geolocation) { setPlaceStatus('place.dlg.geo_fail'); return; }
  setPlaceStatus('place.dlg.locating');
  navigator.geolocation.getCurrentPosition(function (pos) {
    $('place-lat').value = fmtCoordInput(pos.coords.latitude);
    $('place-lon').value = fmtCoordInput(pos.coords.longitude);
    var error = placeError(pos.coords.latitude, pos.coords.longitude);
    setPlaceStatus(error);
  }, function (err) {
    setPlaceStatus(err && err.code === 1 ? 'place.dlg.geo_denied' : 'place.dlg.geo_fail');
  }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 5 * 60 * 1000 });
}

/**
 * После добавления или удаления: список точек, раздел в настройках, карта. Облачность по всем
 * точкам запрашивается одним запросом, поэтому прежние данные «Куда ехать» не годятся.
 */
function placesChanged() {
  renderPointOptions();
  renderPlacesList();
  cacheDrop('tonight');
  var hadTonight = !!state.tonight;
  state.tonight = null;
  if (hadTonight || state.tab === 'tonight' || state.tab === 'map') loadTonight();
  renderMap();
}

/** Раздел «Мои места» в настройках: список с кнопками удаления. */
function renderPlacesList() {
  var box = $('myplaces-list');
  if (!box) return;
  box.innerHTML = '';
  var mine = userPlaces();
  $('myplaces-empty').hidden = mine.length > 0;
  $('myplaces-add').hidden = mine.length >= PLACES.max;
  $('myplaces-max').hidden = mine.length < PLACES.max;
  $('myplaces-max').textContent = t('place.err.max', { n: PLACES.max });

  mine.forEach(function (place) {
    var item = document.createElement('li');
    item.className = 'myplace';
    var text = document.createElement('div');
    var name = document.createElement('p');
    name.className = 'myplace__name';
    name.textContent = place.name;
    var meta = document.createElement('p');
    meta.className = 'myplace__meta';
    meta.textContent = fmtCoord(place.lat, 'n', 's') + ', ' + fmtCoord(place.lon, 'e', 'w') + t('sep.dot') +
      t('place.air', { dist: distText(place.km) });
    text.appendChild(name);
    text.appendChild(meta);

    var remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn';
    remove.setAttribute('data-remove-place', place.id);
    remove.setAttribute('aria-label', t('places.remove_aria', { name: place.name }));
    remove.textContent = t('places.remove');

    item.appendChild(text);
    item.appendChild(remove);
    box.appendChild(item);
  });
}

function initPlaces() {
  renderPlacesList();

  $('place-form').addEventListener('submit', function (e) {
    e.preventDefault();
    submitPlace();
  });
  $('place-cancel').addEventListener('click', closePlaceDialog);
  $('place-here').addEventListener('click', locatePlace);
  $('myplaces-add').addEventListener('click', function () { openPlaceDialog(null); });

  $('myplaces-list').addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-remove-place]') : null;
    if (!btn) return;
    var id = btn.getAttribute('data-remove-place');
    var wasCurrent = currentPoint().id === id;
    if (!removePlace(id)) return;
    if (state.mapPoint === id) state.mapPoint = null;
    placesChanged();
    // Удалили выбранное место — выбор переходит на первую точку области.
    if (wasCurrent) {
      $('point').value = POINTS[0].id;
      selectPoint(POINTS[0].id);
    }
  });
}
