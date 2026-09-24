// Настройки уведомлений: «сообщать и о среднем шансе» и «небо скоро откроется».
import test from 'node:test';
import assert from 'node:assert/strict';
import { runCheck } from '../src/check.js';
import { handleRequest } from '../src/api.js';
import { skyChance, clearingHour, nextMidSince, SKY_COOLDOWN_MS } from '../src/options.js';
import { skyMessage, alertMessage } from '../src/messages.js';
import '../../core.js';
import { makeEnv, makeFetch, addSub, apiRequest, fakeCtx, ep, subRow, NIGHT, DAY, MIN, HOUR } from './helpers.mjs';

const Core = globalThis.AuroraCore;
const murmansk = Core.findPoint('murmansk');

const run = (env, now, world = {}) => {
  const fetch = makeFetch(now, world);
  return runCheck(env, now, fetch).then(summary => ({ summary, fetch }));
};
const pushedTo = fetch => fetch.pushCalls().map(c => c.url);
const setOpts = (env, n, fields) => {
  const keys = Object.keys(fields);
  env.DB.raw.prepare('UPDATE subs SET ' + keys.map(k => k + ' = ?').join(', ') + ' WHERE endpoint = ?').run(...keys.map(k => fields[k]), ep(n));
};

const OVERCAST = { low: 100, mid: 100, high: 100, total: 100 };
const CLEAR = { low: 10, mid: 5, high: 0, total: 12 };

/* ---------------- средний шанс ---------------- */

test('«сообщать и о среднем»: переход из низкого в средний будит только тех, кто это выбрал', async () => {
  const { env } = await makeEnv();
  addSub(env, { n: 1 });
  addSub(env, { n: 2 });
  setOpts(env, 1, { min_level: 'mid' });

  await run(env, NIGHT, { kp: 0.3 });                                  // низкий — точка отсчёта
  const { summary, fetch } = await run(env, NIGHT + 10 * MIN, { kp: 1.3 });
  assert.equal(summary.levels.murmansk, 'mid');
  assert.equal(summary.midSent, 1);
  assert.equal(summary.sent, 0, 'основная рассылка — только о высоком');
  assert.deepEqual(pushedTo(fetch), [ep(1)]);
  const msg = JSON.parse(subRow(env, 1).msg);
  assert.equal(msg.title, 'Средний шанс увидеть сияние — Мурманск');
  assert.match(msg.body, /^Kp 1,3 · облачность \d+%\. Слабое сияние возможно/);
  assert.equal(subRow(env, 1).last_sent, NIGHT + 10 * MIN, 'общий лимит «раз в 3 часа»');
});

test('первое наблюдение — точка отсчёта; средний держится — повторов нет; следом высокий — не раньше лимита', async () => {
  const { env } = await makeEnv();
  addSub(env, { n: 1 });
  setOpts(env, 1, { min_level: 'mid' });
  assert.equal((await run(env, NIGHT, { kp: 1.3 })).summary.midSent, 0, 'средний уже был, когда начали смотреть');

  await run(env, NIGHT + 10 * MIN, { kp: 0.3 });
  assert.equal((await run(env, NIGHT + 20 * MIN, { kp: 1.3 })).summary.midSent, 1);
  assert.equal((await run(env, NIGHT + 30 * MIN, { kp: 1.3 })).summary.midSent, 0);
  const high = await run(env, NIGHT + 40 * MIN, { kp: 4.3 });
  assert.equal(high.summary.sent + high.summary.midSent, 0, 'через 20 минут после среднего — рано');
});

test('если высокий случился сразу — у выбравших «и о среднем» одно уведомление, а не два', async () => {
  const { env } = await makeEnv();
  addSub(env, { n: 1 });
  setOpts(env, 1, { min_level: 'mid' });
  await run(env, NIGHT, { kp: 0.3 });
  const { summary, fetch } = await run(env, NIGHT + 10 * MIN, { kp: 4.3 });
  assert.equal(summary.sent, 1);
  assert.equal(summary.midSent, 0);
  assert.equal(fetch.pushCalls().length, 1);
  assert.equal(JSON.parse(subRow(env, 1).msg).title, 'Высокий шанс увидеть сияние — Мурманск');
});

test('отметка начала среднего: из низкого — сейчас; внутри среднего и высокого — прежняя', () => {
  assert.equal(nextMidSince({ level: 'low', mid_since: 0 }, 'mid', 100), 100);
  assert.equal(nextMidSince({ level: 'low', mid_since: 5 }, 'high', 100), 100);
  assert.equal(nextMidSince({ level: 'mid', mid_since: 5 }, 'high', 100), 5);
  assert.equal(nextMidSince({ level: 'high', mid_since: 5 }, 'low', 100), 5);
  assert.equal(nextMidSince(undefined, 'mid', 100), 0, 'первое наблюдение');
});

/* ---------------- небо откроется ---------------- */

test('небо откроется: сейчас сплошные облака, Kp дотягивает, через 2 часа просвет — сигнал с временем по поясу', async () => {
  const { env } = await makeEnv();
  addSub(env, { n: 1 });
  addSub(env, { n: 2 });
  setOpts(env, 1, { sky: 1, tz: 'Europe/Moscow' });

  const world = { kp: 1.3, cloud: () => OVERCAST, hourly: (i, h) => (h >= 2 ? CLEAR : OVERCAST) };
  const { summary, fetch } = await run(env, NIGHT, world);
  assert.equal(summary.skySent, 1);
  assert.deepEqual(pushedTo(fetch), [ep(1)]);
  const msg = JSON.parse(subRow(env, 1).msg);
  assert.equal(msg.title, 'Небо скоро откроется — Мурманск');
  // NIGHT = 22:00 UTC; просвет — час 2 от начала часа: 00:00 UTC = 03:00 МСК
  assert.equal(msg.body, 'Облака должны разойтись к 03:00 (облачность около 14%). Kp 1,3 — сияние возможно, приготовьтесь.');
  assert.equal(msg.kind, 'sky');
  assert.equal(subRow(env, 1).last_sky, NIGHT);

  // раз за ночь
  assert.equal((await run(env, NIGHT + 10 * MIN, world)).summary.skySent, 0);
  assert.ok(SKY_COOLDOWN_MS <= 24 * HOUR);
  assert.equal((await run(env, NIGHT + 24 * HOUR, world)).summary.skySent, 1, "следующей ночью — снова");
});

test('небо откроется — не шлётся: просвета в прогнозе нет, Kp мал, сейчас и так ясно, днём, в тихие часы', async () => {
  const cases = [
    ['просвета нет', { kp: 1.3, cloud: () => OVERCAST, hourly: () => OVERCAST }, NIGHT],
    ['Kp мал', { kp: 0.3, cloud: () => OVERCAST, hourly: (i, h) => (h >= 1 ? CLEAR : OVERCAST) }, NIGHT],
    ['уже ясно', { kp: 1.3, cloud: () => CLEAR, hourly: () => CLEAR }, NIGHT],
    ['днём', { kp: 1.3, cloud: () => OVERCAST, hourly: (i, h) => (h >= 1 ? CLEAR : OVERCAST) }, DAY]
  ];
  for (const [name, world, now] of cases) {
    const { env } = await makeEnv();
    addSub(env, { n: 1, created: now - HOUR });
    setOpts(env, 1, { sky: 1 });
    assert.equal((await run(env, now, world)).summary.skySent, 0, name);
  }
  const { env } = await makeEnv();
  addSub(env, { n: 1 });
  setOpts(env, 1, { sky: 1, quiet_from: 0, quiet_to: 6, tz: 'Europe/Moscow' });   // 22:00 UTC = 01:00 МСК
  assert.equal((await run(env, NIGHT, { kp: 1.3, cloud: () => OVERCAST, hourly: (i, h) => (h >= 1 ? CLEAR : OVERCAST) })).summary.skySent, 0, 'тихие часы');
});

test('просвет ищется в пределах 3 часов, в темноте и не в прошлом', () => {
  const hours = [
    { time: NIGHT - HOUR, cloud: 0 },
    { time: NIGHT + HOUR, cloud: 80 },
    { time: NIGHT + 2 * HOUR, cloud: 40 },
    { time: NIGHT + 4 * HOUR, cloud: 0 }
  ];
  assert.deepEqual(clearingHour(murmansk, hours, NIGHT), { time: NIGHT + 2 * HOUR, cloud: 40 });
  assert.equal(clearingHour(murmansk, [{ time: NIGHT + 4 * HOUR, cloud: 0 }], NIGHT), null, 'дальше 3 часов');
  assert.equal(clearingHour(murmansk, [{ time: DAY + HOUR, cloud: 0 }], DAY), null, 'светло');
  assert.equal(skyChance(murmansk, { value: 1.3 }, { value: 60, hours }, NIGHT), null, 'просветы уже есть');
  assert.equal(skyChance(murmansk, null, { value: 90, hours }, NIGHT), null);
});

test('тексты: средний и «небо откроется» на трёх языках; пояс подписчика, мусорный — МСК', () => {
  const kp = { value: 1.3 };
  const clear = { time: Date.UTC(2026, 11, 15, 23, 0), cloud: 30 };
  assert.equal(skyMessage(murmansk, kp, clear, NIGHT, 'en', 'Europe/Helsinki').body,
    'Clouds are expected to break by 01:00 (cloud cover about 30%). Kp 1.3 — aurora is possible, get ready.');
  assert.match(skyMessage(murmansk, kp, clear, NIGHT, 'ru', 'Mars/Olympus').body, /к 02:00/);
  assert.equal(skyMessage(Core.findPoint('teriberka'), kp, clear, NIGHT, 'zh').title, '天空即将放晴——捷里别尔卡');
  assert.equal(alertMessage(murmansk, kp, { value: 40 }, NIGHT, 'en', 'mid').title, 'Moderate chance of aurora — Murmansk');
  assert.equal(alertMessage(murmansk, kp, { value: 40 }, NIGHT, 'en').title, 'High chance of aurora — Murmansk');
});

/* ---------------- API и совместимость ---------------- */

test('/subscribe: порог и «небо откроется» сохраняются; не присланные — остаются; мусор — игнорируется', async () => {
  const { env } = await makeEnv();
  const call = body => handleRequest(apiRequest('/subscribe', { endpoint: ep(7), point: 'murmansk', ...body }), env, fakeCtx(), NIGHT);
  assert.equal((await call({})).status, 200);
  assert.deepEqual([subRow(env, 7).min_level, subRow(env, 7).sky], ['high', 0], 'по умолчанию');
  await call({ level: 'mid', sky: true });
  assert.deepEqual([subRow(env, 7).min_level, subRow(env, 7).sky], ['mid', 1]);
  await call({ lang: 'en' });
  assert.deepEqual([subRow(env, 7).min_level, subRow(env, 7).sky], ['mid', 1], 'старая страница не присылает — не трогаем');
  await call({ level: 'all', sky: 'yes' });
  assert.deepEqual([subRow(env, 7).min_level, subRow(env, 7).sky], ['mid', 1]);
  await call({ level: 'high', sky: false });
  assert.deepEqual([subRow(env, 7).min_level, subRow(env, 7).sky], ['high', 0]);
});

test('база до миграции: основные уведомления и подписка работают как раньше', async () => {
  const { env } = await makeEnv();
  env.DB.raw.exec('ALTER TABLE subs DROP COLUMN min_level');
  env.DB.raw.exec('ALTER TABLE point_state DROP COLUMN mid_since');
  addSub(env, { n: 1 });
  await run(env, NIGHT, { kp: 0.3 });
  const { summary } = await run(env, NIGHT + 10 * MIN, { kp: 4.3 });
  assert.equal(summary.sent, 1);
  assert.equal(summary.optionsError, true);
  const res = await handleRequest(apiRequest('/subscribe', { endpoint: ep(8), point: 'murmansk', level: 'mid' }), env, fakeCtx(), NIGHT);
  assert.equal(res.status, 200);
});
