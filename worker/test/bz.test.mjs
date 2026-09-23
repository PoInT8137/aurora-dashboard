// Ранний сигнал «Bz повернул на юг»: разбор сводки NOAA, длительность южного поля между
// проходами, условия точки, кому и когда слать, тексты, устойчивость к базе без миграции.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runCheck } from '../src/check.js';
import { readBz, nextBzState, bzLevel, bzPointOk, BZ_COOLDOWN_MS } from '../src/bz.js';
import { bzMessage } from '../src/messages.js';
import '../../core.js';
import { makeEnv, makeFetch, addSub, ep, subRow, NIGHT, DAY, MIN, HOUR } from './helpers.mjs';

const Core = globalThis.AuroraCore;
const murmansk = Core.findPoint('murmansk');

const run = (env, now, world = {}) => {
  const fetch = makeFetch(now, world);
  return runCheck(env, now, fetch).then(summary => ({ summary, fetch }));
};
const pushedTo = fetch => fetch.pushCalls().map(c => c.url);
// Kp низкий: основной уровень «низкий», так что шлёт только ранний сигнал
const QUIET_KP = { kp: 0.7 };

test('сводка NOAA: Bz и время; устаревшая, будущая и мусор — нет данных', () => {
  const now = Date.parse('2026-09-23T23:30:00Z');
  assert.deepEqual(readBz([{ bt: 11, bz_gsm: -7.2, time_tag: '2026-09-23T23:25:00Z' }], now), { bz: -7.2, time: now - 5 * MIN });
  assert.deepEqual(readBz([{ bz_gsm: '-3', time_tag: '2026-09-23 23:25:00.000' }], now), { bz: -3, time: now - 5 * MIN }, 'формат без Z');
  assert.equal(readBz([{ bz_gsm: -7, time_tag: '2026-09-23T23:00:00Z' }], now), null, '30 минут — устарело');
  assert.equal(readBz([{ bz_gsm: -7, time_tag: '2026-09-24T00:00:00Z' }], now), null, 'из будущего');
  assert.equal(readBz([{ bz_gsm: null, time_tag: '2026-09-23T23:25:00Z' }], now), null);
  assert.equal(readBz([], now), null);
  assert.equal(readBz({ error: 1 }, now), null);
});

test('длительность южного поля: копится между проходами, сбрасывается северным полем и пропуском данных', () => {
  const t0 = NIGHT;
  let s = nextBzState(null, { bz: -6 }, t0);
  assert.equal(s.southSince, t0);
  s = nextBzState(s, { bz: -8 }, t0 + 10 * MIN);
  assert.equal(s.southSince, t0, 'продолжается');
  assert.equal(nextBzState(s, { bz: -4.9 }, t0 + 20 * MIN).southSince, 0, 'слабее −5 — уже не южное');
  assert.equal(nextBzState(s, null, t0 + 20 * MIN).southSince, 0, 'нет данных — не утверждаем');
  assert.equal(nextBzState(s, { bz: -8 }, t0 + 50 * MIN).southSince, t0 + 50 * MIN, 'после долгого перерыва — отсчёт заново');
});

test('уровень: сильный — ≤ −10 два прохода подряд; южный — ≤ −5 три прохода; иначе повода нет', () => {
  const t0 = NIGHT;
  assert.equal(bzLevel({ bz: -12, southSince: t0 }, t0), null, 'один отсчёт — могло мигнуть');
  assert.equal(bzLevel({ bz: -12, southSince: t0 }, t0 + 10 * MIN), 'strong');
  assert.equal(bzLevel({ bz: -7, southSince: t0 }, t0 + 10 * MIN), null);
  assert.equal(bzLevel({ bz: -7, southSince: t0 }, t0 + 20 * MIN), 'south');
  assert.equal(bzLevel({ bz: -3, southSince: 0 }, t0), null);
  assert.equal(bzLevel(null, t0), null);
});

test('точка годится только в темноте и не при сплошных облаках', () => {
  assert.equal(bzPointOk(murmansk, { value: 30, conflict: false }, NIGHT), true);
  assert.equal(bzPointOk(murmansk, { value: 70, conflict: false }, NIGHT), true, 'просветы есть');
  assert.equal(bzPointOk(murmansk, { value: 90, conflict: false }, NIGHT), false, 'небо закрыто');
  assert.equal(bzPointOk(murmansk, { value: 10, conflict: false }, DAY), false, 'светло');
  assert.equal(bzPointOk(murmansk, null, NIGHT), false);
});

test('поле держится южным — подписчик получает ранний сигнал один раз, текст на его языке', async () => {
  const { env } = await makeEnv();
  addSub(env, { n: 1, created: NIGHT - 2 * HOUR });
  addSub(env, { n: 2, created: NIGHT - 2 * HOUR, lang: 'en' });

  const first = await run(env, NIGHT, { ...QUIET_KP, bz: -12 });
  assert.equal(first.summary.bzSent, 0, 'один отсчёт — рано');
  const second = await run(env, NIGHT + 10 * MIN, { ...QUIET_KP, bz: -11 });
  assert.equal(second.summary.bz.level, 'strong');
  assert.equal(second.summary.bzSent, 2);
  assert.deepEqual(pushedTo(second.fetch).sort(), [ep(1), ep(2)].sort());

  const ru = JSON.parse(subRow(env, 1).msg);
  assert.equal(ru.title, 'Сияние может начаться в ближайший час — Мурманск');
  assert.match(ru.body, /^Магнитное поле солнечного ветра резко повернуло на юг: Bz −11,0 нТл\. Небо тёмное, облачность \d+%\./);
  assert.equal(ru.kind, 'bz');
  assert.equal(subRow(env, 1).last_bz, NIGHT + 10 * MIN);
  assert.equal(subRow(env, 1).last_sent, 0, 'лимит основных уведомлений не тронут');
  assert.match(JSON.parse(subRow(env, 2).msg).title, /^Aurora may start within the hour — Murmansk$/);

  // эпизод продолжается — повторов нет
  const third = await run(env, NIGHT + 20 * MIN, { ...QUIET_KP, bz: -14 });
  assert.equal(third.summary.bzSent, 0);
});

test('новый эпизод южного поля раньше чем через 6 часов — тишина, позже — снова сигнал', async () => {
  const { env } = await makeEnv();
  addSub(env, { n: 1, created: NIGHT - 2 * HOUR });
  await run(env, NIGHT, { ...QUIET_KP, bz: -12 });
  await run(env, NIGHT + 10 * MIN, { ...QUIET_KP, bz: -12 });
  assert.equal(subRow(env, 1).last_bz, NIGHT + 10 * MIN);

  await run(env, NIGHT + 2 * HOUR, { ...QUIET_KP, bz: 4 });          // повернуло на север
  await run(env, NIGHT + 2 * HOUR + 10 * MIN, { ...QUIET_KP, bz: -12 });
  const again = await run(env, NIGHT + 2 * HOUR + 20 * MIN, { ...QUIET_KP, bz: -12 });
  assert.equal(again.summary.bz.level, 'strong');
  assert.equal(again.summary.bzSent, 0, 'меньше 6 часов');

  const later = NIGHT + 10 * MIN + BZ_COOLDOWN_MS;
  await run(env, later - 10 * MIN, { ...QUIET_KP, bz: 4 });
  await run(env, later, { ...QUIET_KP, bz: -12 });
  const ok = await run(env, later + 10 * MIN, { ...QUIET_KP, bz: -12 });
  assert.equal(ok.summary.bzSent, 1);
});

test('не шлётся: днём, при сплошных облаках, когда уже «высокий», сразу после основного уведомления, в тихие часы', async () => {
  // днём
  let { env } = await makeEnv();
  addSub(env, { n: 1, created: DAY - 2 * HOUR });
  await run(env, DAY, { ...QUIET_KP, bz: -12 });
  assert.equal((await run(env, DAY + 10 * MIN, { ...QUIET_KP, bz: -12 })).summary.bzSent, 0);

  // сплошные облака
  ({ env } = await makeEnv());
  addSub(env, { n: 1, created: NIGHT - 2 * HOUR });
  const overcast = { ...QUIET_KP, bz: -12, cloud: () => ({ low: 100, mid: 100, high: 100, total: 100 }) };
  await run(env, NIGHT, overcast);
  assert.equal((await run(env, NIGHT + 10 * MIN, overcast)).summary.bzSent, 0);

  // уровень уже высокий: основное уведомление говорит то же самое
  ({ env } = await makeEnv());
  addSub(env, { n: 1, created: NIGHT - 2 * HOUR, lastSent: NIGHT - 5 * HOUR });
  await run(env, NIGHT, { kp: 0.3, bz: -12 });
  const high = await run(env, NIGHT + 10 * MIN, { kp: 4.3, bz: -12 });
  assert.equal(high.summary.sent, 1, 'основное ушло');
  assert.equal(high.summary.bzSent, 0, 'ранний — нет');

  // уровень высокий, но основное не ушло (было 2 часа назад, лимит — раз в 3 часа):
  // «может начаться» всё равно неуместно — оно уже идёт
  ({ env } = await makeEnv());
  addSub(env, { n: 1, created: NIGHT - 3 * HOUR, lastSent: NIGHT - 2 * HOUR });
  await run(env, NIGHT, { kp: 0.3, bz: -12 });
  const capped = await run(env, NIGHT + 10 * MIN, { kp: 4.3, bz: -12 });
  assert.equal(capped.summary.levels.murmansk, 'high');
  assert.equal(capped.summary.sent, 0);
  assert.equal(capped.summary.bzSent, 0);

  // основное уведомление было 20 минут назад, уровень опустился до среднего
  ({ env } = await makeEnv());
  addSub(env, { n: 1, created: NIGHT - 2 * HOUR, lastSent: NIGHT - 20 * MIN });
  await run(env, NIGHT, { ...QUIET_KP, bz: -12 });
  assert.equal((await run(env, NIGHT + 10 * MIN, { ...QUIET_KP, bz: -12 })).summary.bzSent, 0);

  // тихие часы: 22:00 UTC = 01:00 МСК
  ({ env } = await makeEnv());
  addSub(env, { n: 1, created: NIGHT - 2 * HOUR });
  env.DB.raw.prepare('UPDATE subs SET quiet_from = 0, quiet_to = 6, tz = ?').run('Europe/Moscow');
  await run(env, NIGHT, { ...QUIET_KP, bz: -12 });
  assert.equal((await run(env, NIGHT + 10 * MIN, { ...QUIET_KP, bz: -12 })).summary.bzSent, 0);
});

test('подписался уже во время эпизода — сигнал не придёт задним числом; сводка недоступна — тихо', async () => {
  const { env } = await makeEnv();
  addSub(env, { n: 1, created: NIGHT + 5 * MIN });
  await run(env, NIGHT, { ...QUIET_KP, bz: -12 });
  assert.equal((await run(env, NIGHT + 10 * MIN, { ...QUIET_KP, bz: -12 })).summary.bzSent, 0);

  const other = await makeEnv();
  addSub(other.env, { n: 2, created: NIGHT - 2 * HOUR });
  await run(other.env, NIGHT, { ...QUIET_KP, bz: -12 });
  const down = await run(other.env, NIGHT + 10 * MIN, { ...QUIET_KP, bzDown: true });
  assert.equal(down.summary.bzSent, 0);
  assert.equal(down.summary.bz.level, null, 'пропуск данных обрывает эпизод');
});

test('база без миграции (нет sw_state и last_bz): основные уведомления идут как раньше', async () => {
  const { env } = await makeEnv();
  env.DB.raw.exec('DROP TABLE sw_state');
  addSub(env, { n: 1, created: NIGHT - HOUR });
  await run(env, NIGHT, { kp: 0.3, bz: -12 });
  const { summary } = await run(env, NIGHT + 10 * MIN, { kp: 4.3, bz: -12 });
  assert.equal(summary.sent, 1);
  assert.equal(summary.bzError, true);
});

test('тексты раннего сигнала: три языка, знак минус и запятая по-русски, «резко» только для сильного', () => {
  const cloud = { value: 35 };
  const ru = bzMessage(murmansk, -7.26, cloud, 'south', NIGHT, 'ru');
  assert.match(ru.body, /^Магнитное поле солнечного ветра повернуло на юг: Bz −7,3 нТл\. Небо тёмное, облачность 35%\. Выходите заранее и смотрите на север\.$/);
  assert.match(bzMessage(murmansk, -12, cloud, 'strong', NIGHT, 'en').body, /turned sharply south: Bz −12\.0 nT/);
  const zh = bzMessage(Core.findPoint('teriberka'), -12, cloud, 'strong', NIGHT, 'zh');
  assert.equal(zh.title, '极光可能在一小时内出现——捷里别尔卡');
  assert.equal(bzMessage(murmansk, -8, cloud, 'south', NIGHT, 'xx').lang, 'ru');
});
