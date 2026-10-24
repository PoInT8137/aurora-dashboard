// Статистика посещений и журнал ошибок: приём со страницы, команды владельца в боте,
// /bug от посетителя, сообщения владельцу по расписанию и утренняя сводка.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/api.js';
import { runCheck } from '../src/check.js';
import { webhookSecret } from '../src/telegram.js';
import { mskDay, refHost, statsText, MAX_VISITORS_PER_DAY } from '../src/stats.js';
import { uaShort, cleanSrc, recordBug, NEW_BUGS_PER_HOUR, USER_BUGS_PER_DAY } from '../src/bugs.js';
import { makeEnv, makeFetch, fakeCtx, ORIGIN, NIGHT, MIN, HOUR } from './helpers.mjs';

const TOKEN = '123:test';
const OWNER = '1101';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

async function botEnv() {
  const { env } = await makeEnv();
  env.TELEGRAM_TOKEN = TOKEN;
  env.TELEGRAM_OWNER_CHAT = OWNER;
  env.PUBLIC_URL = 'https://aurora-push.example.workers.dev';
  return env;
}

function page(path, body, { origin = ORIGIN, ip = '1.2.3.4', ua = IPHONE } = {}) {
  // Страница шлёт text/plain — без предварительного запроса CORS.
  return new Request('https://aurora-push.example.workers.dev' + path, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'text/plain', Origin: origin, 'CF-Connecting-IP': ip, 'User-Agent': ua }
  });
}
const call = async (env, req, now = NIGHT) => {
  const res = await handleRequest(req, env, fakeCtx(), now, makeFetch(now));
  return { status: res.status, body: await res.json() };
};

async function tg(env, text, { chat = OWNER, now = NIGHT, data } = {}) {
  const update = data
    ? { callback_query: { id: 'cb', data, from: { id: Number(chat) }, message: { chat: { id: Number(chat), type: 'private' } } } }
    : { message: { chat: { id: Number(chat), type: 'private' }, from: { id: Number(chat), language_code: 'ru' }, text } };
  const fetchFn = makeFetch(now);
  await handleRequest(new Request('https://aurora-push.example.workers.dev/telegram', {
    method: 'POST', body: JSON.stringify(update),
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': await webhookSecret(TOKEN) }
  }), env, fakeCtx(), now, fetchFn);
  return fetchFn.telegram.filter(c => c.method === 'sendMessage').map(c => c.body);
}

test('посещение: одна строка на посетителя в сутки, повторы — просмотры; чужой сайт и localhost не считаются', async () => {
  const env = await botEnv();
  const hit = { lang: 'en', mobile: true, pwa: false, fresh: true, ref: 'https://www.yandex.ru/search?q=x', v: 'v61' };
  assert.deepEqual((await call(env, page('/hit', hit))).body, { ok: true, counted: true });
  await call(env, page('/hit', { ...hit, fresh: false }), NIGHT + MIN);
  await call(env, page('/hit', { lang: 'ru' }, { ip: '5.6.7.8', ua: WIN }));
  assert.deepEqual((await call(env, page('/hit', hit, { origin: 'http://localhost:8765' }))).body, { ok: true, counted: false });
  assert.equal((await call(env, page('/hit', hit, { origin: 'https://evil.example' }))).status, 403);

  const rows = env.DB.raw.prepare('SELECT * FROM visits ORDER BY views DESC').all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].views, 2);
  assert.equal(rows[0].ref, 'yandex.ru');
  assert.equal(rows[0].fresh, 1, 'первый визит дня решает');
  assert.match(rows[0].who, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(rows).includes('1.2.3.4'), 'адрес не хранится');

  // На следующие сутки тот же человек — новая строка с другим обезличенным id.
  await call(env, page('/hit', hit), NIGHT + 24 * HOUR);
  const ids = env.DB.raw.prepare("SELECT who FROM visits WHERE lang = 'en'").all().map(r => r.who);
  assert.equal(new Set(ids).size, 2);
});

test('посещения: потолок на сутки, свой сайт как источник не считается, дата — по Москве', async () => {
  assert.equal(refHost('https://auroramurmansk.ru/#now'), null);
  assert.equal(refHost('android-app://org.telegram.messenger/'), 'org.telegram.messenger');
  assert.equal(refHost('мусор'), null);
  assert.equal(mskDay(Date.UTC(2026, 9, 4, 21, 30)), '2026-10-05', '00:30 по Москве — уже новые сутки');

  const env = await botEnv();
  const day = mskDay(NIGHT);
  const insert = env.DB.raw.prepare('INSERT INTO visits(day, who, first_at, last_at) VALUES(?, ?, 0, 0)');
  for (let i = 0; i < MAX_VISITORS_PER_DAY; i++) insert.run(day, 'w' + i);
  assert.deepEqual((await call(env, page('/hit', {}))).body, { ok: true, counted: false });
});

test('/stats — только владельцу: сегодня, вчера, по дням, доли, источники, подписчики', async () => {
  const env = await botEnv();
  await call(env, page('/hit', { lang: 'ru', mobile: true, fresh: true, ref: 'https://vk.com/' }));
  await call(env, page('/hit', { lang: 'ru' }), NIGHT + MIN);
  await call(env, page('/hit', { lang: 'en', pwa: true }, { ip: '9.9.9.9', ua: WIN }));
  await call(env, page('/hit', { lang: 'ru' }, { ip: '8.8.8.8' }), NIGHT - 24 * HOUR);

  const [own] = await tg(env, '/stats');
  assert.match(own.text, /^📊 Посещения/);
  assert.match(own.text, /Сегодня: 2 посетителя, 3 просмотра/);
  assert.match(own.text, /Вчера: 1 посетитель, 1 просмотр/);
  assert.match(own.text, /7 дней: 3 посетителя, 4 просмотра/);
  assert.match(own.text, /впервые: 33%, с телефона: 33%, как приложение: 33%/);
  assert.match(own.text, /языки: ru 67%, en 33%/);
  assert.match(own.text, /Откуда пришли \(30 дней\): vk\.com 1/);
  assert.match(own.text, /Подписчики: push 0, Telegram 0/);

  // Посторонний — обычная справка/приветствие, без статистики.
  const [other] = await tg(env, '/stats', { chat: '42' });
  assert.doesNotMatch(other.text, /Посещения/);
  // Пустая база — без падений.
  assert.match(await statsText((await botEnv()), NIGHT), /Сегодня: 0 посетителей, 0 просмотров/);
});

test('ошибка страницы: склейка одинаковых, чистый путь файла, браузер коротко; localhost не пишется', async () => {
  const env = await botEnv();
  const err = { msg: "Cannot read properties of null (reading 'x') at index 3", src: 'https://auroramurmansk.ru/js/now.js?v=v61', line: 120, col: 5,
    stack: 'TypeError: x\n    at render (https://auroramurmansk.ru/js/now.js?v=v61:120:5)', v: 'v61', page: '#now' };
  assert.deepEqual((await call(env, page('/bug', err))).body, { ok: true, recorded: true });
  await call(env, page('/bug', { ...err, msg: err.msg.replace('3', '7') }, { ua: WIN }), NIGHT + MIN);
  assert.deepEqual((await call(env, page('/bug', err, { origin: 'http://localhost:8765' }))).body, { ok: true, recorded: false });
  assert.equal((await call(env, page('/bug', { msg: '' }))).status, 400);

  const rows = env.DB.raw.prepare('SELECT * FROM bugs').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 2);
  assert.equal(rows[0].src, 'js/now.js');
  assert.match(rows[0].stack, /at render \(js\/now\.js:120:5\)/);
  assert.equal(rows[0].ua, 'Windows · Chrome 129');
  assert.equal(uaShort(IPHONE), 'iOS 17 · Safari 17');
  assert.equal(uaShort('Mozilla/5.0 (Linux; Android 14) AppleWebKit Chrome/128.0 YaBrowser/24.7 Mobile Safari'), 'Android 14 · Яндекс 24');
  assert.equal(cleanSrc('http://localhost:8765/app.js?v=1'), 'app.js');
});

test('лавина разных ошибок — не больше лимита новых в час', async () => {
  const env = await botEnv();
  for (let i = 0; i < NEW_BUGS_PER_HOUR + 5; i++) await recordBug(env, { kind: 'page', msg: 'ошибка ' + 'abcdefghijklmnopqrstuvwxyzабвгдежзийклмн'[i], src: 'app.js' }, NIGHT);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM bugs').get().c, NEW_BUGS_PER_HOUR);
});

test('по расписанию: о новых ошибках — одним сообщением владельцу с кнопками, второй раз не повторяется', async () => {
  const env = await botEnv();
  await call(env, page('/bug', { msg: 'boom', src: 'js/map-tab.js', line: 3, v: 'v61' }));
  const fetchFn = makeFetch(NIGHT);
  await runCheck(env, NIGHT + MIN, fetchFn);
  const toOwner = fetchFn.telegram.filter(c => c.method === 'sendMessage' && /ошибка/.test(c.body.text));
  assert.equal(toOwner.length, 1);
  assert.equal(String(toOwner[0].body.chat_id), OWNER);
  assert.match(toOwner[0].body.text, /^🐞 Новая ошибка\n\n#1 · страница · v61\nboom\njs\/map-tab\.js:3 · iOS 17 · Safari 17/);
  assert.deepEqual(toOwner[0].body.reply_markup.inline_keyboard[0].map(b => b.callback_data), ['bug:d:1', 'bug:f:1', 'bug:i:1']);

  const again = makeFetch(NIGHT);
  await runCheck(env, NIGHT + 11 * MIN, again);
  assert.equal(again.telegram.filter(c => /ошибк/.test((c.body && c.body.text) || '')).length, 0);
});

test('Telegram не принял сообщение — об ошибке сообщится следующим проходом', async () => {
  const env = await botEnv();
  await recordBug(env, { kind: 'worker', msg: 'проверка: boom' }, NIGHT);
  await runCheck(env, NIGHT, makeFetch(NIGHT, { telegramStatus: 502 }));
  assert.equal(env.DB.raw.prepare('SELECT notified_at FROM bugs').get().notified_at, 0);
  await runCheck(env, NIGHT + 10 * MIN, makeFetch(NIGHT));
  assert.ok(env.DB.raw.prepare('SELECT notified_at FROM bugs').get().notified_at > 0);
});

test('/bugs и кнопки: подробности, «исправлено», возврат в новой версии, «не важно»', async () => {
  const env = await botEnv();
  await call(env, page('/bug', { msg: 'boom', src: 'app.js', line: 1, v: 'v61', stack: 'Error: boom\n at app.js:1:1' }));
  await call(env, page('/bug', { msg: 'second', src: 'js/now.js', line: 9, v: 'v61' }));

  const [list] = await tg(env, '/bugs');
  assert.match(list.text, /^🐞 Открытые ошибки: 2/);
  assert.equal(list.reply_markup.inline_keyboard.length, 2);

  const [detail] = await tg(env, null, { data: 'bug:d:1' });
  assert.match(detail.text, /#1 · страница · v61 · открыта\n\nboom\n\nГде: app\.js:1/);
  assert.match(detail.text, /Error: boom/);

  const [fixed] = await tg(env, null, { data: 'bug:f:1' });
  assert.match(fixed.text, /#1 — исправлена/);
  // Старая копия страницы (та же версия) повторяет ошибку — остаётся исправленной.
  await call(env, page('/bug', { msg: 'boom', src: 'app.js', line: 1, v: 'v61' }), NIGHT + HOUR);
  assert.equal(env.DB.raw.prepare('SELECT status FROM bugs WHERE id = 1').get().status, 'fixed');
  // В новой версии — снова открыта и снова будет сообщение.
  await call(env, page('/bug', { msg: 'boom', src: 'app.js', line: 1, v: 'v62' }), NIGHT + 2 * HOUR);
  const row = env.DB.raw.prepare('SELECT status, notified_at, ver FROM bugs WHERE id = 1').get();
  assert.deepEqual({ ...row }, { status: 'open', notified_at: 0, ver: 'v62' });

  await tg(env, null, { data: 'bug:i:2' });
  const [left] = await tg(env, '/bugs');
  assert.match(left.text, /^🐞 Открытые ошибки: 1/);

  // Кнопки чужого чата ничего не меняют.
  await tg(env, null, { chat: '42', data: 'bug:f:1' });
  assert.equal(env.DB.raw.prepare('SELECT status FROM bugs WHERE id = 1').get().status, 'open');

  await tg(env, null, { data: 'bug:f:1' });
  assert.equal((await tg(env, '/bugs'))[0].text, '✅ Открытых ошибок нет.');
});

test('/bug от посетителя: без текста — подсказка, с текстом — в журнал и владельцу; не больше 5 в сутки', async () => {
  const env = await botEnv();
  assert.match((await tg(env, '/bug', { chat: '42' }))[0].text, /^Опишите, что не так/);
  assert.equal((await tg(env, '/bug не открывается карта', { chat: '42' }))[0].text, 'Спасибо! Передал разработчику.');
  const row = env.DB.raw.prepare('SELECT * FROM bugs').get();
  assert.equal(row.kind, 'user');
  assert.equal(row.msg, 'не открывается карта');
  assert.equal(row.src, 'tg:42');

  for (let i = 1; i < USER_BUGS_PER_DAY; i++) await tg(env, '/bug ещё ' + i, { chat: '42', now: NIGHT + i });
  assert.match((await tg(env, '/bug шестое', { chat: '42', now: NIGHT + 99 }))[0].text, /^Сообщений сегодня уже много/);

  const fetchFn = makeFetch(NIGHT);
  await runCheck(env, NIGHT + MIN, fetchFn);
  const note = fetchFn.telegram.find(c => c.method === 'sendMessage' && /^🐞/.test(c.body.text));
  assert.match(note.body.text, /^🐞 Новых ошибок: 5/);
  assert.match(note.body.text, /от посетителя/);
});

test('сбой webhook бота — в журнал ошибок как ошибка сервера', async () => {
  const env = await botEnv();
  env.DB.raw.exec('DROP TABLE tg_subs');
  await tg(env, '/now', { chat: '42' });
  const row = env.DB.raw.prepare('SELECT kind, msg FROM bugs').get();
  assert.equal(row.kind, 'worker');
  assert.match(row.msg, /^бот: no such table: tg_subs/);
});

test('утренняя сводка: после 9:00 по Москве один раз в сутки, со вчерашними посещениями', async () => {
  const env = await botEnv();
  const morning = Date.UTC(2026, 9, 6, 6, 10);   // 9:10 по Москве
  await call(env, page('/hit', { lang: 'ru', fresh: true }), morning - 12 * HOUR);
  const early = makeFetch(morning - HOUR);
  await runCheck(env, morning - HOUR, early);   // 8:10 — рано
  assert.equal(early.telegram.filter(c => /Сводка/.test((c.body && c.body.text) || '')).length, 0);

  const f1 = makeFetch(morning);
  await runCheck(env, morning, f1);
  const digest = f1.telegram.filter(c => /Сводка/.test((c.body && c.body.text) || ''));
  assert.equal(digest.length, 1);
  assert.match(digest[0].body.text, /^☀️ Сводка за вчера\nпн 05\.10: 1 посетитель, 1 просмотр \(впервые 100%\)\nОткрытых ошибок: 0/);

  const f2 = makeFetch(morning + 10 * MIN);
  await runCheck(env, morning + 10 * MIN, f2);
  assert.equal(f2.telegram.filter(c => /Сводка/.test((c.body && c.body.text) || '')).length, 0);
});

test('меню владельца: /stats, /bugs и /timing только в его чате', async () => {
  const env = await botEnv();
  const fetchFn = makeFetch(NIGHT);
  await runCheck(env, NIGHT, fetchFn);
  const menus = fetchFn.telegram.filter(c => c.method === 'setMyCommands');
  const ownerMenu = menus.find(m => m.body.scope);
  assert.deepEqual(ownerMenu.body.scope, { type: 'chat', chat_id: Number(OWNER) });
  assert.deepEqual(ownerMenu.body.commands.map(c => c.command), ['now', 'settings', 'stop', 'bug', 'stats', 'bugs', 'timing']);
  for (const m of menus.filter(x => !x.body.scope)) assert.ok(!m.body.commands.some(c => c.command === 'stats' || c.command === 'timing'));
});

test('роботы поисковиков не считаются посетителями, их ошибки не пишутся; телефон Cubot — не робот', async () => {
  const env = await botEnv();
  const bots = [
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/136.0.7103.92 Safari/537.36',
    'Mozilla/5.0 (compatible; YandexRenderResourcesBot/1.0; +http://yandex.com/bots) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/136.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Mobile Safari/537.36 Chrome-Lighthouse',
    ''
  ];
  for (const ua of bots) {
    assert.deepEqual((await call(env, page('/hit', { lang: 'ru' }, { ua }))).body, { ok: true, counted: false }, ua);
    assert.deepEqual((await call(env, page('/bug', { msg: 'ReferenceError: initInstallHint is not defined' }, { ua }))).body, { ok: true, recorded: false }, ua);
  }
  const cubot = 'Mozilla/5.0 (Linux; Android 12; CUBOT X50 Build/SP1A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
  for (const ua of [cubot, IPHONE, WIN, 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/128.0 YaBrowser/24.7 Safari/537.36']) {
    assert.equal((await call(env, page('/hit', {}, { ua, ip: ua.slice(0, 20) }))).body.counted, true, ua);
  }
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM bugs').get().c, 0);
});
