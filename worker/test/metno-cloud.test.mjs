// Второе мнение об облаках: /metno/cloud. Округление координат, копия на полчаса, запас при сбое.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudQuery, cloudSeries, metnoCloud, clearMetnoCloudCache, METNO_CLOUD_TTL_MS } from '../src/metno.js';

const HOUR = 3600000;
const NOW = Date.UTC(2026, 9, 29, 20, 40);

function met(hours = 60, step = 1) {
  const start = Math.floor(NOW / HOUR) * HOUR - HOUR;
  return {
    properties: {
      timeseries: Array.from({ length: hours }, (_, h) => ({
        time: new Date(start + h * step * HOUR).toISOString().replace('.000', ''),
        data: { instant: { details: { cloud_area_fraction: 10 + h + 0.4 } } }
      }))
    }
  };
}

const ok = body => async () => new Response(JSON.stringify(body), { status: 200 });

test('координаты проверяются и округляются до 0,01°', () => {
  assert.deepEqual(cloudQuery('?lat=68.9678&lon=33.0992'), { lat: 68.97, lon: 33.1 });
  assert.equal(cloudQuery('?lat=68.9&lon='), null);
  assert.equal(cloudQuery('?lat=95&lon=33'), null);
  assert.equal(cloudQuery('?lat=68.9;drop&lon=33'), null);
});

test('ряд: с начала текущего часа, не дальше 48 часов, целые проценты', () => {
  const out = cloudSeries(met(), NOW);
  assert.equal(out.model, 'MET Norway');
  assert.equal(out.hours[0][0], Math.floor(NOW / HOUR) * HOUR / 1000);
  assert.equal(out.hours[0][1], 11);
  assert.equal(out.hours.length, 48);
});

test('одна копия на место на полчаса, при сбое MET отдаётся прежняя копия, без неё 502', async () => {
  clearMetnoCloudCache();
  const calls = [];
  const fetchFn = async (url, init) => { calls.push({ url, init }); return ok(met())(); };
  const [body, status] = await metnoCloud('?lat=68.9678&lon=33.0992', NOW, fetchFn);
  assert.equal(status, 200);
  assert.match(calls[0].url, /compact\?lat=68\.97&lon=33\.1$/);
  assert.match(calls[0].init.headers['User-Agent'], /auroramurmansk\.ru/);
  await metnoCloud('?lat=68.971&lon=33.104', NOW + 60000, fetchFn);
  assert.equal(calls.length, 1, 'соседний запрос из той же копии');

  const down = async () => { throw new TypeError('down'); };
  const [again, s2] = await metnoCloud('?lat=68.97&lon=33.1', NOW + METNO_CLOUD_TTL_MS + 1, down);
  assert.equal(s2, 200);
  assert.equal(again, body);
  const [, s3] = await metnoCloud('?lat=67.1&lon=32.4', NOW, down);
  assert.equal(s3, 502);
  const [, s4] = await metnoCloud('?lat=x&lon=1', NOW, down);
  assert.equal(s4, 400);
});
