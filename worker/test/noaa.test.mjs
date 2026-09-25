// Данные NOAA для страницы (GET /noaa/<имя>): вырезки тяжёлых файлов дают тот же результат,
// что и полные; только со страницы сайта; память и запасная копия при сбое NOAA.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/api.js';
import { trimRtsw, trimOvation, clearNoaaCache, SOURCES, STALE_KEEP_MS } from '../src/noaa.js';
import '../../core.js';
import { makeEnv, apiRequest, fakeCtx, NIGHT, MIN, ORIGIN } from './helpers.mjs';

const Core = globalThis.AuroraCore;

/** Ряд RTSW как у NOAA: новые сверху, три спутника вперемешку, лишние поля, сутки данных. */
function rtswText(now) {
  const rows = [];
  for (let m = 0; m < 24 * 60; m++) {
    for (const [source, active, bz] of [['IMAP', false, -3], ['SOLAR1', true, -6], ['ACE', false, -2]]) {
      if (source === 'SOLAR1' && m < 40) continue;   // основной спутник молчит 40 минут
      rows.push({ time_tag: new Date(now - m * MIN).toISOString().slice(0, 19), active, source, range: null, sample_size: 60,
        bt: 8, bx_gse: 1, by_gse: 2, bz_gse: 3, bx_gsm: 1, by_gsm: 2, bz_gsm: bz + (m % 7) / 10, max_data_flag: 0 });
    }
  }
  // формат NOAA: пробелы после запятых и двоеточий
  return JSON.stringify(rows).replace(/,"/g, ', "').replace(/":/g, '": ').replace(/\},\{/g, '}, {');
}

function ovationText() {
  const coords = [];
  for (let lon = 0; lon < 360; lon++) for (let lat = -90; lat <= 90; lat++) coords.push([lon, lat, Math.max(0, 40 - Math.abs(lat - 68) * 4 - Math.abs(lon - 33))]);
  return JSON.stringify({ 'Observation Time': new Date(NIGHT - 5 * MIN).toISOString().slice(0, 19) + 'Z', 'Forecast Time': new Date(NIGHT + 50 * MIN).toISOString().slice(0, 19) + 'Z', 'Data Format': '[Longitude, Latitude, Aurora]', coordinates: coords })
    .replace(/,"/g, ', "').replace(/":/g, '": ').replace(/\],\[/g, '], [').replace(/,(-?\d)/g, ', $1');
}

test('солнечный ветер: вырезка — 2 часа всех спутников, итог тот же, что по полному файлу, и в десятки раз меньше', () => {
  const text = rtswText(NIGHT);
  const small = trimRtsw(text, NIGHT);
  assert.ok(small.length < text.length / 20, (text.length / 1024 | 0) + ' КБ → ' + (small.length / 1024 | 0) + ' КБ');
  const full = Core.solarWindSummary(JSON.parse(text), NIGHT);
  const cut = Core.solarWindSummary(JSON.parse(small), NIGHT);
  assert.deepEqual(cut, full);
  assert.equal(cut.source, 'IMAP', 'основной молчит — запасной, как и по полному файлу');
  assert.deepEqual(Object.keys(JSON.parse(small)[0]).sort(), ['active', 'bt', 'bz_gsm', 'source', 'time_tag']);
});

test('OVATION: вырезка вокруг области, вероятности для точек и своих мест те же, что по полной сетке', () => {
  const text = ovationText();
  const small = trimOvation(text);
  assert.ok(small.length < text.length / 20);
  const points = Core.POINTS.concat([{ id: 'sw', lat: 60, lon: 20 }, { id: 'ne', lat: 72, lon: 50 }]);
  assert.deepEqual(Core.ovationSummary(JSON.parse(small), points, NIGHT), Core.ovationSummary(JSON.parse(text), points, NIGHT));
});

async function get(env, name, { origin = ORIGIN, now = NIGHT, fetchFn } = {}) {
  const res = await handleRequest(apiRequest('/noaa/' + name, null, { method: 'GET', origin }), env, fakeCtx(), now, fetchFn);
  return { status: res.status, body: await res.text(), headers: res.headers };
}

function upstream(status = 200, body = '[{"proton_speed": 450}]') {
  const calls = [];
  const fn = async url => { calls.push(String(url)); if (status === 'down') throw new TypeError('down'); return new Response(body, { status }); };
  fn.calls = calls;
  return fn;
}

test('только со страницы сайта; неизвестное имя — 404, без обращения к NOAA', async () => {
  clearNoaaCache();
  const { env } = await makeEnv();
  const f = upstream();
  assert.equal((await get(env, 'sw-speed', { origin: 'https://evil.example', fetchFn: f })).status, 403);
  assert.equal((await get(env, 'sw-speed', { origin: null, fetchFn: f })).status, 403);
  assert.equal((await get(env, '..%2Fjson%2Fsecret', { fetchFn: f })).status, 404);
  assert.equal((await get(env, 'constructor', { fetchFn: f })).status, 404);
  assert.equal(f.calls.length, 0);
});

test('память: в пределах срока — без NOAA; NOAA упал — последняя копия с пометкой X-Stale; совсем нет — 502', async () => {
  clearNoaaCache();
  const { env } = await makeEnv();
  const ok = upstream();
  const first = await get(env, 'sw-speed', { fetchFn: ok });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(ok.calls[0], 'https://services.swpc.noaa.gov/products/summary/solar-wind-speed.json');
  await get(env, 'sw-speed', { fetchFn: ok, now: NIGHT + 30 * 1000 });
  assert.equal(ok.calls.length, 1, 'минута ещё не прошла');

  const down = upstream('down');
  const stale = await get(env, 'sw-speed', { fetchFn: down, now: NIGHT + 10 * MIN });
  assert.deepEqual([stale.status, stale.body, stale.headers.get('X-Stale')], [200, first.body, '1']);
  assert.equal((await get(env, 'sw-speed', { fetchFn: down, now: NIGHT + STALE_KEEP_MS + MIN })).status, 502);
  assert.equal((await get(env, 'kp-forecast', { fetchFn: upstream(500) })).status, 502);
});

test('текстовый прогноз на 27 дней отдаётся как текст; сроки хранения разумные', async () => {
  clearNoaaCache();
  const { env } = await makeEnv();
  const r = await get(env, 'outlook', { fetchFn: upstream(200, ':Issued: 2026 Sep 21') });
  assert.match(r.headers.get('Content-Type'), /^text\/plain/);
  assert.equal(r.body, ':Issued: 2026 Sep 21');
  for (const [name, s] of Object.entries(SOURCES)) assert.ok(s.ttl >= MIN && s.ttl <= 60 * MIN, name);
});
