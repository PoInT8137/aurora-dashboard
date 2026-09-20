// Главный инвариант: сайт и сервер уведомлений согласны, высокий ли шанс.
//
// Иначе уведомление скажет «высокий», а в приложении окажется «средний» — или
// наоборот: сияние есть, а сервер молчит. Сайт считает вердикт функцией
// computeVerdict из app.js, сервер — quickLevel из общего ядра core.js. Тест
// сравнивает их на реальной высоте Солнца в течение всего года, включая
// полярный день, полярную ночь и сумерки, для всех точек.
//
// Запуск: node --test tools/parity.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadApp } from './app-sandbox.mjs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const clock = { now: Date.UTC(2026, 0, 1) };
const site = loadApp([['core.js', read('core.js')], ['app.js', read('app.js')]], { clock });

await import('../core.js');                 // как в worker: побочный эффект — globalThis.AuroraCore
const Core = globalThis.AuroraCore;

const kpValues = [null, 0, 0.7, 1.3, 1.9, 2.3, 2.7, 3.0, 3.4, 4.7, 6, 9];
const cloudValues = [null, 0, 12, 25, 26, 45, 50, 51, 75, 76, 100];

test('сервер экспортирует всё, что нужно worker\'у', () => {
  for (const name of ['POINTS', 'quickLevel', 'cloudFromCurrent', 'readKpSeries', 'WEATHER_MODEL', 'kpScoreAt', 'solarAltitude'])
    assert.ok(Core[name] !== undefined, 'нет ' + name);
  assert.equal(Core.POINTS.length, 7);
});

test('сайт и сервер одинаково определяют уровень: 7 точек × весь год × Kp × облачность', () => {
  let compared = 0, high = 0;
  const seen = { high: 0, mid: 0, low: 0 };
  const mismatches = [];

  // Год с шагом в 2 дня, три момента суток: охватывает полярный день, ночь и сумерки.
  for (let day = 0; day < 365; day += 2) {
    for (const hour of [0, 9, 18]) {
      const t = Date.UTC(2026, 0, 1 + day, hour);
      clock.now = t;

      for (const point of Core.POINTS) {
        site.state.point = site.findPoint(point.id);

        for (const kpValue of kpValues) {
          for (const cloudValue of cloudValues) {
            for (const conflict of cloudValue === null ? [false] : [false, true]) {
              const kp = kpValue === null ? null : { value: kpValue, stale: null };
              const cloud = cloudValue === null ? null : { value: cloudValue, conflict, stale: null };

              const siteVerdict = site.computeVerdict(kp, cloud);
              const serverVerdict = Core.quickLevel(kpValue, cloud && { value: cloudValue, conflict }, point, new Date(t));

              // Не из чего считать: сайт ничего не показывает, сервер молчит.
              const a = siteVerdict ? siteVerdict.level : null;
              const b = serverVerdict ? serverVerdict.level : null;

              compared++;
              if (a !== b && mismatches.length < 10) {
                mismatches.push(`${new Date(t).toISOString()} ${point.id} kp=${kpValue} облачность=${cloudValue}/${conflict}: сайт=${a}, сервер=${b}`);
              }
              if (a) seen[a]++;
            }
          }
        }
      }
    }
  }

  assert.deepEqual(mismatches, [], 'расхождений: ' + mismatches.length);
  assert.ok(compared > 500000, 'сравнений слишком мало: ' + compared);
  // Тест не должен быть тривиальным: в выборке есть все три уровня.
  assert.ok(seen.high > 1000 && seen.mid > 1000 && seen.low > 1000, JSON.stringify(seen));
  console.log(`  сравнений: ${compared.toLocaleString('ru-RU')} · high ${seen.high.toLocaleString('ru-RU')} / mid ${seen.mid.toLocaleString('ru-RU')} / low ${seen.low.toLocaleString('ru-RU')}`);
});

test('разбор ответа Open-Meteo на сайте и на сервере даёт одну облачность', async () => {
  const responses = [
    { time: '2026-09-19T18:00', cloud_cover: 81, cloud_cover_low: 60, cloud_cover_mid: 50, cloud_cover_high: 22 },
    { time: '2026-09-19T18:00', cloud_cover: 90, cloud_cover_low: 8, cloud_cover_mid: 4, cloud_cover_high: 0 },
    { time: '2026-09-19T18:00', cloud_cover: 72 },
    { time: '2026-09-19T18:00', cloud_cover: 40, cloud_cover_low: 20, cloud_cover_mid: null, cloud_cover_high: 5 },
    { time: '2026-09-19T18:00', cloud_cover: 55, cloud_cover_low: 25, cloud_cover_mid: 0, cloud_cover_high: 0 },
    { time: '2026-09-19T18:00', cloud_cover: 56, cloud_cover_low: 25, cloud_cover_mid: 0, cloud_cover_high: 0 },
    {}, null
  ];

  for (const cur of responses) {
    const payload = { current: cur, hourly: { time: [], cloud_cover: [] } };
    const app = loadApp([['core.js', read('core.js')], ['app.js', read('app.js')]], {
      now: Date.UTC(2026, 8, 19, 18),
      fetch: async () => ({ ok: true, json: async () => payload })
    });
    await app.loadCloud();

    const server = Core.cloudFromCurrent(cur);
    if (server === null) {
      assert.equal(app.state.cloud, null, 'сервер не разобрал ответ — сайт тоже: ' + JSON.stringify(cur));
    } else {
      assert.equal(app.state.cloud.value, server.value, JSON.stringify(cur));
      assert.equal(app.state.cloud.conflict, server.conflict, JSON.stringify(cur));
    }
  }
});

test('и сайт, и сервер запрашивают одну и ту же модель погоды', () => {
  assert.equal(site.CONFIG.weatherModel, Core.WEATHER_MODEL);
  assert.match(site.weatherUrl(site.POINTS[0]), new RegExp('models=' + Core.WEATHER_MODEL));
  assert.match(site.allPointsWeatherUrl(), new RegExp('models=' + Core.WEATHER_MODEL));
});

test('разбор Kp с NOAA: сайт и сервер читают одинаково оба формата', () => {
  const formats = [
    [{ time_tag: '2026-09-19T17:38:00', kp_index: 1, estimated_kp: 1.0 }, { time_tag: '2026-09-19T17:39:00', kp_index: 1, estimated_kp: 0.67 }],
    [['time_tag', 'Kp', 'a_running'], ['2026-09-19 12:00:00', '2.33', '9'], ['2026-09-19 15:00:00', '3.00', '15']]
  ];
  for (const data of formats) {
    const a = site.readKpSeries(data), b = Core.readKpSeries(data);
    assert.equal(a.value, b.value);
    assert.equal(a.time.getTime(), b.time.getTime());
  }
});
