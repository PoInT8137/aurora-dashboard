// Telegram-бот для посетителей: подлинность webhook, разговор (команды и кнопки), регистрация
// webhook, рассылка сигналов подписчикам Telegram.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/api.js';
import { runCheck } from '../src/check.js';
import { webhookSecret, ensureTelegram, tgLang, telegramReply, WEBHOOK_VERSION } from '../src/telegram.js';
import { makeEnv, makeFetch, fakeCtx, NIGHT, MIN, HOUR } from './helpers.mjs';

const TOKEN = '123:test';

async function botEnv() {
  const { env } = await makeEnv();
  env.TELEGRAM_TOKEN = TOKEN;
  env.PUBLIC_URL = 'https://aurora-push.example.workers.dev';
  return env;
}

const msg = (text, { chat = 7, lang = 'ru', type = 'private' } = {}) => ({ message: { chat: { id: chat, type }, from: { id: chat, language_code: lang }, text } });
const tap = (data, { chat = 7, lang = 'ru' } = {}) => ({ callback_query: { id: 'cb1', data, from: { id: chat, language_code: lang }, message: { chat: { id: chat, type: 'private' } } } });
const sub = (env, chat = '7') => env.DB.raw.prepare('SELECT * FROM tg_subs WHERE chat_id = ?').get(chat);

async function post(env, update, { secret, now = NIGHT, fetchFn = makeFetch(now) } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (secret !== null) headers['X-Telegram-Bot-Api-Secret-Token'] = secret ?? await webhookSecret(TOKEN);
  const res = await handleRequest(new Request('https://aurora-push.example.workers.dev/telegram', { method: 'POST', headers, body: JSON.stringify(update) }), env, fakeCtx(), now, fetchFn);
  return { status: res.status, fetchFn };
}

test('webhook: без заголовка или с чужим секретом — 403, без токена — 404; ни одного вызова Telegram', async () => {
  const env = await botEnv();
  for (const secret of [null, 'guess', await webhookSecret('другой токен')]) {
    const r = await post(env, msg('/start'), { secret });
    assert.equal(r.status, 403);
    assert.equal(r.fetchFn.telegram.length, 0);
  }
  const { env: bare } = await makeEnv();
  assert.equal((await post(bare, msg('/start'))).status, 404);
  assert.match(await webhookSecret(TOKEN), /^[0-9a-f]{48}$/, 'допустимые для Telegram символы');
});

test('/start — приветствие и точки кнопками, на языке Telegram-клиента', async () => {
  const env = await botEnv();
  const { status, fetchFn } = await post(env, msg('/start', { lang: 'en-US' }));
  assert.equal(status, 200);
  const sent = fetchFn.telegram[0];
  assert.equal(sent.method, 'sendMessage');
  assert.match(sent.body.text, /^Hi! I will let you know/);
  const buttons = sent.body.reply_markup.inline_keyboard.flat();
  assert.equal(buttons.length, 7);
  assert.deepEqual(buttons[1], { text: 'Teriberka', callback_data: 'p:teriberka' });
  assert.equal(sub(env), undefined, 'ещё не подписан');
  assert.deepEqual(['ru', 'en', 'zh', 'en', 'en'].map((_, i) => tgLang(['ru', 'en-GB', 'zh-hans', 'de', undefined][i])), ['ru', 'en', 'zh', 'en', 'en']);
});

test('выбор точки кнопкой и ссылка ?start=<точка> — подписка; смена точки — отсчёт заново', async () => {
  const env = await botEnv();
  const { fetchFn } = await post(env, tap('p:teriberka'));
  assert.equal(fetchFn.telegram[0].method, 'answerCallbackQuery');
  assert.match(fetchFn.telegram[1].body.text, /^Готово: уведомления для точки «Териберка»/);
  assert.deepEqual([sub(env).point, sub(env).created, sub(env).lang, sub(env).min_level, sub(env).bz], ['teriberka', NIGHT, 'ru', 'high', 1]);

  await post(env, msg('/start teriberka'), { now: NIGHT + HOUR });
  assert.equal(sub(env).created, NIGHT, 'та же точка — отсчёт не сбрасывается');
  await post(env, msg('/start kirovsk'), { now: NIGHT + 2 * HOUR });
  assert.deepEqual([sub(env).point, sub(env).created], ['kirovsk', NIGHT + 2 * HOUR]);
  await post(env, msg('/start nowhere'));
  assert.equal(sub(env).point, 'kirovsk', 'неизвестная точка не подписывает');
});

test('настройки кнопками: порог «средний», ранний сигнал выкл; /settings показывает их', async () => {
  const env = await botEnv();
  await post(env, tap('p:murmansk'));
  await post(env, tap('l:mid'));
  await post(env, tap('b:0'));
  assert.deepEqual([sub(env).min_level, sub(env).bz], ['mid', 0]);
  const { fetchFn } = await post(env, msg('/settings'));
  assert.equal(fetchFn.telegram[0].body.text, 'Точка: «Мурманск»\nСообщать: о среднем и высоком шансе\nРанний сигнал о Bz: выкл');
  const labels = fetchFn.telegram[0].body.reply_markup.inline_keyboard.flat().map(b => b.text);
  assert.ok(labels.includes('Только о высоком') && labels.includes('Ранний сигнал: вкл'), labels.join(', '));
});

test('/now — уровень из последней проверки; нет свежей — честно; /stop и кнопка «Отписаться» удаляют подписку', async () => {
  const env = await botEnv();
  await post(env, tap('p:murmansk'));
  env.DB.raw.prepare('INSERT INTO point_state(point, level, high_since, updated) VALUES(?, ?, 0, ?)').run('murmansk', 'mid', NIGHT - 4 * MIN);
  let r = await post(env, msg('/now'));
  assert.match(r.fetchFn.telegram[0].body.text, /^Мурманск: средний шанс \(проверено 4 мин назад\)\nhttps:\/\/auroramurmansk\.ru\/\?lang=ru#now$/);
  r = await post(env, msg('/now'), { now: NIGHT + HOUR });
  assert.match(r.fetchFn.telegram[0].body.text, /данных пока нет/);

  await post(env, msg('/stop'));
  assert.equal(sub(env), undefined);
  await post(env, tap('p:murmansk'));
  await post(env, tap('stop'));
  assert.equal(sub(env), undefined);
  r = await post(env, msg('/now'));
  assert.match(r.fetchFn.telegram[0].body.text, /^Привет!/, 'без подписки — снова предложить точки');
});

test('группы и каналы не обслуживаются; любой другой текст — подсказка по командам', async () => {
  const env = await botEnv();
  assert.deepEqual(await telegramReply(env, msg('/start', { type: 'group' }), NIGHT), []);
  await post(env, tap('p:murmansk'));
  const { fetchFn } = await post(env, msg('привет'));
  assert.match(fetchFn.telegram[0].body.text, /^Команды:/);
});

test('регистрация webhook: адрес, секрет, только нужные события, меню на трёх языках — один раз', async () => {
  const env = await botEnv();
  const f = makeFetch(NIGHT);
  assert.equal(await ensureTelegram(env, f), 'registered');
  const hook = f.telegram.find(c => c.method === 'setWebhook').body;
  assert.equal(hook.url, 'https://aurora-push.example.workers.dev/telegram');
  assert.equal(hook.secret_token, await webhookSecret(TOKEN));
  assert.deepEqual(hook.allowed_updates, ['message', 'callback_query']);
  assert.equal(f.telegram.filter(c => c.method === 'setMyCommands').length, 3);
  assert.equal(env.DB.raw.prepare("SELECT value FROM meta WHERE key = 'tg_webhook'").get().value, WEBHOOK_VERSION);

  const again = makeFetch(NIGHT);
  assert.equal(await ensureTelegram(env, again), 'ready');
  assert.equal(again.telegram.length, 0);
  const { env: bare } = await makeEnv();
  assert.equal(await ensureTelegram(bare, again), null, 'без токена — ничего');
});

/* ---------------- рассылка ---------------- */

async function subscribed(env, point = 'murmansk', created = NIGHT - HOUR, extra = {}) {
  env.DB.raw.prepare('INSERT INTO tg_subs(chat_id, point, lang, created, min_level, bz) VALUES(?, ?, ?, ?, ?, ?)')
    .run(extra.chat || '7', point, extra.lang || 'ru', created, extra.min_level || 'high', extra.bz ?? 1);
}
const run = (env, now, world) => { const f = makeFetch(now, world); return runCheck(env, now, f).then(summary => ({ summary, f })); };
const alerts = f => f.telegram.filter(c => c.method === 'sendMessage');

test('высокий шанс: подписчик Telegram получает сообщение, даже если подписчиков в браузере нет', async () => {
  const env = await botEnv();
  env.DB.raw.prepare("INSERT INTO meta(key, value) VALUES('tg_webhook', ?)").run(WEBHOOK_VERSION);
  await subscribed(env);
  await run(env, NIGHT, { kp: 0.3 });
  const { summary, f } = await run(env, NIGHT + 10 * MIN, { kp: 4.3 });
  assert.equal(summary.tgSent, 1);
  const [m] = alerts(f);
  assert.equal(m.body.chat_id, '7');
  assert.match(m.body.text, /^Высокий шанс увидеть сияние — Мурманск\nKp 4,3 · облачность \d+% · тёмное небо\. Смотрите на север\.\nhttps:\/\/auroramurmansk\.ru\/\?lang=ru#now$/);
  assert.equal(sub(env).last_sent, NIGHT + 10 * MIN);
  assert.equal((await run(env, NIGHT + 20 * MIN, { kp: 4.3 })).summary.tgSent, 0, 'повторов нет');
});

test('порог «средний» и ранний сигнал о Bz — для тех, кто их выбрал', async () => {
  const env = await botEnv();
  env.DB.raw.prepare("INSERT INTO meta(key, value) VALUES('tg_webhook', ?)").run(WEBHOOK_VERSION);
  await subscribed(env, 'murmansk', NIGHT - HOUR, { chat: '1', min_level: 'mid' });
  await subscribed(env, 'murmansk', NIGHT - HOUR, { chat: '2', lang: 'en' });
  await subscribed(env, 'murmansk', NIGHT - HOUR, { chat: '3', bz: 0 });
  await run(env, NIGHT, { kp: 0.3, bz: -12 });
  const { f } = await run(env, NIGHT + 10 * MIN, { kp: 1.3, bz: -12 });
  const byChat = Object.fromEntries(alerts(f).map(m => [m.body.chat_id, m.body.text]));
  assert.match(byChat['1'], /^Средний шанс увидеть сияние — Мурманск/);
  assert.match(byChat['2'], /^Aurora may start within the hour — Murmansk/);
  assert.equal(byChat['3'], undefined, 'ранний сигнал выключен, порог — только высокий');
});

test('бот заблокирован пользователем — подписка удаляется', async () => {
  const env = await botEnv();
  env.DB.raw.prepare("INSERT INTO meta(key, value) VALUES('tg_webhook', ?)").run(WEBHOOK_VERSION);
  await subscribed(env);
  await run(env, NIGHT, { kp: 0.3 });
  await run(env, NIGHT + 10 * MIN, { kp: 4.3, telegramStatus: 403 });
  assert.equal(sub(env), undefined);
});

test('база до миграции (нет tg_subs) — браузерные уведомления идут как раньше', async () => {
  const env = await botEnv();
  env.DB.raw.exec('DROP TABLE tg_subs');
  env.DB.raw.prepare('INSERT INTO subs(id, endpoint, point, created) VALUES(?, ?, ?, ?)').run('x', 'https://fcm.googleapis.com/fcm/send/device-9', 'murmansk', NIGHT - HOUR);
  await run(env, NIGHT, { kp: 0.3 });
  const { summary } = await run(env, NIGHT + 10 * MIN, { kp: 4.3 });
  assert.equal(summary.sent, 1);
});
