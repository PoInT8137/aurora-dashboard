// Тихие часы: подписка хранит окно и пояс, рассылка пропускает тех, у кого сейчас тихо,
// и доставляет им сигнал после окончания, если шанс всё ещё высокий.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runCheck, MAX_SENDS_PER_RUN } from '../src/check.js';
import { handleRequest } from '../src/api.js';
import { normalizeQuiet, normalizeZone } from '../src/messages.js';
import { makeEnv, makeFetch, addSub, apiRequest, fakeCtx, ep, subRow, NIGHT, MIN, HOUR } from './helpers.mjs';

// NIGHT — 22:00 UTC 15 декабря: в Москве уже 01:00, в Шанхае 06:00, в Нью-Йорке 17:00.
const T0 = NIGHT;
const T1 = NIGHT + 10 * MIN;

const call = (env, path, body, now = NIGHT) =>
  handleRequest(apiRequest(path, body), env, fakeCtx(), now, makeFetch(now));

const run = (env, now, world = {}) => runCheck(env, now, makeFetch(now, world));

const setQuiet = (env, n, from, to, tz) =>
  env.DB.raw.prepare('UPDATE subs SET quiet_from = ?, quiet_to = ?, tz = ? WHERE id = (SELECT id FROM subs WHERE endpoint = ?)')
    .run(from, to, tz, ep(n));

test('normalizeQuiet: окно из двух разных часов 0–23; всё остальное не трогает прежнее; null выключает', () => {
  assert.deepEqual(normalizeQuiet({ quiet: { from: 23, to: 7 } }), { set: true, from: 23, to: 7 });
  assert.deepEqual(normalizeQuiet({ quiet: { from: 0, to: 6 } }), { set: true, from: 0, to: 6 });
  assert.deepEqual(normalizeQuiet({ quiet: null }), { set: true, from: null, to: null });
  assert.deepEqual(normalizeQuiet({}), { set: false });
  for (const bad of [{ from: 5, to: 5 }, { from: -1, to: 3 }, { from: 3, to: 24 }, { from: 1.5, to: 3 }, { from: '1', to: 3 },
    { from: 1 }, {}, [], 'ночь', 7, true]) {
    assert.deepEqual(normalizeQuiet({ quiet: bad }), { set: false }, JSON.stringify(bad));
  }
});

test('normalizeZone: настоящий пояс IANA проходит, мусор и слишком длинное — нет', () => {
  assert.equal(normalizeZone('Europe/Moscow'), 'Europe/Moscow');
  assert.equal(normalizeZone('Asia/Shanghai'), 'Asia/Shanghai');
  assert.equal(normalizeZone('UTC'), 'UTC');
  for (const bad of ['Mars/Olympus', '', 'x'.repeat(65), null, undefined, 5, {}, '<script>']) assert.equal(normalizeZone(bad), null, String(bad));
});

test('/subscribe: окно и пояс сохраняются; не присланные (старая страница) остаются; quiet: null выключает', async () => {
  const { env } = await makeEnv();
  await call(env, '/subscribe', { endpoint: ep(1), point: 'murmansk', lang: 'en', quiet: { from: 23, to: 7 }, tz: 'Europe/Moscow' });
  let row = subRow(env, 1);
  assert.deepEqual([row.quiet_from, row.quiet_to, row.tz], [23, 7, 'Europe/Moscow']);

  // старая версия страницы про тихие часы ничего не знает — выбор не сбрасывается
  await call(env, '/subscribe', { endpoint: ep(1), point: 'teriberka' });
  row = subRow(env, 1);
  assert.deepEqual([row.quiet_from, row.quiet_to, row.tz, row.point], [23, 7, 'Europe/Moscow', 'teriberka']);

  // негодное окно и негодный пояс игнорируются
  await call(env, '/subscribe', { endpoint: ep(1), point: 'teriberka', quiet: { from: 9, to: 9 }, tz: 'Mars/Olympus' });
  row = subRow(env, 1);
  assert.deepEqual([row.quiet_from, row.quiet_to, row.tz], [23, 7, 'Europe/Moscow']);

  // смена окна и пояса
  await call(env, '/subscribe', { endpoint: ep(1), point: 'teriberka', quiet: { from: 0, to: 6 }, tz: 'Asia/Shanghai' });
  row = subRow(env, 1);
  assert.deepEqual([row.quiet_from, row.quiet_to, row.tz], [0, 6, 'Asia/Shanghai']);

  // выключение: окно исчезает, пояс остаётся (он ещё пригодится)
  await call(env, '/subscribe', { endpoint: ep(1), point: 'teriberka', quiet: null, tz: 'Asia/Shanghai' });
  row = subRow(env, 1);
  assert.deepEqual([row.quiet_from, row.quiet_to, row.tz], [null, null, 'Asia/Shanghai']);

  // новая подписка без тихих часов
  await call(env, '/subscribe', { endpoint: ep(2), point: 'murmansk' });
  assert.deepEqual([subRow(env, 2).quiet_from, subRow(env, 2).quiet_to, subRow(env, 2).tz], [null, null, null]);
});

test('рассылка: у кого в тихих часах — не приходит, остальным приходит; отложенный получает после окончания', async () => {
  const { env } = await makeEnv();
  addSub(env, { n: 1 });                                  // без тихих часов
  addSub(env, { n: 2 });                                  // 00–06 по Москве, а там 01:10
  addSub(env, { n: 3 });                                  // 00–06 по Шанхаю, а там 06:10 — уже не тихо
  setQuiet(env, 2, 0, 6, 'Europe/Moscow');
  setQuiet(env, 3, 0, 6, 'Asia/Shanghai');
  await run(env, T0, { kp: 0.3 });

  const first = await run(env, T1, { kp: 4.3 });
  assert.equal(first.sent, 2);
  assert.equal(subRow(env, 1).last_sent, T1);
  assert.equal(subRow(env, 2).last_sent, 0, 'в тихие часы ничего не отправлено и отметки нет');
  assert.equal(subRow(env, 3).last_sent, T1);
  assert.equal(subRow(env, 2).msg, null);

  // «высокий» держится, тихие часы по Москве закончились (06:10) — отложенное уходит
  const later = NIGHT + 5 * HOUR + 10 * MIN;
  const second = await run(env, later, { kp: 4.5 });
  assert.equal(second.sent, 1);
  assert.equal(subRow(env, 2).last_sent, later);
  assert.match(JSON.parse(subRow(env, 2).msg).title, /Мурманск$/);
});

test('окно через полночь и границы: 22–08 включает 22:00 и не включает 08:00', async () => {
  const cases = [
    // [час по UTC, окно, тихо ли]
    [22, [22, 8], true], [23, [22, 8], true], [0, [22, 8], true], [7, [22, 8], true], [8, [22, 8], false], [21, [22, 8], false],
    [0, [0, 6], true], [5, [0, 6], true], [6, [0, 6], false], [23, [0, 6], false]
  ];
  const core = globalThis.AuroraCore;
  for (const [hour, [from, to], quiet] of cases) {
    const date = new Date(Date.UTC(2026, 11, 15, hour, 30));
    assert.equal(core.inQuietHours(date, 'UTC', from, to), quiet, `${hour}:30 UTC, окно ${from}–${to}`);
  }
  assert.equal(core.inQuietHours(new Date(NIGHT), 'Europe/Moscow', 0, 6), true, '01:00 по Москве');
  assert.equal(core.inQuietHours(new Date(NIGHT), 'America/New_York', 0, 6), false, '17:00 по Нью-Йорку');
});

test('негодные данные о тихих часах не глушат уведомления: неизвестный пояс, пустое окно, нечисловые часы', () => {
  const core = globalThis.AuroraCore;
  const date = new Date(NIGHT);
  assert.equal(core.inQuietHours(date, 'Mars/Olympus', 0, 6), false);
  assert.equal(core.inQuietHours(date, 'UTC', 5, 5), false);
  assert.equal(core.inQuietHours(date, 'UTC', null, null), false);
  assert.equal(core.inQuietHours(date, 'UTC', undefined, 6), false);
  assert.equal(core.inQuietHours(date, 'UTC', '0', '6'), false);
  assert.equal(core.inQuietHours(date, 'UTC', -1, 6), false);
  assert.equal(core.inQuietHours(date, 'UTC', 0, 24), false);
});

test('тихие часы не занимают лимит отправок: пропущенные не вытесняют тех, кому можно', async () => {
  const { env } = await makeEnv();
  for (let n = 1; n <= MAX_SENDS_PER_RUN + 5; n++) { addSub(env, { n, lastSent: -n }); setQuiet(env, n, 0, 6, 'Europe/Moscow'); }
  addSub(env, { n: 999, lastSent: 0 });
  await run(env, T0, { kp: 0.3 });

  const summary = await run(env, T1, { kp: 4.3 });
  assert.equal(summary.sent, 1);
  assert.equal(subRow(env, 999).last_sent, T1);
});

test('пробное уведомление приходит и в тихие часы: человек проверяет, что всё работает', async () => {
  const { env } = await makeEnv();
  await call(env, '/subscribe', { endpoint: ep(1), point: 'murmansk', quiet: { from: 0, to: 6 }, tz: 'Europe/Moscow' }, T1);
  const res = await call(env, '/test', { endpoint: ep(1) }, T1 + HOUR);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  assert.equal(JSON.parse(subRow(env, 1).msg).test, true);
});
