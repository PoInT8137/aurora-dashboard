// Собирает map.js — схему Мурманской области для вкладки «Карта» — из данных Natural Earth
// (общественное достояние). Нужен один раз и при смене рамки карты; странице не нужен.
//
//   node tools/build-map.mjs ne_10m_admin_1_states_provinces.geojson ne_10m_lakes.geojson
//
// Файлы берутся из https://github.com/nvkelso/natural-earth-vector (папка geojson).
// Проекция — равнопромежуточная с масштабом по долготе cos(lat0): на рамке в 2,7° широты
// искажение меньше процента, а формула проста настолько, что страница повторяет её сама.
import fs from 'node:fs';

const [adminPath, lakesPath] = process.argv.slice(2);
if (!adminPath || !lakesPath) {
  console.error('использование: node tools/build-map.mjs <admin_1.geojson> <lakes.geojson>');
  process.exit(1);
}

// Рамка: район семи точек с запасом. Вся область (до 41,5° в. д.) вышла бы вдвое шире,
// и на телефоне точки слиплись бы в пятую часть карты. Здесь почти квадрат: берег Баренцева
// моря с Териберкой вверху, Кандалакшский залив внизу.
const FRAME = { lonMin: 30.6, lonMax: 37.4, latMin: 66.75, latMax: 69.45, lat0: 68.1 };
const WIDTH = 1000;
const K = WIDTH / ((FRAME.lonMax - FRAME.lonMin) * Math.cos(FRAME.lat0 * Math.PI / 180));
const HEIGHT = Math.round((FRAME.latMax - FRAME.latMin) * K);

const project = ([lon, lat]) => [
  (lon - FRAME.lonMin) * Math.cos(FRAME.lat0 * Math.PI / 180) * K,
  (FRAME.latMax - lat) * K
];

/** Отсечение многоугольника прямоугольником (Сазерленд — Ходжман), с запасом за краем. */
function clip(ring) {
  const PAD = 20;
  const edges = [
    [p => p[0] >= -PAD, (a, b) => cut(a, b, 0, -PAD)],
    [p => p[0] <= WIDTH + PAD, (a, b) => cut(a, b, 0, WIDTH + PAD)],
    [p => p[1] >= -PAD, (a, b) => cut(a, b, 1, -PAD)],
    [p => p[1] <= HEIGHT + PAD, (a, b) => cut(a, b, 1, HEIGHT + PAD)]
  ];
  function cut(a, b, axis, value) {
    const t = (value - a[axis]) / (b[axis] - a[axis]);
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
  let out = ring;
  for (const [inside, intersect] of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i], prev = input[(i + input.length - 1) % input.length];
      if (inside(cur)) {
        if (!inside(prev)) out.push(intersect(prev, cur));
        out.push(cur);
      } else if (inside(prev)) {
        out.push(intersect(prev, cur));
      }
    }
    if (!out.length) break;
  }
  return out;
}

/** Упрощение Дугласа — Пекера: точки ближе tol к хорде выбрасываются. */
function simplify(points, tol) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let max = 0, index = -1;
    const [ax, ay] = points[a], [bx, by] = points[b];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((by - ay) * points[i][0] - (bx - ax) * points[i][1] + bx * ay - by * ax) / len;
      if (d > max) { max = d; index = i; }
    }
    if (max > tol) { keep[index] = 1; stack.push([a, index], [index, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

const area = ring => Math.abs(ring.reduce((sum, p, i) => {
  const q = ring[(i + 1) % ring.length];
  return sum + p[0] * q[1] - q[0] * p[1];
}, 0)) / 2;

const polygons = geometry => (geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates);

/** Внешние контуры фигур в рамке → строка пути SVG. Мелкие островки и озёра отбрасываются. */
function toPath(features, { tol, minArea }) {
  const parts = [];
  for (const feature of features) {
    for (const polygon of polygons(feature.geometry)) {
      const ring = clip(polygon[0].map(project));
      if (ring.length < 3) continue;
      // У замкнутого кольца начало совпадает с концом, и хорда вырождается в точку: режем
      // кольцо по самой далёкой от начала точке и упрощаем половины по отдельности.
      let far = 0;
      ring.forEach((p, i) => { if (Math.hypot(p[0] - ring[0][0], p[1] - ring[0][1]) > Math.hypot(ring[far][0] - ring[0][0], ring[far][1] - ring[0][1])) far = i; });
      const simple = simplify(ring.slice(0, far + 1), tol).concat(simplify(ring.slice(far).concat([ring[0]]), tol).slice(1, -1));
      if (simple.length < 3 || area(simple) < minArea) continue;
      parts.push('M' + simple.map(p => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('L') + 'Z');
    }
  }
  return parts.join('');
}

const inFrame = feature => polygons(feature.geometry).some(polygon => {
  const lons = polygon[0].map(c => c[0]), lats = polygon[0].map(c => c[1]);
  return Math.max(...lons) >= FRAME.lonMin && Math.min(...lons) <= FRAME.lonMax &&
    Math.max(...lats) >= FRAME.latMin && Math.min(...lats) <= FRAME.latMax;
});

const admin = JSON.parse(fs.readFileSync(adminPath, 'utf8')).features.filter(inFrame);
const lakes = JSON.parse(fs.readFileSync(lakesPath, 'utf8')).features.filter(inFrame);

const region = toPath(admin.filter(f => f.properties.iso_3166_2 === 'RU-MUR'), { tol: 1.2, minArea: 25 });
const land = toPath(admin.filter(f => f.properties.iso_3166_2 !== 'RU-MUR'), { tol: 1.5, minArea: 25 });
const water = toPath(lakes, { tol: 0.9, minArea: 30 });

const code = `/* Схема Мурманской области для вкладки «Карта».
   Собрано скриптом tools/build-map.mjs из данных Natural Earth (общественное достояние):
   контуры упрощены и отсечены рамкой. Вручную не править — пересобрать скриптом. */
'use strict';

var REGION_MAP = {
  width: ${WIDTH},
  height: ${HEIGHT},
  lonMin: ${FRAME.lonMin}, lonMax: ${FRAME.lonMax}, latMin: ${FRAME.latMin}, latMax: ${FRAME.latMax}, lat0: ${FRAME.lat0},
  region: '${region}',
  land: '${land}',
  lakes: '${water}'
};

/** Широта и долгота → положение на карте в долях ширины и высоты (0..1). Та же проекция, что при сборке. */
function mapPosition(lat, lon) {
  var m = REGION_MAP;
  var scale = Math.cos(m.lat0 * Math.PI / 180);
  return {
    x: (lon - m.lonMin) * scale / ((m.lonMax - m.lonMin) * scale),
    y: (m.latMax - lat) / (m.latMax - m.latMin)
  };
}
`;

fs.writeFileSync(new URL('../map.js', import.meta.url), code.replace(/\r?\n/g, '\n'));
console.log(`map.js: ${WIDTH}×${HEIGHT}, область ${region.length} симв., соседи ${land.length}, озёра ${water.length}; всего ${code.length} байт`);
