// Пульс: каждый проход по расписанию записывает время и итог; /health их отдаёт.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runCheck } from '../src/check.js';
import { handleRequest } from '../src/api.js';
import { makeEnv, makeFetch, addSub, apiRequest, fakeCtx, NIGHT, MIN } from './helpers.mjs';

const beat = env => env.DB.raw.prepare('SELECT at, outcome FROM heartbeat WHERE id = 1').get();
const health = async (env, now = NIGHT) =>
  JSON.parse(await (await handleRequest(apiRequest('/health', null, { method: 'GET' }), env, fakeCtx(), now, makeFetch(now))).text());

test('проход без подписчиков — тоже пульс: сервер жив, просто некого будить', async () => {
  const { env } = await makeEnv();
  await runCheck(env, NIGHT, makeFetch(NIGHT));
  assert.deepEqual({ ...beat(env) }, { at: NIGHT, outcome: 'no_subs' });
});

test('итог прохода: ok, нет свежего Kp, нет облачности', async () => {
  const { env } = await makeEnv();
  addSub(env, { n: 1 });
  await runCheck(env, NIGHT, makeFetch(NIGHT, { kp: 2 }));
  assert.equal(beat(env).outcome, 'ok');

  await runCheck(env, NIGHT + 10 * MIN, makeFetch(NIGHT + 10 * MIN, { kpDown: true }));
  assert.deepEqual({ ...beat(env) }, { at: NIGHT + 10 * MIN, outcome: 'no_kp' });

  await runCheck(env, NIGHT + 20 * MIN, makeFetch(NIGHT + 20 * MIN, { weatherDown: true }));
  assert.equal(beat(env).outcome, 'no_cloud');
});

test('ошибка внутри прохода: пульс «error» записан, а сама ошибка не проглочена', async () => {
  const { env } = await makeEnv();
  addSub(env, { n: 1 });
  const broken = { ...env, DB: { ...env.DB, raw: env.DB.raw,
    prepare: sql => (sql.includes('FROM point_state') ? { all: async () => { throw new Error('база легла'); } } : env.DB.prepare(sql)),
    batch: env.DB.batch } };
  await assert.rejects(() => runCheck(broken, NIGHT, makeFetch(NIGHT)), /база легла/);
  assert.deepEqual({ ...beat(env) }, { at: NIGHT, outcome: 'error' });
});

test('строка пульса одна — перезаписывается, а не копится', async () => {
  const { env } = await makeEnv();
  for (let i = 0; i < 5; i++) await runCheck(env, NIGHT + i * 10 * MIN, makeFetch(NIGHT + i * 10 * MIN));
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) c FROM heartbeat').get().c, 1);
  assert.equal(beat(env).at, NIGHT + 40 * MIN);
});

test('/health отдаёт время и итог последнего прохода', async () => {
  const { env } = await makeEnv();
  await runCheck(env, NIGHT, makeFetch(NIGHT));
  assert.deepEqual(await health(env), { ok: true, lastCheck: NIGHT, outcome: 'no_subs' });
});

test('база до миграции (таблицы нет): проверка работает как раньше, /health отвечает без пульса', async () => {
  const { env } = await makeEnv();
  env.DB.raw.exec('DROP TABLE heartbeat');
  addSub(env, { n: 1 });
  const summary = await runCheck(env, NIGHT, makeFetch(NIGHT, { kp: 2 }));
  assert.ok(summary.levels, 'проход дошёл до конца');
  assert.deepEqual(await health(env), { ok: true, lastCheck: null, outcome: null });
});
