// Свои места наблюдения: геомагнитная широта, разбор координат, проверка района, хранение,
// список точек, окно добавления, выбор на карте, удаление, «Куда ехать» и уведомления.
// Запуск: node --test tools/places.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadApp } from './app-sandbox.mjs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const plain = v => JSON.parse(JSON.stringify(v));

const element = (tag = 'div') => ({
  tagName: tag.toUpperCase(), textContent: '', hidden: false, disabled: false, className: '', type: '', id: '',
  value: '', label: '', open: false,
  style: { setProperty(k, v) { this[k] = v; } },
  children: [], attrs: {}, listeners: {},
  setAttribute(k, v) { this.attrs[k] = String(v); },
  getAttribute(k) { return this.attrs[k] ?? null; },
  removeAttribute(k) { delete this.attrs[k]; },
  addEventListener(type, fn) { this.listeners[type] = fn; },
  querySelector() { return element(); },
  querySelectorAll() { return []; },
  getBoundingClientRect() { return { left: 0, top: 0, width: 500, height: 500 }; },
  appendChild(child) { this.children.push(child); return child; },
  showModal() { this.open = true; },
  close() { this.open = false; },
  focus() {},
  set innerHTML(value) { if (value === '') this.children = []; },
  get innerHTML() { return ''; }
});

function page({ now = '2026-12-15T18:00:00Z', places, fetch, geolocation } = {}) {
  const elements = new Map();
  const getElement = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const ctx = loadApp(
    [['config.js', read('config.js')], ['core.js', read('core.js')], ['push.js', read('push.js')], ['app.js', read('app.js')]],
    { now: Date.parse(now), getElement, createElement: tag => element(tag), fetch: fetch || (() => new Promise(() => {})) });
  if (places) ctx.localStorage.setItem('aurora.places', JSON.stringify(places));
  if (geolocation) ctx.navigator.geolocation = geolocation;
  ctx.state.point = ctx.findPoint('murmansk');
  return { ctx, el: getElement };
}

/** Опции выпадающего списка: [значение, подпись] с учётом группы «Мои места». */
const options = el => el('point').children.flatMap(c => (c.tagName === 'OPTGROUP'
  ? c.children.map(o => [o.value, o.textContent, c.label]) : [[c.value, c.textContent]]));

/* ---------------- расчёт ---------------- */

test('геомагнитная широта своего места — по той же формуле, что у семи точек области', () => {
  const { ctx } = page();
  for (const p of ctx.POINTS) assert.equal(ctx.geomagneticLatitude(p.lat, p.lon), p.geoLat, p.id);
  // Териберка севернее Мурманска, но геомагнитно южнее — формула это воспроизводит
  assert.ok(ctx.geomagneticLatitude(69.16, 35.15) < ctx.geomagneticLatitude(68.97, 33.1));
});

test('координаты: запятая и точка, пара в одной строке; мусор — null', () => {
  const { ctx } = page();
  assert.equal(ctx.parseCoord('68,97'), 68.97);
  assert.equal(ctx.parseCoord(' 33.1 '), 33.1);
  assert.equal(ctx.parseCoord('-5'), -5);
  for (const bad of ['', 'abc', '68,9,7', '1e3', '68°', null, undefined]) assert.equal(ctx.parseCoord(bad), null, String(bad));
  assert.deepEqual(plain(ctx.parseCoordPair('68.97, 33.10')), { lat: 68.97, lon: 33.1 });
  assert.deepEqual(plain(ctx.parseCoordPair('68,97 33,10')), { lat: 68.97, lon: 33.1 });
  assert.deepEqual(plain(ctx.parseCoordPair('68.97;33.1')), { lat: 68.97, lon: 33.1 });
  assert.equal(ctx.parseCoordPair('68.97'), null);
});

test('район: север от 60° до 72° и от 20° до 50° в. д.; границы включены', () => {
  const { ctx } = page();
  assert.equal(ctx.placeError(68.9, 33), null);
  assert.equal(ctx.placeError(60, 20), null);
  assert.equal(ctx.placeError(72, 50), null);
  assert.equal(ctx.placeError(59.99, 33), 'place.err.region', 'Петербург уже южнее');
  assert.equal(ctx.placeError(68, 55), 'place.err.region');
  assert.equal(ctx.placeError(NaN, 33), 'place.err.coords');
  assert.equal(ctx.placeError(null, 33), 'place.err.coords');
});

test('место: геомагнитная широта, расстояние от Мурманска по прямой, засветки и дороги нет', () => {
  const { ctx } = page();
  const p = plain(ctx.makePlace('my-1', 'Озеро', 69.16094, 35.14527));
  assert.equal(p.custom, true);
  assert.equal(p.geoLat, 64.78);
  assert.ok(p.km > 80 && p.km < 100, 'по прямой до Териберки ≈ 90 км: ' + p.km);
  assert.equal(p.light, null);
  assert.equal(p.driveH, null);
  assert.equal(p.lat, 69.1609, 'четыре знака — около 10 м');
  // пороги Kp — как у Териберки
  assert.deepEqual(plain(ctx.kpThresholds(p)), plain(ctx.kpThresholds(ctx.findPoint('teriberka'))));
});

/* ---------------- хранение ---------------- */

test('сохранённые места: испорченные, чужие, повторы и лишние отбрасываются; имя — только текст', () => {
  const { ctx } = page({ places: [
    { id: 'my-1', name: '  Озеро   у дачи ', lat: 68.5, lon: 33.5 },
    { id: 'my-1', name: 'повтор', lat: 68.5, lon: 33.5 },
    { id: 'murmansk', name: 'подмена точки области', lat: 68, lon: 33 },
    { id: 'my-2', name: 'Юг', lat: 45, lon: 33 },
    { id: 'my-3', name: '', lat: 68, lon: 33 },
    null, 'мусор',
    { id: 'my-4', name: '<img src=x onerror=alert(1)>', lat: 68.1, lon: 34 },
    { id: 'my-5', name: 'Б', lat: 68.2, lon: 34 }, { id: 'my-6', name: 'В', lat: 68.3, lon: 34 },
    { id: 'my-7', name: 'Г', lat: 68.4, lon: 34 }, { id: 'my-8', name: 'Д', lat: 68.5, lon: 34 }
  ] });
  const list = plain(ctx.userPlaces());
  assert.deepEqual(list.map(p => p.id), ['my-1', 'my-4', 'my-5', 'my-6', 'my-7'], 'не больше пяти');
  assert.equal(list[0].name, 'Озеро у дачи');
  assert.equal(list[1].name, '<img src=x onerror=alert(1)>', 'хранится как текст, в разметку не попадает');

  const broken = page();
  broken.ctx.localStorage.setItem('aurora.places', '{не json');
  assert.deepEqual(plain(broken.ctx.userPlaces()), []);
});

test('добавление: название по умолчанию, не больше пяти, id не повторяются после удаления, запись в хранилище', () => {
  const { ctx } = page();
  const first = ctx.addPlace('', 68.5, 33.5);
  assert.equal(first.place.name, 'Моё место 1');
  assert.equal(first.place.id, 'my-1');
  assert.equal(ctx.addPlace('Далеко', 55.75, 37.6).error, 'place.err.region');
  for (let i = 0; i < 4; i++) ctx.addPlace('Место ' + i, 68 + i / 10, 34);
  assert.equal(ctx.addPlace('Шестое', 68, 34).error, 'place.err.max');

  assert.equal(ctx.removePlace('my-2'), true);
  assert.equal(ctx.removePlace('my-2'), false);
  assert.equal(ctx.addPlace('Новое', 68, 35).place.id, 'my-2', 'свободный id занимается снова');

  const saved = JSON.parse(ctx.localStorage.getItem('aurora.places'));
  assert.equal(saved.length, 5);
  assert.deepEqual(Object.keys(saved[0]).sort(), ['id', 'lat', 'lon', 'name'], 'в хранилище только исходные данные');
  assert.equal(ctx.addPlace('Длинное'.repeat(20), 68, 34).error, 'place.err.max');
  ctx.removePlace('my-5');
  assert.equal(ctx.addPlace('Длинное'.repeat(20), 68, 34).place.name.length, 40);
});

/* ---------------- где участвуют ---------------- */

test('свои места — в общем запросе облачности, в «Куда ехать» и в OVATION; удалённое из кэша не подменяется другой точкой', () => {
  const { ctx } = page({ places: [{ id: 'my-1', name: 'Озеро', lat: 68.5, lon: 33.5 }] });
  assert.equal(ctx.allPoints().length, 8);
  const url = new URL(ctx.allPointsWeatherUrl());
  assert.equal(url.searchParams.get('latitude').split(',').length, 8);
  assert.equal(url.searchParams.get('latitude').split(',')[7], '68.5');

  // ответ на 7 точек при 8 — ошибка, а не сдвиг данных
  assert.throws(() => ctx.readAllPointsHours(new Array(7).fill({ hourly: { time: [] } })), e => e.code === 'points_count');

  ctx.state.tonight = { rows: [{ id: 'murmansk', hours: [] }, { id: 'my-9', hours: [] }, { id: 'my-1', hours: [] }], stale: null };
  const ids = ctx.computeAllWindows().map(i => i.point.id);
  assert.deepEqual(ids.sort(), ['murmansk', 'my-1'].sort(), 'my-9 удалено — пропущено');

  assert.match(read('js/now.js'), /ovationSummary\(data, allPoints\(\), Date\.now\(\)\)/);
});

test('уведомления с сервера для своего места — по ближайшей точке области, и подсказка это говорит', () => {
  const { ctx, el } = page({ places: [{ id: 'my-1', name: 'У Хибин', lat: 67.7, lon: 33.6 }] });
  assert.equal(ctx.pushPoint().id, 'murmansk', 'пока выбрана точка области — она сама');
  ctx.state.point = ctx.pointById('my-1');
  assert.equal(ctx.pushPoint().id, 'kirovsk');
  assert.equal(ctx.nearestBuiltin({ lat: 69.2, lon: 35.3 }).id, 'teriberka');
  assert.equal(ctx.customPushNote(), ' Для места «У Хибин» — по ближайшей точке области, «Кировск».');

  // смена точки переносит подписку на ближайшую точку области
  const src = read('js/page.js');
  assert.match(src, /pushSync\(pushPoint\(\)\.id\)/);
  assert.doesNotMatch(read('js/settings.js') + read('js/notify.js') + src, /pushSync\(currentPoint\(\)\.id\)/, 'нигде не шлём серверу id своего места');
  void el;
});

test('вердикт и строки мест: у своего места нет засветки и дороги, есть «по прямой»', () => {
  const { ctx } = page({ places: [{ id: 'my-1', name: 'Озеро', lat: 68.5, lon: 33.5 }] });
  const place = ctx.pointById('my-1');
  const row = ctx.buildPlaceRow({ point: place, window: null }, false);
  const travel = row.children[3].textContent;
  assert.match(travel, /^своё место · \d+ км от Мурманска по прямой$/);
  assert.doesNotMatch(travel, /засветка/i);
});

/* ---------------- интерфейс ---------------- */

test('список точек: семь точек, группа «Мои места», пункт «Добавить…»; его выбор открывает окно, а не меняет точку', () => {
  const { ctx, el } = page({ places: [{ id: 'my-1', name: 'Озеро', lat: 68.5, lon: 33.5 }] });
  ctx.initPointSelect();
  const opts = options(el);
  assert.equal(opts.length, 9);
  assert.deepEqual(opts[7], ['my-1', 'Озеро', 'Мои места']);
  assert.deepEqual(opts[8], ['__add', '＋ Добавить своё место…']);

  el('point').value = '__add';
  el('point').listeners.change();
  assert.equal(el('place-dialog').open, true);
  assert.equal(el('point').value, 'murmansk', 'выбор вернулся к текущей точке');
  assert.equal(ctx.currentPoint().id, 'murmansk');
});

test('окно: ошибка — текстом и окно открыто; верные координаты — место добавлено и сразу выбрано', () => {
  const { ctx, el } = page();
  ctx.initPointSelect();
  ctx.initPlaces();
  ctx.openPlaceDialog(null);

  el('place-lat').value = 'шестьдесят';
  el('place-lon').value = '33';
  el('place-form').listeners.submit({ preventDefault() {} });
  assert.equal(el('place-status').textContent, 'Введите широту и долготу числами, например 68,97 и 33,10.');
  assert.equal(el('place-dialog').open, true);

  el('place-name').value = 'Озеро';
  el('place-lat').value = '68,5';
  el('place-lon').value = '33,5';
  el('place-form').listeners.submit({ preventDefault() {} });
  assert.equal(el('place-dialog').open, false);
  assert.equal(ctx.currentPoint().id, 'my-1');
  assert.equal(ctx.currentPoint().name, 'Озеро');
  assert.equal(ctx.localStorage.getItem('aurora.point'), 'my-1');
  assert.deepEqual(options(el).find(o => o[0] === 'my-1'), ['my-1', 'Озеро', 'Мои места']);
});

test('обе координаты, вставленные в поле широты, разбираются', () => {
  const { ctx, el } = page();
  ctx.initPointSelect();
  ctx.initPlaces();
  ctx.openPlaceDialog(null);
  el('place-lat').value = '68.97120, 33.07450';
  el('place-lon').value = '';
  el('place-form').listeners.submit({ preventDefault() {} });
  assert.deepEqual([ctx.currentPoint().lat, ctx.currentPoint().lon], [68.9712, 33.0745]);
});

test('«Где я сейчас»: координаты в поля; отказ в доступе — понятный текст; вне района — предупреждение сразу', () => {
  const ok = page({ geolocation: { getCurrentPosition: done => done({ coords: { latitude: 68.123456, longitude: 33.5 } }) } });
  ok.ctx.initPlaces();
  ok.el('place-here').listeners.click();
  assert.equal(ok.el('place-lat').value, '68,1235');
  assert.equal(ok.el('place-lon').value, '33,5000');
  assert.equal(ok.el('place-status').textContent, '');

  const denied = page({ geolocation: { getCurrentPosition: (done, fail) => fail({ code: 1 }) } });
  denied.ctx.initPlaces();
  denied.el('place-here').listeners.click();
  assert.equal(denied.el('place-status').textContent, 'Нет доступа к местоположению — введите координаты вручную.');

  const south = page({ geolocation: { getCurrentPosition: done => done({ coords: { latitude: 55.75, longitude: 37.6 } }) } });
  south.ctx.initPlaces();
  south.el('place-here').listeners.click();
  assert.match(south.el('place-status').textContent, /^Нужно место на севере/);
});

test('карта: «Добавить на карте», нажатие на схему — координаты этого места в окне; Esc отменяет', () => {
  const { ctx, el } = page();
  ctx.initMapTab();
  ctx.initPlaces();
  el('map-pick').listeners.click();
  assert.equal(ctx.state.mapPick, true);
  assert.equal(el('map').className, 'map map--pick');
  assert.equal(el('map-pick-hint').hidden, false);

  // прямоугольник карты 500 × 500, нажатие в центр
  el('map').listeners.click({ clientX: 250, clientY: 250 });
  assert.equal(ctx.state.mapPick, false);
  assert.equal(el('place-dialog').open, true);
  const m = ctx.REGION_MAP;
  assert.equal(el('place-lat').value, ctx.fmtCoordInput((m.latMax + m.latMin) / 2));
  assert.equal(el('place-lon').value, ctx.fmtCoordInput((m.lonMax + m.lonMin) / 2));

  // обратное преобразование точно обращает mapPosition
  const back = ctx.mapPosition(ctx.mapLatLon(0.3, 0.7).lat, ctx.mapLatLon(0.3, 0.7).lon);
  assert.ok(Math.abs(back.x - 0.3) < 1e-4 && Math.abs(back.y - 0.7) < 1e-4);
});

test('удаление выбранного места: выбор переходит на Мурманск, список обновляется', () => {
  const { ctx, el } = page({ places: [{ id: 'my-1', name: 'Озеро', lat: 68.5, lon: 33.5 }] });
  ctx.initPointSelect();
  ctx.initPlaces();
  ctx.selectPoint('my-1');
  assert.equal(el('myplaces-list').children.length, 1);
  assert.equal(el('myplaces-list').children[0].children[1].attrs['aria-label'], 'Удалить место «Озеро»');

  el('myplaces-list').listeners.click({ target: { closest: () => ({ getAttribute: () => 'my-1' }) } });
  assert.equal(ctx.currentPoint().id, 'murmansk');
  assert.equal(el('myplaces-list').children.length, 0);
  assert.equal(el('myplaces-empty').hidden, false);
  assert.equal(options(el).length, 8, 'семь точек и «Добавить…»');
});

test('разметка: окно, раздел в настройках, кнопка на карте; файл в оболочке service worker и после base.js', () => {
  const html = read('index.html');
  for (const id of ['place-dialog', 'place-form', 'place-name', 'place-lat', 'place-lon', 'place-here', 'place-status', 'place-cancel',
    'myplaces-card', 'myplaces-list', 'myplaces-add', 'myplaces-empty', 'myplaces-max', 'map-pick', 'map-pick-hint']) {
    assert.equal(html.split('id="' + id + '"').length, 2, id + ' — ровно один');
  }
  assert.match(html, /id="place-lat" inputmode="decimal"/);
  assert.ok(html.indexOf('src="js/places.js"') > html.indexOf('src="js/base.js"'));
  assert.match(read('sw.js'), /'js\/places\.js'/);
  // шрифт полей не меньше 16px — иначе iPhone увеличивает страницу при вводе
  assert.match(read('styles.css'), /\.field__input \{[^}]*font-size: 16px;/);
});

test('на карте своё место рядом с точкой области не перекрывает её подпись: своя подпись — только у выбранного', () => {
  const { ctx, el } = page({ places: [{ id: 'my-1', name: 'Имандра', lat: 67.95, lon: 33.2 }, { id: 'my-2', name: 'Тундра', lat: 68.6, lon: 36.5 }] });
  ctx.renderMap();
  const marker = id => el('map-markers').children.find(b => b.attrs['data-point'] === id);
  assert.match(marker('my-1').className, /mappt--custom/);
  assert.match(marker('my-1').className, /mappt--quiet/, '14 км до Мончегорска');
  assert.doesNotMatch(marker('my-2').className, /mappt--quiet/, 'далеко от городов — подпись видна');
  assert.equal(marker('my-1').attrs['aria-label'].startsWith('Имандра'), true);
  ctx.state.mapPoint = 'my-1';
  ctx.renderMap();
  assert.doesNotMatch(marker('my-1').className, /mappt--quiet/, 'выбранное — с подписью');
});
