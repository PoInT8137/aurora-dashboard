// Мониторинг источников: сбой дольше 20 минут — сообщение владельцу, напоминание раз в 6 часов,
// «снова работает» после восстановления; без секретов или при недоступном Telegram ничего не теряется.
import test from 'node:test';
import assert from 'node:assert/strict';
import { monitorStep, ALERT_AFTER_MS, REMIND_EVERY_MS } from '../src/monitor.js';
import { makeEnv, NIGHT, MIN, HOUR } from './helpers.mjs';

const TOKEN = 'test-token';
const CHAT = '42';

/** Внешний мир: что сломано и что отвечает Telegram. */
function world(now, { kpAgeMin = 1, swDown = false, meteoDown = false, siteStatus = 200, telegram = 200 } = {}) {
  const sent = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.telegram.org/')) {
      if (telegram === 'down') throw new TypeError('down');
      sent.push({ url: u, body: JSON.parse(init.body) });
      return new Response('{"ok":true}', { status: telegram });
    }
    if (u.includes('planetary_k_index_1m')) {
      return new Response(JSON.stringify([{ time_tag: new Date(now - kpAgeMin * MIN).toISOString().slice(0, 19), kp_index: 2, estimated_kp: 2 }]));
    }
    if (u.includes('solar-wind-mag-field')) {
      if (swDown) return new Response('down', { status: 503 });
      return new Response(JSON.stringify([{ bt: 5, bz_gsm: 1, time_tag: new Date(now - 5 * MIN).toISOString().slice(0, 19) }]));
    }
    if (u.includes('api.open-meteo.com')) {
      if (meteoDown) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify({ current: { cloud_cover: 40 } }));
    }
    if (u.startsWith('https://auroramurmansk.ru/')) return new Response('sw', { status: siteStatus });
    return new Response('?', { status: 404 });
  };
  fn.sent = sent;
  return fn;
}

async function env({ secrets = true } = {}) {
  const { env } = await makeEnv();
  if (secrets) { env.TELEGRAM_TOKEN = TOKEN; env.TELEGRAM_OWNER_CHAT = CHAT; }
  return env;
}
const rows = e => e.DB.raw.prepare('SELECT * FROM monitor ORDER BY source').all().map(r => ({ ...r }));

test('всё в порядке — ни записей, ни сообщений', async () => {
  const e = await env();
  const w = world(NIGHT);
  const r = await monitorStep(e, NIGHT, w);
  assert.deepEqual(r, { problems: [], sent: 0, pending: 0 });
  assert.equal(rows(e).length, 0);
  assert.equal(w.sent.length, 0);
});

test('сбой: первая осечка — тихо, через 20 минут — сообщение; дальше тишина до напоминания; вернулся — «снова работает»', async () => {
  const e = await env();
  const broken = { kpAgeMin: 90 };
  const w0 = world(NIGHT, broken);
  assert.deepEqual((await monitorStep(e, NIGHT, w0)).problems, ['noaa_kp']);
  assert.equal(w0.sent.length, 0, 'одна осечка — не повод');

  const w1 = world(NIGHT + 10 * MIN, broken);
  await monitorStep(e, NIGHT + 10 * MIN, w1);
  assert.equal(w1.sent.length, 0);

  const w2 = world(NIGHT + ALERT_AFTER_MS, broken);
  await monitorStep(e, NIGHT + ALERT_AFTER_MS, w2);
  assert.equal(w2.sent.length, 1);
  assert.equal(w2.sent[0].url, 'https://api.telegram.org/bot' + TOKEN + '/sendMessage');
  assert.equal(w2.sent[0].body.chat_id, CHAT);
  assert.match(w2.sent[0].body.text, /^⚠️ Не работает: Kp \(NOAA\) — последнее измерение \d+ мин назад \(уже 20 мин\)\.$/);

  const w3 = world(NIGHT + ALERT_AFTER_MS + 10 * MIN, broken);
  await monitorStep(e, NIGHT + ALERT_AFTER_MS + 10 * MIN, w3);
  assert.equal(w3.sent.length, 0, 'не спамим');

  const later = NIGHT + ALERT_AFTER_MS + REMIND_EVERY_MS;
  const w4 = world(later, broken);
  await monitorStep(e, later, w4);
  assert.match(w4.sent[0].body.text, /^⚠️ Всё ещё не работает: Kp \(NOAA\)/);

  const w5 = world(later + 10 * MIN);
  await monitorStep(e, later + 10 * MIN, w5);
  assert.match(w5.sent[0].body.text, /^✅ Снова работает: Kp \(NOAA\) \(сбой длился 6 ч 30 мин\)\.$/);
  assert.equal(rows(e).length, 0);
});

test('короткий сбой, о котором не сообщали, проходит молча', async () => {
  const e = await env();
  await monitorStep(e, NIGHT, world(NIGHT, { meteoDown: true }));
  const w = world(NIGHT + 10 * MIN);
  await monitorStep(e, NIGHT + 10 * MIN, w);
  assert.equal(w.sent.length, 0);
  assert.equal(rows(e).length, 0);
});

test('несколько источников сразу — одно сообщение со всеми', async () => {
  const e = await env();
  const broken = { swDown: true, meteoDown: true, siteStatus: 500 };
  await monitorStep(e, NIGHT, world(NIGHT, broken));
  const w = world(NIGHT + ALERT_AFTER_MS, broken);
  const r = await monitorStep(e, NIGHT + ALERT_AFTER_MS, w);
  assert.deepEqual(r.problems.sort(), ['noaa_sw', 'open_meteo', 'site']);
  assert.equal(w.sent.length, 1);
  const text = w.sent[0].body.text;
  assert.match(text, /Солнечный ветер \(NOAA\) — ответ 503/);
  assert.match(text, /Open-Meteo — Failed to fetch/);
  assert.match(text, /Сайт auroramurmansk\.ru — ответ 500/);
});

test('секретов нет или Telegram не ответил — сбой не считается сообщённым и уйдёт при следующей возможности', async () => {
  const e = await env({ secrets: false });
  const broken = { kpAgeMin: 90 };
  await monitorStep(e, NIGHT, world(NIGHT, broken));
  const r = await monitorStep(e, NIGHT + ALERT_AFTER_MS, world(NIGHT + ALERT_AFTER_MS, broken));
  assert.deepEqual([r.sent, r.pending], [0, 1]);
  assert.equal(rows(e)[0].notified_at, 0);

  e.TELEGRAM_TOKEN = TOKEN; e.TELEGRAM_OWNER_CHAT = CHAT;
  const down = world(NIGHT + ALERT_AFTER_MS + 10 * MIN, { ...broken, telegram: 'down' });
  await monitorStep(e, NIGHT + ALERT_AFTER_MS + 10 * MIN, down);
  assert.equal(rows(e)[0].notified_at, 0, 'Telegram недоступен — пробуем снова');

  const ok = world(NIGHT + ALERT_AFTER_MS + 20 * MIN, broken);
  await monitorStep(e, NIGHT + ALERT_AFTER_MS + 20 * MIN, ok);
  assert.equal(ok.sent.length, 1);
  assert.equal(rows(e)[0].notified_at, NIGHT + ALERT_AFTER_MS + 20 * MIN);
});

test('проверка NOAA падает с ошибкой разбора — это тоже сбой, а не падение прохода', async () => {
  const e = await env();
  const w = async url => (String(url).includes('planetary_k_index_1m') ? new Response('<html>oops') : world(NIGHT)(url));
  const r = await monitorStep(e, NIGHT, w);
  assert.deepEqual(r.problems, ['noaa_kp']);
  assert.ok(rows(e)[0].detail);
});
