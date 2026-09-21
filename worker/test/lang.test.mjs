// Язык уведомлений: подписка запоминает язык страницы, а рассылка и пробное сообщение говорят на нём.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runCheck } from '../src/check.js';
import { handleRequest } from '../src/api.js';
import { alertMessage, testMessage, normalizeLang, LANGS } from '../src/messages.js';
import { makeEnv, makeFetch, addSub, apiRequest, fakeCtx, ep, subRow, NIGHT, MIN, HOUR } from './helpers.mjs';

const T0 = NIGHT;
const T1 = NIGHT + 10 * MIN;
const CYRILLIC = /[А-Яа-яЁё]/;
const CJK = /[一-鿿]/;

const call = (env, path, body, now = NIGHT) =>
  handleRequest(apiRequest(path, body), env, fakeCtx(), now, makeFetch(now));

const run = (env, now, world = {}) => runCheck(env, now, makeFetch(now, world));

test('normalizeLang: известные языки проходят, остальное — null', () => {
  for (const code of LANGS) assert.equal(normalizeLang(code), code);
  for (const bad of ['xx', 'RU', '', null, undefined, 5, {}, '__proto__', 'zh-CN']) assert.equal(normalizeLang(bad), null, String(bad));
});

test('/subscribe: язык сохраняется; не указан — у новой русский, у существующей прежний', async () => {
  const { env } = await makeEnv();
  await call(env, '/subscribe', { endpoint: ep(1), point: 'murmansk', lang: 'zh' });
  assert.equal(subRow(env, 1).lang, 'zh');

  // старая версия страницы язык не шлёт — выбор не сбрасывается
  await call(env, '/subscribe', { endpoint: ep(1), point: 'teriberka' });
  assert.equal(subRow(env, 1).lang, 'zh');
  assert.equal(subRow(env, 1).point, 'teriberka');

  // смена языка на сайте
  await call(env, '/subscribe', { endpoint: ep(1), point: 'teriberka', lang: 'en' });
  assert.equal(subRow(env, 1).lang, 'en');

  // мусор вместо языка игнорируется
  await call(env, '/subscribe', { endpoint: ep(1), point: 'teriberka', lang: 'klingon' });
  assert.equal(subRow(env, 1).lang, 'en');

  await call(env, '/subscribe', { endpoint: ep(2), point: 'murmansk' });
  assert.equal(subRow(env, 2).lang, 'ru');
  await call(env, '/subscribe', { endpoint: ep(3), point: 'murmansk', lang: 'fr' });
  assert.equal(subRow(env, 3).lang, 'ru');
});

test('смена только языка не сдвигает created: подписчика не лишают уведомления о текущем «высоком» и не дают лишнего', async () => {
  const { env } = await makeEnv();
  await call(env, '/subscribe', { endpoint: ep(1), point: 'murmansk', lang: 'ru' }, NIGHT);
  await call(env, '/subscribe', { endpoint: ep(1), point: 'murmansk', lang: 'en' }, NIGHT + 5 * MIN);
  assert.equal(subRow(env, 1).created, NIGHT);
});

test('рассылка: каждый получает текст на своём языке, названия точек и числа — по правилам языка', async () => {
  const { env } = await makeEnv();
  addSub(env, { n: 1, lang: 'ru' });
  addSub(env, { n: 2, lang: 'en' });
  addSub(env, { n: 3, lang: 'zh' });
  addSub(env, { n: 4 });                                 // старая подписка без языка
  await run(env, T0, { kp: 0.3 });

  const summary = await run(env, T1, { kp: 4.3 });
  assert.equal(summary.sent, 4);

  const msg = n => JSON.parse(subRow(env, n).msg);
  assert.equal(msg(1).title, 'Высокий шанс увидеть сияние — Мурманск');
  assert.match(msg(1).body, /^Kp 4,3 · облачность \d+% · тёмное небо\. Смотрите на север\.$/);
  assert.equal(msg(2).title, 'High chance of aurora — Murmansk');
  assert.match(msg(2).body, /^Kp 4\.3 · cloud cover \d+% · dark sky\. Look north\.$/);
  assert.equal(msg(3).title, '极光机会大——摩尔曼斯克');
  assert.match(msg(3).body, /^Kp 4\.3 · 云量 \d+% · 夜空漆黑。请朝北看。$/);
  assert.deepEqual(msg(4), msg(1), 'без языка — русский');
  assert.deepEqual([1, 2, 3, 4].map(n => msg(n).lang), ['ru', 'en', 'zh', 'ru']);
});

test('в уведомлении на английском и китайском нет кириллицы для любой точки', () => {
  const core = globalThis.AuroraCore;
  for (const point of core.POINTS) {
    const en = alertMessage(point, { value: 5.7 }, { value: 12 }, 0, 'en');
    const zh = alertMessage(point, { value: 5.7 }, { value: 12 }, 0, 'zh');
    assert.doesNotMatch(en.title + en.body, CYRILLIC, point.id);
    assert.doesNotMatch(zh.title + zh.body, CYRILLIC, point.id);
    assert.match(zh.title, CJK);
    assert.ok(en.title.endsWith(point.names.en));
    assert.ok(zh.title.endsWith(point.names.zh));
  }
});

test('alertMessage и testMessage: неизвестный язык — русский, точка без названий — берётся имя', () => {
  const point = { id: 'x', name: 'Иксград' };
  assert.equal(alertMessage(point, { value: 4.3 }, { value: 9 }, 1, 'fr').title, 'Высокий шанс увидеть сияние — Иксград');
  assert.equal(alertMessage(point, { value: 4.3 }, { value: 9 }, 1, 'en').title, 'High chance of aurora — Иксград');
  assert.equal(testMessage('gone-point', 1, 'en').body.includes('“gone-point”'), true);
  assert.equal(testMessage(point, 1, undefined).title, 'Пробное уведомление');
});

test('/test: пробное уведомление — на языке подписки', async () => {
  const { env } = await makeEnv();
  await call(env, '/subscribe', { endpoint: ep(1), point: 'teriberka', lang: 'en' });
  const res = await call(env, '/test', { endpoint: ep(1) }, NIGHT + HOUR);
  assert.equal(res.status, 200);
  const msg = JSON.parse(subRow(env, 1).msg);
  assert.equal(msg.title, 'Test notification');
  assert.match(msg.body, /at “Teriberka” the same way/);
  assert.equal(msg.test, true);
  assert.equal(msg.lang, 'en');

  await call(env, '/subscribe', { endpoint: ep(1), point: 'teriberka', lang: 'zh' }, NIGHT + 2 * HOUR);
  await call(env, '/test', { endpoint: ep(1) }, NIGHT + 3 * HOUR);
  const zh = JSON.parse(subRow(env, 1).msg);
  assert.equal(zh.title, '测试通知');
  assert.match(zh.body, /“捷里别尔卡”/);
});

test('/message отдаёт ровно то, что сохранено, вместе с языком — service worker берёт его для уведомления', async () => {
  const { env } = await makeEnv();
  addSub(env, { n: 1, lang: 'zh' });
  await run(env, T0, { kp: 0.3 });
  await run(env, T1, { kp: 4.3 });
  const res = await call(env, '/message', { endpoint: ep(1) }, T1 + MIN);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).lang, 'zh');
});
