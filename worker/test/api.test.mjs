import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest, MAX_SUBS } from '../src/api.js';
import { makeEnv, makeFetch, apiRequest, fakeCtx, ep, NIGHT, MIN } from './helpers.mjs';

const call = (env, path, body, opts, extra = {}) =>
  handleRequest(apiRequest(path, body, opts), env, extra.ctx || fakeCtx(), extra.now ?? NIGHT,
    extra.fetch ?? makeFetch(NIGHT), extra.sleep);

const parse = async res => JSON.parse(await res.text());

test('CORS: предварительный запрос с разрешённого сайта проходит, с чужого — нет', async () => {
  const { env } = await makeEnv();
  const ok = await call(env, '/subscribe', null, { method: 'OPTIONS' });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), 'https://auroramurmansk.ru');
  assert.match(ok.headers.get('Access-Control-Allow-Headers'), /Content-Type/);
  assert.equal(ok.headers.get('Vary'), 'Origin');

  const local = await call(env, '/subscribe', null, { method: 'OPTIONS', origin: 'http://localhost:8765' });
  assert.equal(local.status, 204);

  const bad = await call(env, '/subscribe', null, { method: 'OPTIONS', origin: 'https://evil.example' });
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get('Access-Control-Allow-Origin'), null);
});

test('POST без Origin или с чужим Origin отклоняется до любой работы с базой', async () => {
  const { env } = await makeEnv();
  for (const origin of [null, 'https://evil.example']) {
    const res = await call(env, '/subscribe', { endpoint: ep(1), point: 'murmansk' }, { origin });
    assert.equal(res.status, 403);
    assert.equal((await parse(res)).error, 'forbidden_origin');
  }
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) c FROM subs').get().c, 0);
});

test('/health отвечает и не раскрывает лишнего: только доступность и пульс проверок', async () => {
  const { env } = await makeEnv();
  const res = await call(env, '/health', null, { method: 'GET' });
  assert.equal(res.status, 200);
  assert.deepEqual(await parse(res), { ok: true, lastCheck: null, outcome: null }, 'проверок ещё не было');
});

test('/subscribe: создаёт подписку, повторный вызов ничего не дублирует', async () => {
  const { env } = await makeEnv();
  const first = await call(env, '/subscribe', { endpoint: ep(1), point: 'teriberka' }, {}, { now: NIGHT });
  assert.equal(first.status, 200);
  assert.deepEqual(await parse(first), { ok: true, point: 'teriberka' });
  assert.equal(first.headers.get('Access-Control-Allow-Origin'), 'https://auroramurmansk.ru');

  await call(env, '/subscribe', { endpoint: ep(1), point: 'teriberka' }, {}, { now: NIGHT + 5 * MIN });
  const rows = env.DB.raw.prepare('SELECT * FROM subs').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].point, 'teriberka');
  assert.equal(rows[0].created, NIGHT, 'повтор с той же точкой не сдвигает created');
});

test('/subscribe: смена точки сдвигает created, чтобы не разбудить о «высоком», которое уже идёт', async () => {
  const { env } = await makeEnv();
  await call(env, '/subscribe', { endpoint: ep(1), point: 'murmansk' }, {}, { now: NIGHT });
  await call(env, '/subscribe', { endpoint: ep(1), point: 'kirovsk' }, {}, { now: NIGHT + 30 * MIN });

  const row = env.DB.raw.prepare('SELECT * FROM subs').get();
  assert.equal(row.point, 'kirovsk');
  assert.equal(row.created, NIGHT + 30 * MIN);
});

test('/subscribe: неверные данные отклоняются с понятными кодами', async () => {
  const { env } = await makeEnv();
  const cases = [
    [{ endpoint: ep(1), point: 'moscow' }, 400, 'bad_point'],
    [{ endpoint: ep(1) }, 400, 'bad_point'],
    [{ endpoint: 'https://evil.example/x', point: 'murmansk' }, 400, 'bad_endpoint'],
    [{ endpoint: 42, point: 'murmansk' }, 400, 'bad_endpoint'],
    [{ point: 'murmansk' }, 400, 'bad_endpoint']
  ];
  for (const [body, status, error] of cases) {
    const res = await call(env, '/subscribe', body);
    assert.equal(res.status, status, JSON.stringify(body));
    assert.equal((await parse(res)).error, error);
  }

  const notJson = await call(env, '/subscribe', null, { raw: '{не json' });
  assert.equal(notJson.status, 400);
  assert.equal((await parse(notJson)).error, 'bad_json');

  const arrayBody = await call(env, '/subscribe', null, { raw: '"строка"' });
  assert.equal(arrayBody.status, 400);

  const huge = await call(env, '/subscribe', null, { raw: JSON.stringify({ endpoint: ep(1), point: 'murmansk', pad: 'x'.repeat(5000) }) });
  assert.equal(huge.status, 413);

  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) c FROM subs').get().c, 0, 'ничего не сохранилось');
});

test('/subscribe: потолок числа подписок защищает базу, а действующие подписки продолжают работать', async () => {
  const { env } = await makeEnv();
  await call(env, '/subscribe', { endpoint: ep(1), point: 'murmansk' });   // подписан до переполнения

  const insert = env.DB.raw.prepare('INSERT INTO subs(id, endpoint, point, created) VALUES(?, ?, ?, ?)');
  env.DB.raw.exec('BEGIN');
  for (let i = 0; i < MAX_SUBS - 1; i++) insert.run('bulk-' + i, ep(1000 + i), 'murmansk', NIGHT);
  env.DB.raw.exec('COMMIT');
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) c FROM subs').get().c, MAX_SUBS);

  const denied = await call(env, '/subscribe', { endpoint: ep(2), point: 'murmansk' });
  assert.equal(denied.status, 503);
  assert.equal((await parse(denied)).error, 'limit');

  const existing = await call(env, '/subscribe', { endpoint: ep(1), point: 'teriberka' });
  assert.equal(existing.status, 200, 'уже подписанный может сменить точку и при заполненной базе');
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) c FROM subs').get().c, MAX_SUBS, 'число подписок не выросло');
});

test('/unsubscribe удаляет подписку и не падает, если её нет', async () => {
  const { env } = await makeEnv();
  await call(env, '/subscribe', { endpoint: ep(1), point: 'murmansk' });
  assert.equal((await call(env, '/unsubscribe', { endpoint: ep(1) })).status, 200);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) c FROM subs').get().c, 0);
  assert.equal((await call(env, '/unsubscribe', { endpoint: ep(1) })).status, 200);
});

test('/message: 404 пока сообщения нет, затем текст, который заберёт service worker', async () => {
  const { env } = await makeEnv();
  await call(env, '/subscribe', { endpoint: ep(1), point: 'murmansk' });

  const none = await call(env, '/message', { endpoint: ep(1) });
  assert.equal(none.status, 404);

  env.DB.raw.prepare('UPDATE subs SET msg = ?').run(JSON.stringify({ title: 'Заголовок', body: 'Текст' }));
  const res = await call(env, '/message', { endpoint: ep(1) });
  assert.equal(res.status, 200);
  assert.deepEqual(await parse(res), { title: 'Заголовок', body: 'Текст' });
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://auroramurmansk.ru');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');

  assert.equal((await call(env, '/message', { endpoint: ep(2) })).status, 404, 'чужому адресу сообщения не выдаются');
});

test('/test: без подписки 404; без задержки шлёт push и честно сообщает статус', async () => {
  const { env } = await makeEnv();
  assert.equal((await call(env, '/test', { endpoint: ep(1) })).status, 404);

  await call(env, '/subscribe', { endpoint: ep(1), point: 'murmansk' });
  const fetch = makeFetch(NIGHT);
  const res = await call(env, '/test', { endpoint: ep(1) }, {}, { fetch });
  assert.deepEqual(await parse(res), { ok: true, status: 201, delay: 0 });
  assert.equal(fetch.pushCalls().length, 1);

  const msg = JSON.parse(env.DB.raw.prepare('SELECT msg FROM subs').get().msg);
  assert.equal(msg.test, true);
  assert.match(msg.body, /Мурманск/);

  // если push-сервис отказал, страница узнает об этом, а не получит «ок»
  await call(env, '/subscribe', { endpoint: ep(2), point: 'murmansk' });
  const refusing = makeFetch(NIGHT, { pushStatus: { [ep(2)]: 403 } });
  const bad = await call(env, '/test', { endpoint: ep(2) }, {}, { fetch: refusing });
  assert.deepEqual(await parse(bad), { ok: false, status: 403, delay: 0 });
});

test('/test: подписка, которую push-сервис уже не знает (410), удаляется', async () => {
  const { env } = await makeEnv();
  await call(env, '/subscribe', { endpoint: ep(1), point: 'murmansk' });
  const fetch = makeFetch(NIGHT, { pushStatus: { [ep(1)]: 410 } });
  await call(env, '/test', { endpoint: ep(1) }, {}, { fetch });
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) c FROM subs').get().c, 0);
});

test('/test: не чаще раза в 20 секунд', async () => {
  const { env } = await makeEnv();
  await call(env, '/subscribe', { endpoint: ep(1), point: 'murmansk' });
  assert.equal((await call(env, '/test', { endpoint: ep(1) }, {}, { now: NIGHT })).status, 200);
  assert.equal((await call(env, '/test', { endpoint: ep(1) }, {}, { now: NIGHT + 5000 })).status, 429);
  assert.equal((await call(env, '/test', { endpoint: ep(1) }, {}, { now: NIGHT + 21000 })).status, 200);
});

test('/test с задержкой: ответ сразу, отправка в фоне; задержка ограничена 20 секундами', async () => {
  const { env } = await makeEnv();
  await call(env, '/subscribe', { endpoint: ep(1), point: 'murmansk' });

  const waits = [];
  const sleep = ms => { waits.push(ms); return Promise.resolve(); };
  const ctx = fakeCtx();
  const fetch = makeFetch(NIGHT);

  const res = await call(env, '/test', { endpoint: ep(1), delay: 999 }, {}, { ctx, fetch, sleep });
  assert.deepEqual(await parse(res), { ok: true, delay: 20 });
  assert.equal(fetch.pushCalls().length, 0, 'до ответа ничего не отправлено');
  assert.equal(ctx.pending.length, 1, 'отправка отдана в waitUntil');

  await ctx.pending[0];
  assert.deepEqual(waits, [20000]);
  assert.equal(fetch.pushCalls().length, 1);
});

test('/test: странные значения задержки сводятся к нулю или к границам', async () => {
  const { env } = await makeEnv();
  await call(env, '/subscribe', { endpoint: ep(1), point: 'murmansk' });
  let n = 0;
  for (const [delay, expected] of [[-5, 0], ['abc', 0], [null, 0], [7.6, 8], [0, 0]]) {
    const res = await call(env, '/test', { endpoint: ep(1), delay }, {}, {
      now: NIGHT + (n++) * MIN, fetch: makeFetch(NIGHT), ctx: fakeCtx(), sleep: () => Promise.resolve()
    });
    assert.equal((await parse(res)).delay, expected, 'delay=' + JSON.stringify(delay));
  }
});

test('неизвестный путь и не-POST дают 404', async () => {
  const { env } = await makeEnv();
  assert.equal((await call(env, '/nope', { endpoint: ep(1) })).status, 404);
  assert.equal((await call(env, '/subscribe', null, { method: 'GET' })).status, 404);
});
