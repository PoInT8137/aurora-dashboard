import test from 'node:test';
import assert from 'node:assert/strict';
import { runCheck, COOLDOWN_MS, MAX_SENDS_PER_RUN } from '../src/check.js';
import { handleRequest } from '../src/api.js';
import { makeEnv, makeFetch, addSub, apiRequest, fakeCtx, ep, subRow, stateRow, NIGHT, DAY, MIN, HOUR } from './helpers.mjs';

const T0 = NIGHT;
const T1 = NIGHT + 10 * MIN;     // следующий проход по расписанию

/** Проход в момент now при заданном состоянии внешнего мира. */
const run = (env, now, world = {}) => {
  const fetch = makeFetch(now, world);
  return runCheck(env, now, fetch).then(summary => ({ summary, fetch }));
};

const pushedTo = fetch => fetch.pushCalls().map(c => c.url);

test('нет подписчиков — нет ни одного обращения к внешним сервисам', async () => {
  const { env } = await makeEnv();
  const { summary, fetch } = await run(env, T0);
  assert.deepEqual(summary, { skipped: 'нет подписчиков' });
  assert.equal(fetch.calls.length, 0);
});

test('первое наблюдение — только точка отсчёта: «высокий», который уже идёт, не будит', async () => {
  const { env } = await makeEnv();
  addSub(env, { n: 1 });
  const { summary, fetch } = await run(env, T0, { kp: 4.3 });

  assert.equal(summary.levels.murmansk, 'high');
  assert.equal(summary.sent, 0);
  assert.equal(fetch.pushCalls().length, 0);
  assert.deepEqual({ level: stateRow(env, 'murmansk').level, since: stateRow(env, 'murmansk').high_since }, { level: 'high', since: 0 });

  // и на втором проходе, пока «высокий» держится, тоже тихо
  const second = await run(env, T1, { kp: 4.3 });
  assert.equal(second.summary.sent, 0);
});

test('переход из среднего в высокий будит подписчика точки, текст сохраняется для service worker', async () => {
  const { env } = await makeEnv();
  addSub(env, { n: 1, created: T0 - HOUR });

  await run(env, T0, { kp: 0.3 });                              // спокойно
  assert.equal(stateRow(env, 'murmansk').level, 'low');

  const { summary, fetch } = await run(env, T1, { kp: 4.3 });   // вспышка
  assert.equal(summary.sent, 1);
  assert.deepEqual(pushedTo(fetch), [ep(1)]);

  const row = subRow(env, 1);
  assert.equal(row.last_sent, T1);
  assert.equal(row.fails, 0);
  const msg = JSON.parse(row.msg);
  assert.equal(msg.title, 'Высокий шанс увидеть сияние — Мурманск');
  assert.match(msg.body, /^Kp 4,3 · облачность \d+% · тёмное небо\. Смотрите на север\.$/);
  assert.equal(stateRow(env, 'murmansk').high_since, T1);
});

test('пока «высокий» держится, повторных уведомлений нет', async () => {
  const { env } = await makeEnv();
  addSub(env, { n: 1 });
  await run(env, T0, { kp: 0.3 });
  assert.equal((await run(env, T1, { kp: 4.3 })).summary.sent, 1);
  for (let i = 2; i <= 6; i++) {
    assert.equal((await run(env, T0 + i * 10 * MIN, { kp: 4.5 })).summary.sent, 0, 'проход ' + i);
  }
});

test('пороги Kp зависят от точки: при Kp 2,5 в Мурманске высокий шанс, в Кандалакше — средний', async () => {
  const { env } = await makeEnv();
  addSub(env, { n: 1, point: 'murmansk' });
  addSub(env, { n: 2, point: 'kandalaksha' });
  await run(env, T0, { kp: 0.3 });

  const { summary, fetch } = await run(env, T1, { kp: 2.5 });
  assert.equal(summary.levels.murmansk, 'high');
  assert.equal(summary.levels.kandalaksha, 'mid');
  assert.deepEqual(pushedTo(fetch), [ep(1)], 'уведомление получил только Мурманск');
});

test('каждому подписчику — уведомление своей точки, а не соседней', async () => {
  const { env } = await makeEnv();
  addSub(env, { n: 1, point: 'murmansk' });
  addSub(env, { n: 2, point: 'teriberka' });
  addSub(env, { n: 3, point: 'murmansk' });
  await run(env, T0, { kp: 0.3 });

  const { summary, fetch } = await run(env, T1, { kp: 4.3 });
  assert.equal(summary.sent, 3);
  assert.deepEqual(pushedTo(fetch).sort(), [ep(1), ep(2), ep(3)]);
  assert.match(JSON.parse(subRow(env, 2).msg).title, /Териберка$/);
  assert.match(JSON.parse(subRow(env, 1).msg).title, /Мурманск$/);
});

test('не чаще раза в 3 часа: недавно получивший пропускает новый переход', async () => {
  const { env } = await makeEnv();
  addSub(env, { n: 1, lastSent: T1 - 1 * HOUR });      // получил час назад
  addSub(env, { n: 2, lastSent: T1 - 4 * HOUR });      // получал давно
  await run(env, T0, { kp: 0.3 });

  const { fetch } = await run(env, T1, { kp: 4.3 });
  assert.deepEqual(pushedTo(fetch), [ep(2)]);
  assert.ok(COOLDOWN_MS === 3 * HOUR);
});

test('подписавшийся уже во время «высокого» ничего не получает — только о следующем', async () => {
  const { env } = await makeEnv();
  addSub(env, { n: 1 });
  await run(env, T0, { kp: 0.3 });
  await run(env, T1, { kp: 4.3 });                      // начался «высокий», n=1 получил

  addSub(env, { n: 2, created: T1 + 5 * MIN });         // пришёл позже
  const { fetch } = await run(env, T1 + 10 * MIN, { kp: 4.3 });
  assert.equal(fetch.pushCalls().length, 0);

  // спад и новый подъём — теперь и он в списке (после паузы в 3 часа у n=1)
  await run(env, T1 + 20 * MIN, { kp: 0.3 });
  const next = await run(env, T1 + 4 * HOUR, { kp: 4.3 });
  assert.deepEqual(pushedTo(next.fetch).sort(), [ep(1), ep(2)]);
});

test('смена точки через API во время «высокого» не будит по новой точке', async () => {
  const { env } = await makeEnv();
  addSub(env, { n: 1, point: 'murmansk', created: T0 - HOUR });
  addSub(env, { n: 9, point: 'teriberka', created: T0 - HOUR });   // чтобы у Териберки было состояние
  await run(env, T0, { kp: 0.3 });
  await run(env, T1, { kp: 4.3 });                                  // «высокий» начался везде

  const change = await handleRequest(apiRequest('/subscribe', { endpoint: ep(1), point: 'teriberka' }),
    env, fakeCtx(), T1 + 5 * MIN, makeFetch(T1));
  assert.equal(change.status, 200);
  env.DB.raw.prepare('UPDATE subs SET last_sent = 0 WHERE endpoint = ?').run(ep(1));

  const { fetch } = await run(env, T1 + 10 * MIN, { kp: 4.3 });
  assert.equal(fetch.pushCalls().length, 0);
});

test('push-сервис ответил 404 или 410 — подписка удаляется', async () => {
  const { env } = await makeEnv();
  addSub(env, { n: 1 });
  addSub(env, { n: 2 });
  addSub(env, { n: 3 });
  await run(env, T0, { kp: 0.3 });

  const { summary } = await run(env, T1, { kp: 4.3, pushStatus: { [ep(1)]: 410, [ep(2)]: 404 } });
  assert.equal(summary.sent, 1);
  assert.equal(summary.gone, 2);
  assert.equal(subRow(env, 1), undefined);
  assert.equal(subRow(env, 2), undefined);
  assert.ok(subRow(env, 3));
});

test('временные сбои: счётчик растёт, после пяти подряд подписка удаляется, успех обнуляет', async () => {
  const { env } = await makeEnv();
  addSub(env, { n: 1 });
  await run(env, T0, { kp: 0.3 });
  await run(env, T1, { kp: 0.3 });

  // высокий с сбоями; каждый раз новый «эпизод» — иначе рассылка не повторится
  let now = T1;
  const fail = { pushStatus: { [ep(1)]: 503 } };
  for (let i = 1; i <= 4; i++) {
    now += 10 * MIN;
    await run(env, now, { ...fail, kp: 4.3 });
    assert.equal(subRow(env, 1).fails, i, `после сбоя ${i}`);
    assert.equal(subRow(env, 1).last_sent, 0, 'при сбое last_sent не трогаем — повторим на следующем проходе');
  }

  now += 10 * MIN;
  await run(env, now, { kp: 4.3 });                          // на этот раз push принят
  assert.equal(subRow(env, 1).fails, 0);
  assert.equal(subRow(env, 1).last_sent, now);

  // пять сбоев подряд — подписка удалена
  const { env: env2 } = await makeEnv();
  addSub(env2, { n: 1 });
  await run(env2, T0, { kp: 0.3 });
  for (let i = 1; i <= 5; i++) await run(env2, T0 + i * 10 * MIN, { ...fail, kp: 4.3 });
  assert.equal(subRow(env2, 1), undefined);
});

test('нет данных — состояние не меняется и никого не будят: недоступный NOAA', async () => {
  const { env } = await makeEnv();
  addSub(env, { n: 1 });
  await run(env, T0, { kp: 0.3 });
  const before = { ...stateRow(env, 'murmansk') };

  const { summary, fetch } = await run(env, T1, { kpDown: true });
  assert.deepEqual(summary, { skipped: 'нет свежего Kp' });
  assert.equal(fetch.pushCalls().length, 0);
  assert.deepEqual({ ...stateRow(env, 'murmansk') }, before);
});

test('нет данных — не будят: устаревшее Kp, недоступная погода, ответ с неверным числом точек', async () => {
  const { env } = await makeEnv();
  addSub(env, { n: 1 });
  await run(env, T0, { kp: 0.3 });

  assert.deepEqual((await run(env, T1, { kp: 4.3, kpAgeMs: 5 * HOUR })).summary, { skipped: 'нет свежего Kp' });
  assert.deepEqual((await run(env, T1, { kp: 4.3, weatherDown: true })).summary, { skipped: 'нет данных об облачности' });

  addSub(env, { n: 2, point: 'teriberka' });
  assert.deepEqual((await run(env, T1, { kp: 4.3, weatherBroken: true })).summary, { skipped: 'нет данных об облачности' });
  assert.equal(subRow(env, 1).last_sent, 0);
});

test('после пропущенного прохода переход не выдумывается: пропуск не превращается в «средний»', async () => {
  const { env } = await makeEnv();
  addSub(env, { n: 1 });
  await run(env, T0, { kp: 4.3 });                         // точка отсчёта: высокий
  await run(env, T1, { weatherDown: true });               // пропуск
  const { summary } = await run(env, T1 + 10 * MIN, { kp: 4.3 });
  assert.equal(summary.sent, 0, 'высокий держался всё время — сообщать не о чем');
});

test('днём высокого шанса не бывает ни при каком Kp', async () => {
  const { env } = await makeEnv();
  addSub(env, { n: 1 });
  await run(env, DAY, { kp: 0.3 });
  const { summary, fetch } = await run(env, DAY + 10 * MIN, { kp: 9 });
  assert.equal(summary.levels.murmansk, 'low');
  assert.equal(fetch.pushCalls().length, 0);
});

test('противоречивая облачность режет балл: при Kp 2,5 без конфликта «высокий», с конфликтом — нет', async () => {
  const clear = () => ({ low: 5, mid: 5, high: 0, total: 8 });
  const conflicting = () => ({ low: 8, mid: 4, high: 0, total: 90 });   // ярусы 8/4/0 при суммарной 90 %

  const a = await makeEnv(); addSub(a.env, { n: 1 });
  await run(a.env, T0, { kp: 0.3, cloud: clear });
  assert.equal((await run(a.env, T1, { kp: 2.5, cloud: clear })).summary.levels.murmansk, 'high');

  const b = await makeEnv(); addSub(b.env, { n: 1 });
  await run(b.env, T0, { kp: 0.3, cloud: conflicting });
  assert.equal((await run(b.env, T1, { kp: 2.5, cloud: conflicting })).summary.levels.murmansk, 'mid');
});

test('облачность всех точек запрашивается одним запросом с единой моделью', async () => {
  const { env } = await makeEnv();
  addSub(env, { n: 1, point: 'murmansk' });
  addSub(env, { n: 2, point: 'teriberka' });
  addSub(env, { n: 3, point: 'kandalaksha' });
  addSub(env, { n: 4, point: 'murmansk' });

  const { fetch } = await run(env, T0, { kp: 0.3 });
  const weather = fetch.calls.filter(c => c.url.includes('open-meteo'));
  assert.equal(weather.length, 1);
  assert.match(weather[0].url, /models=icon_eu/);
  assert.equal(weather[0].url.match(/latitude=([^&]+)/)[1].split(',').length, 3, 'по одной координате на точку с подписчиками');
});

test('одна точка: API отдаёт объект, а не массив, — разбор это учитывает', async () => {
  const { env } = await makeEnv();
  addSub(env, { n: 1 });
  const { summary } = await run(env, T0, { kp: 4.3 });
  assert.deepEqual(summary.levels, { murmansk: 'high' });
});

test('много подписчиков: рассылка растягивается на несколько проходов, никто не получает дважды', async () => {
  // Лимит привязан к внешнему ограничению: у worker'а на бесплатном тарифе не больше
  // 50 внешних запросов за запуск, часть уходит на данные и базу. Число зафиксировано
  // здесь намеренно, а не берётся из проверяемого кода, — иначе тест поддакивал бы поломке.
  assert.equal(MAX_SENDS_PER_RUN, 35);

  const { env } = await makeEnv();
  const total = 50;
  for (let n = 1; n <= total; n++) addSub(env, { n });
  await run(env, T0, { kp: 0.3 });

  const first = await run(env, T1, { kp: 4.3 });
  assert.equal(first.summary.sent, 35);
  assert.equal(first.fetch.pushCalls().length, 35, 'запросов к push-сервисам ровно столько, сколько лимит');

  const second = await run(env, T1 + 10 * MIN, { kp: 4.3 });
  assert.equal(second.summary.sent, 15);

  const third = await run(env, T1 + 20 * MIN, { kp: 4.3 });
  assert.equal(third.summary.sent, 0);

  const received = env.DB.raw.prepare('SELECT COUNT(*) c FROM subs WHERE last_sent > 0').get().c;
  assert.equal(received, total);
  const all = [...first.fetch.pushCalls(), ...second.fetch.pushCalls()].map(c => c.url);
  assert.equal(new Set(all).size, total, 'ни одного повтора');
});

test('подписка с чужим адресом, попавшая в базу, не получает ни одного запроса', async () => {
  const { env } = await makeEnv();
  env.DB.raw.prepare('INSERT INTO subs(id, endpoint, point, created) VALUES(?, ?, ?, ?)')
    .run('evil', 'https://evil.example/collect', 'murmansk', T0 - HOUR);
  await run(env, T0, { kp: 0.3 });
  const { fetch } = await run(env, T1, { kp: 4.3 });
  assert.equal(fetch.calls.filter(c => c.url.includes('evil.example')).length, 0);
});
