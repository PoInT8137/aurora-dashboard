// Резерв MET Norway для /meteo: пересборка в формат Open-Meteo, границы резерва, порядок
// «Open-Meteo → MET Norway → последняя копия».
import test from 'node:test';
import assert from 'node:assert/strict';
import { toOpenMeteo, metnoFallback, wmoFromSymbol } from '../src/metno.js';
import { meteoProxy, clearMeteoCache, METEO_TTL_MS, STALE_KEEP_MS } from '../src/meteo.js';
import '../../core.js';

const Core = globalThis.AuroraCore;
const HOUR = 3600000;
const NOW = Date.UTC(2026, 8, 25, 23, 40);

/** Ответ MET Norway: почасовой ряд с часа NOW−1 ч, облачность cloudAt(час от начала). */
function met({ cloudAt = h => 90 - h * 10, symbol = 'cloudy', fog = 0 } = {}) {
  const start = Math.floor(NOW / HOUR) * HOUR - HOUR;
  return {
    properties: {
      timeseries: Array.from({ length: 60 }, (_, h) => ({
        time: new Date(start + h * HOUR).toISOString().replace('.000', ''),
        data: {
          instant: { details: { air_temperature: 11.3, apparent_air_temperature: 9.9, cloud_area_fraction: cloudAt(h), cloud_area_fraction_low: 5, cloud_area_fraction_medium: 5,
            cloud_area_fraction_high: 5, fog_area_fraction: fog, relative_humidity: 97.5, wind_from_direction: 191, wind_speed: 3.3, wind_speed_of_gust: 5.5 } },
          next_1_hours: { summary: { symbol_code: symbol }, details: { precipitation_amount: symbol.includes('rain') || symbol.includes('snow') ? 1.2 : 0 } }
        }
      }))
    }
  };
}

const WEATHER = 'https://api.open-meteo.com/v1/forecast?latitude=68.9678&longitude=33.0992&current=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,temperature_2m,apparent_temperature,wind_speed_10m,wind_gusts_10m,wind_direction_10m,precipitation,rain,snowfall,weather_code,visibility,relative_humidity_2m&hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high&models=icon_eu&forecast_days=2&timezone=UTC';

test('символы MET Norway → коды ВМО, которые читает страница', () => {
  const cases = { clearsky_night: 0, fair_day: 1, partlycloudy_night: 2, cloudy: 3, fog: 45, lightrain: 61, rain: 63, heavyrainshowers_day: 65,
    lightsnow: 71, heavysnow: 75, sleet: 66, rainandthunder: 95, '': null };
  for (const [symbol, code] of Object.entries(cases)) assert.equal(wmoFromSymbol(symbol), code, symbol);
});

test('пересборка: «сейчас» — текущий час, только общая облачность (ярусы MET противоречивы), ветер в км/ч как у Open-Meteo', () => {
  const params = new URL(WEATHER).searchParams;
  const out = toOpenMeteo(met(), 68.9678, 33.0992, params, NOW);
  assert.equal(out.generator, 'MET Norway');
  assert.equal(out.current.time, '2026-09-25T23:00');
  assert.equal(out.current.cloud_cover, 80);
  assert.deepEqual([out.current.cloud_cover_low, out.current.cloud_cover_mid, out.current.cloud_cover_high], [null, null, null]);
  assert.ok(Math.abs(out.current.wind_speed_10m - 11.88) < 1e-9);
  assert.equal(out.current.weather_code, 3);
  assert.equal(out.current.visibility, null);
  // страница считает облачность по общей, как без ярусов
  const cloud = Core.cloudFromCurrent(out.current);
  assert.deepEqual([cloud.value, cloud.byLayers], [80, false]);
  // почасовой ряд — от начала текущего часа, 48 часов
  assert.equal(out.hourly.time[0], '2026-09-25T23:00');
  assert.equal(out.hourly.time.length, 48);
  assert.deepEqual(out.hourly.cloud_cover.slice(0, 3), [80, 70, 60]);
  assert.ok(out.hourly.cloud_cover_low.every(v => v === null));
});

test('осадки и туман: снег — в snowfall, дождь — в rain, густой туман — видимость 500 м', () => {
  const params = new URL(WEATHER).searchParams;
  const snow = toOpenMeteo(met({ symbol: 'heavysnow' }), 1, 1, params, NOW).current;
  assert.deepEqual([snow.snowfall, snow.rain, snow.weather_code], [1.2, 0, 75]);
  const rain = toOpenMeteo(met({ symbol: 'lightrain' }), 1, 1, params, NOW).current;
  assert.deepEqual([rain.snowfall, rain.rain], [0, 1.2]);
  assert.equal(toOpenMeteo(met({ fog: 80 }), 1, 1, params, NOW).current.visibility, 500);
});

test('границы резерва: прошлые дни и больше 10 точек — нет; одна точка — объект, несколько — массив; User-Agent с адресом сайта', async () => {
  const calls = [];
  const f = async (url, init) => { calls.push({ url: String(url), ua: init.headers['User-Agent'] }); return new Response(JSON.stringify(met())); };
  assert.equal(await metnoFallback(WEATHER.replace('forecast_days=2', 'past_days=7&forecast_days=1'), NOW, f), null);
  const many = 'https://api.open-meteo.com/v1/forecast?latitude=' + Array(11).fill(68).join(',') + '&longitude=' + Array(11).fill(33).join(',') + '&hourly=cloud_cover';
  assert.equal(await metnoFallback(many, NOW, f), null);
  assert.equal(calls.length, 0);

  const one = await metnoFallback(WEATHER, NOW, f);
  assert.ok(!Array.isArray(one) && one.current);
  assert.equal(calls[0].url, 'https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=68.9678&lon=33.0992');
  assert.match(calls[0].ua, /auroramurmansk\.ru/);
  const seven = await metnoFallback('https://api.open-meteo.com/v1/forecast?latitude=68.97,69.16&longitude=33.1,35.15&hourly=cloud_cover&forecast_days=2&timezone=UTC', NOW, f);
  assert.equal(seven.length, 2);
  assert.equal(await metnoFallback(WEATHER, NOW, async () => new Response('down', { status: 503 })), null);
});

test('/meteo: Open-Meteo упал — ответ MET Norway; оба упали — последняя копия (3 часа); иначе — ошибка', async () => {
  clearMeteoCache();
  const search = WEATHER.slice(WEATHER.indexOf('?'));
  const world = (om, mn) => async url => {
    const u = String(url);
    if (u.startsWith('https://api.open-meteo.com')) return om === 'ok' ? new Response('{"current":{"cloud_cover":40}}') : new Response('x', { status: om });
    return mn === 'ok' ? new Response(JSON.stringify(met())) : new Response('x', { status: 503 });
  };
  const [body, status] = await meteoProxy(search, NOW, world(502, 'ok'));
  assert.equal(status, 200);
  assert.equal(JSON.parse(body).generator, 'MET Norway');

  clearMeteoCache();
  await meteoProxy(search, NOW, world('ok', 'ok'));
  const later = NOW + METEO_TTL_MS + 1;
  const [stale, s2] = await meteoProxy(search, later, world(502, 503));
  assert.deepEqual([s2, JSON.parse(stale).current.cloud_cover], [200, 40]);
  const [, s3] = await meteoProxy(search, NOW + STALE_KEEP_MS + 1, world(429, 503));
  assert.equal(s3, 429);
});
