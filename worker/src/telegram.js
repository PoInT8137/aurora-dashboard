// Telegram-бот для посетителей: уведомления о сиянии в Telegram — для тех, у кого push в браузере
// не работает (на iPhone он работает только у приложения на экране «Домой») или неудобен.
//
// Бот — тот же, что пишет владельцу о сбоях (src/monitor.js); на сайте он не упоминается.
// Посетитель пишет /start (или открывает ссылку t.me/<бот>?start=<точка>), выбирает точку кнопками и получает те же
// сигналы, что и push: переход в «высокий» (или уже в «средний», если так выбрал), ранний сигнал
// «Bz повернул на юг». Лимиты те же: не чаще раза в 3 часа, ранний сигнал — раз в 6 часов.
//
// Сообщения от Telegram приходят на POST /telegram (webhook). Адрес регистрирует сам сервер
// проходом по расписанию; подлинность запроса — по заголовку X-Telegram-Bot-Api-Secret-Token,
// который выводится из токена бота (отдельный секрет не нужен, подделать без токена нельзя).
//
// Хранится только номер чата, точка, язык и настройки — таблица tg_subs.

import '../../core.js';
import { alertMessage, bzMessage, pointName, normalizeLang, DEFAULT_LANG } from './messages.js';
import { bzPointOk, BZ_COOLDOWN_MS, BZ_AFTER_ALERT_MS } from './bz.js';

const Core = globalThis.AuroraCore;

export const SITE = 'https://auroramurmansk.ru/';
/** Сменить при изменении адреса или набора событий — сервер перерегистрирует webhook. */
export const WEBHOOK_VERSION = '1';
const COOLDOWN_MS = 3 * 60 * 60 * 1000;
const MAX_FAILS = 5;
const RANK = { low: 0, mid: 1, high: 2 };

/* ---------------- тексты ---------------- */

const T = {
  ru: {
    hello: 'Привет! Я сообщу, когда в выбранной точке Мурманской области будет хороший шанс увидеть северное сияние.\n\nВыберите точку:',
    subscribed: p => 'Готово: уведомления для точки «' + p + '».\n\nСообщу о высоком шансе (не чаще раза в 3 часа) и заранее — когда магнитное поле солнечного ветра повернёт на юг.',
    settings: (p, level, bz) => 'Точка: «' + p + '»\nСообщать: ' + (level === 'mid' ? 'о среднем и высоком шансе' : 'только о высоком шансе') +
      '\nРанний сигнал о Bz: ' + (bz ? 'вкл' : 'выкл'),
    choose: 'Выберите точку:',
    stopped: 'Уведомления выключены. Чтобы включить снова — /start.',
    notSubscribed: 'Вы пока не подписаны. Нажмите /start.',
    now: (p, level, ago) => p + ': ' + (level ? LEVEL.ru[level] + ' (проверено ' + ago + ' мин назад)' : 'данных пока нет — проверка раз в 10 минут'),
    help: 'Команды:\n/now — шанс сейчас\n/settings — точка и настройки\n/stop — выключить уведомления',
    bPoint: '📍 Точка', bLevelMid: 'Сообщать и о среднем', bLevelHigh: 'Только о высоком', bBzOn: 'Ранний сигнал: вкл', bBzOff: 'Ранний сигнал: выкл',
    bStop: '🔕 Отписаться', bNow: '🌌 Шанс сейчас', bSite: 'Открыть сайт',
    commands: [['now', 'Шанс увидеть сияние сейчас'], ['settings', 'Точка и настройки'], ['stop', 'Выключить уведомления']]
  },
  en: {
    hello: 'Hi! I will let you know when there is a good chance to see the northern lights at your chosen location in the Murmansk Region.\n\nChoose a location:',
    subscribed: p => 'Done: notifications for “' + p + '”.\n\nI will report a high chance (at most once every 3 hours) and warn in advance when the solar wind magnetic field turns south.',
    settings: (p, level, bz) => 'Location: “' + p + '”\nNotify: ' + (level === 'mid' ? 'moderate and high chance' : 'high chance only') + '\nEarly Bz signal: ' + (bz ? 'on' : 'off'),
    choose: 'Choose a location:',
    stopped: 'Notifications are off. To turn them back on — /start.',
    notSubscribed: 'You are not subscribed yet. Tap /start.',
    now: (p, level, ago) => p + ': ' + (level ? LEVEL.en[level] + ' (checked ' + ago + ' min ago)' : 'no data yet — checked every 10 minutes'),
    help: 'Commands:\n/now — chance right now\n/settings — location and settings\n/stop — turn notifications off',
    bPoint: '📍 Location', bLevelMid: 'Also moderate', bLevelHigh: 'High only', bBzOn: 'Early signal: on', bBzOff: 'Early signal: off',
    bStop: '🔕 Unsubscribe', bNow: '🌌 Chance now', bSite: 'Open the site',
    commands: [['now', 'Chance to see the aurora now'], ['settings', 'Location and settings'], ['stop', 'Turn notifications off']]
  },
  zh: {
    hello: '您好！当您选择的摩尔曼斯克州地点很有机会看到北极光时，我会通知您。\n\n请选择地点：',
    subscribed: p => '完成：已为“' + p + '”开启通知。\n\n机会大时通知您（最多每 3 小时一次），太阳风磁场转向南时也会提前提醒。',
    settings: (p, level, bz) => '地点：“' + p + '”\n通知：' + (level === 'mid' ? '机会中等和大' : '仅机会大') + '\nBz 提前提醒：' + (bz ? '开' : '关'),
    choose: '请选择地点：',
    stopped: '通知已关闭。要重新开启——/start。',
    notSubscribed: '您尚未订阅。请点按 /start。',
    now: (p, level, ago) => p + '：' + (level ? LEVEL.zh[level] + '（' + ago + ' 分钟前检查）' : '暂无数据——每 10 分钟检查一次'),
    help: '命令：\n/now — 当前机会\n/settings — 地点和设置\n/stop — 关闭通知',
    bPoint: '📍 地点', bLevelMid: '中等也通知', bLevelHigh: '仅机会大', bBzOn: '提前提醒：开', bBzOff: '提前提醒：关',
    bStop: '🔕 取消订阅', bNow: '🌌 当前机会', bSite: '打开网站',
    commands: [['now', '当前看到极光的机会'], ['settings', '地点和设置'], ['stop', '关闭通知']]
  }
};
const LEVEL = {
  ru: { high: 'высокий шанс', mid: 'средний шанс', low: 'низкий шанс' },
  en: { high: 'high chance', mid: 'moderate chance', low: 'low chance' },
  zh: { high: '机会大', mid: '机会中等', low: '机会小' }
};

/** Язык Telegram-клиента → ru | en | zh (остальные — английский). */
export function tgLang(code) {
  const base = String(code || '').toLowerCase().split(/[-_]/)[0];
  return normalizeLang(base) || 'en';
}

/* ---------------- Telegram API ---------------- */

export async function tgCall(env, method, body, fetchFn) {
  const res = await fetchFn('https://api.telegram.org/bot' + env.TELEGRAM_TOKEN + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000)
  });
  let data = null;
  try { data = await res.json(); } catch { /* не JSON */ }
  return { ok: res.ok && data && data.ok, status: res.status, data };
}

/** Секрет webhook: HMAC от токена — без токена его не подобрать, отдельный секрет не нужен. */
export async function webhookSecret(token) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(token)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('aurora-telegram-webhook'));
  return [...new Uint8Array(mac)].slice(0, 24).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function metaGet(env, key) {
  const row = await env.DB.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}
function metaSet(env, key, value) {
  return env.DB.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value).run();
}

/**
 * Проходом по расписанию: зарегистрировать webhook, меню команд и узнать имя бота — один раз
 * (или после смены WEBHOOK_VERSION). Без токена — ничего.
 */
export async function ensureTelegram(env, fetchFn) {
  if (!env.TELEGRAM_TOKEN || !env.PUBLIC_URL) return null;
  if (await metaGet(env, 'tg_webhook') === WEBHOOK_VERSION) return 'ready';

  const me = await tgCall(env, 'getMe', {}, fetchFn);
  if (!me.ok) throw new Error('getMe: ' + me.status);
  await metaSet(env, 'tg_username', me.data.result.username);

  const hook = await tgCall(env, 'setWebhook', {
    url: env.PUBLIC_URL.replace(/\/$/, '') + '/telegram',
    secret_token: await webhookSecret(env.TELEGRAM_TOKEN),
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true
  }, fetchFn);
  if (!hook.ok) throw new Error('setWebhook: ' + hook.status + ' ' + (hook.data && hook.data.description));

  for (const lang of ['ru', 'en', 'zh']) {
    await tgCall(env, 'setMyCommands', {
      commands: T[lang].commands.map(([command, description]) => ({ command, description })),
      ...(lang === 'en' ? {} : { language_code: lang })
    }, fetchFn);
  }
  await metaSet(env, 'tg_webhook', WEBHOOK_VERSION);
  return 'registered';
}

/* ---------------- разговор ---------------- */

const pointKeyboard = lang => ({
  inline_keyboard: chunk(Core.POINTS.map(p => ({ text: pointName(p, lang), callback_data: 'p:' + p.id })), 2)
});
function chunk(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}
const menuKeyboard = (lang, sub) => ({
  inline_keyboard: [
    [{ text: T[lang].bNow, callback_data: 'now' }, { text: T[lang].bPoint, callback_data: 'points' }],
    [{ text: sub.min_level === 'mid' ? T[lang].bLevelHigh : T[lang].bLevelMid, callback_data: sub.min_level === 'mid' ? 'l:high' : 'l:mid' }],
    [{ text: sub.bz ? T[lang].bBzOff : T[lang].bBzOn, callback_data: sub.bz ? 'b:0' : 'b:1' }],
    [{ text: T[lang].bSite, url: SITE + '?lang=' + lang + '#now' }, { text: T[lang].bStop, callback_data: 'stop' }]
  ]
});

async function getSub(env, chatId) {
  return env.DB.prepare('SELECT * FROM tg_subs WHERE chat_id = ?').bind(chatId).first();
}

/** Подписка на точку; смена точки — отсчёт заново, как у push (о «высоком», что уже идёт, не будим). */
async function subscribe(env, chatId, pointId, lang, nowMs) {
  await env.DB.prepare(
    'INSERT INTO tg_subs(chat_id, point, lang, created) VALUES(?, ?, ?, ?) ' +
    'ON CONFLICT(chat_id) DO UPDATE SET created = CASE WHEN tg_subs.point != excluded.point THEN excluded.created ELSE tg_subs.created END, ' +
    'point = excluded.point, lang = excluded.lang, fails = 0'
  ).bind(chatId, pointId, lang, nowMs).run();
  return getSub(env, chatId);
}

async function nowText(env, sub, lang, nowMs) {
  const point = Core.findPoint(sub.point);
  const row = await env.DB.prepare('SELECT level, updated FROM point_state WHERE point = ?').bind(sub.point).first();
  const fresh = row && nowMs - row.updated < 30 * 60 * 1000;
  return T[lang].now(pointName(point, lang), fresh ? row.level : null, fresh ? Math.max(0, Math.round((nowMs - row.updated) / 60000)) : 0) +
    '\n' + SITE + '?lang=' + lang + '#now';
}

/**
 * Обработка обновления от Telegram. Возвращает список вызовов API, которые надо сделать
 * (так обработчик проще проверять в тестах), — их выполняет handleTelegram.
 */
export async function telegramReply(env, update, nowMs) {
  const msg = update.message;
  const cb = update.callback_query;
  const chat = (msg && msg.chat) || (cb && cb.message && cb.message.chat);
  if (!chat || chat.type !== 'private') return [];   // группы и каналы не обслуживаем
  const chatId = String(chat.id);
  const from = (msg && msg.from) || (cb && cb.from) || {};
  const sub = await getSub(env, chatId);
  const lang = sub ? sub.lang : tgLang(from.language_code);
  const t = T[lang];
  const send = (text, extra = {}) => ({ method: 'sendMessage', body: { chat_id: chat.id, text, disable_web_page_preview: true, ...extra } });

  if (cb) {
    const out = [{ method: 'answerCallbackQuery', body: { callback_query_id: cb.id } }];
    const data = String(cb.data || '');
    if (data.startsWith('p:')) {
      const point = Core.POINTS.find(p => p.id === data.slice(2));
      if (!point) return out;
      const saved = await subscribe(env, chatId, point.id, lang, nowMs);
      out.push(send(t.subscribed(pointName(point, lang)), { reply_markup: menuKeyboard(lang, saved) }));
      return out;
    }
    if (!sub) { out.push(send(t.notSubscribed)); return out; }
    if (data === 'points') { out.push(send(t.choose, { reply_markup: pointKeyboard(lang) })); return out; }
    if (data === 'now') { out.push(send(await nowText(env, sub, lang, nowMs))); return out; }
    if (data === 'stop') {
      await env.DB.prepare('DELETE FROM tg_subs WHERE chat_id = ?').bind(chatId).run();
      out.push(send(t.stopped));
      return out;
    }
    if (data === 'l:mid' || data === 'l:high' || data === 'b:0' || data === 'b:1') {
      if (data[0] === 'l') await env.DB.prepare('UPDATE tg_subs SET min_level = ? WHERE chat_id = ?').bind(data.slice(2), chatId).run();
      else await env.DB.prepare('UPDATE tg_subs SET bz = ? WHERE chat_id = ?').bind(Number(data.slice(2)), chatId).run();
      const saved = await getSub(env, chatId);
      out.push(send(t.settings(pointName(Core.findPoint(saved.point), lang), saved.min_level, saved.bz), { reply_markup: menuKeyboard(lang, saved) }));
    }
    return out;
  }

  const text = String((msg && msg.text) || '').trim();
  const [command, arg] = text.split(/\s+/);
  const cmd = command ? command.replace(/@.*$/, '').toLowerCase() : '';

  if (cmd === '/start') {
    // Ссылка с сайта: t.me/<бот>?start=<точка> — сразу подписка на эту точку.
    const point = Core.POINTS.find(p => p.id === arg);
    if (point) {
      const saved = await subscribe(env, chatId, point.id, lang, nowMs);
      return [send(t.subscribed(pointName(point, lang)), { reply_markup: menuKeyboard(lang, saved) })];
    }
    return [send(t.hello, { reply_markup: pointKeyboard(lang) })];
  }
  if (!sub) return [send(t.hello, { reply_markup: pointKeyboard(lang) })];
  if (cmd === '/stop') {
    await env.DB.prepare('DELETE FROM tg_subs WHERE chat_id = ?').bind(chatId).run();
    return [send(t.stopped)];
  }
  if (cmd === '/now') return [send(await nowText(env, sub, lang, nowMs))];
  if (cmd === '/settings') {
    return [send(t.settings(pointName(Core.findPoint(sub.point), lang), sub.min_level, sub.bz), { reply_markup: menuKeyboard(lang, sub) })];
  }
  return [send(t.help)];
}

/** POST /telegram: проверка подлинности, ответ пользователю. */
export async function handleTelegram(request, env, nowMs, fetchFn) {
  if (!env.TELEGRAM_TOKEN) return new Response('not configured', { status: 404 });
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (!secret || secret !== await webhookSecret(env.TELEGRAM_TOKEN)) return new Response('forbidden', { status: 403 });
  let update;
  try { update = await request.json(); } catch { return new Response('bad json', { status: 400 }); }
  try {
    const calls = await telegramReply(env, update, nowMs);
    for (const c of calls) await tgCall(env, c.method, c.body, fetchFn);
  } catch (e) {
    // Telegram повторяет запрос при ошибке — отвечаем 200, чтобы не зациклиться; причина — в журнал.
    console.error('telegram: ' + (e && e.message));
  }
  return new Response('ok', { status: 200 });
}

/* ---------------- рассылка ---------------- */

/** Текст уведомления: заголовок, текст и ссылка на сайт на языке подписчика. */
function alertText(message, lang) {
  return message.title + '\n' + message.body + '\n' + SITE + '?lang=' + lang + '#now';
}

/**
 * Уведомления подписчикам Telegram после основной рассылки. ctx: { points, clouds, kp }, данные
 * прохода — в summary (levels, highSince, midSince, bzState). Возвращает оставшийся бюджет отправок.
 */
export async function telegramAlerts(env, nowMs, fetchFn, ctx, summary, budget) {
  summary.tgSent = 0;
  if (!env.TELEGRAM_TOKEN || budget <= 0) return budget;

  const bzLevel = summary.bz ? summary.bz.level : null;
  const bzState = summary.bzState || null;
  const updates = [];
  const sentIds = new Set();

  for (let i = 0; i < ctx.points.length && budget > 0; i++) {
    const point = ctx.points[i];
    const cloud = ctx.clouds[i];
    const level = summary.levels[point.id];
    if (!level || !cloud) continue;
    const high = (summary.highSince || {})[point.id] || 0;
    const mid = (summary.midSince || {})[point.id] || 0;

    const { results } = await env.DB.prepare('SELECT * FROM tg_subs WHERE point = ?').bind(point.id).all();
    for (const sub of results) {
      if (budget <= 0) break;
      let message = null;
      let column = 'last_sent';
      const lang = sub.lang || DEFAULT_LANG;
      const cooled = nowMs - sub.last_sent >= COOLDOWN_MS;
      if (level === 'high' && high && sub.created < high && sub.last_sent < high && cooled) {
        message = alertMessage(point, ctx.kp, cloud, nowMs, lang, 'high');
      } else if (sub.min_level === 'mid' && RANK[level] >= 1 && mid && sub.created < mid && sub.last_sent < mid && cooled) {
        message = alertMessage(point, ctx.kp, cloud, nowMs, lang, level);
      } else if (sub.bz && bzLevel && bzState && level !== 'high' && bzPointOk(point, cloud, nowMs) &&
        sub.created < bzState.southSince && sub.last_bz < bzState.southSince && nowMs - sub.last_bz >= BZ_COOLDOWN_MS &&
        nowMs - sub.last_sent >= BZ_AFTER_ALERT_MS) {
        message = bzMessage(point, bzState.bz, cloud, bzLevel, nowMs, lang);
        column = 'last_bz';
      }
      if (!message || sentIds.has(sub.chat_id)) continue;
      sentIds.add(sub.chat_id);
      budget--;

      let r;
      try { r = await tgCall(env, 'sendMessage', { chat_id: sub.chat_id, text: alertText(message, lang), disable_web_page_preview: true }, fetchFn); }
      catch { r = { ok: false, status: 0 }; }
      if (r.ok) {
        summary.tgSent++;
        updates.push(env.DB.prepare('UPDATE tg_subs SET ' + column + ' = ?, fails = 0 WHERE chat_id = ?').bind(nowMs, sub.chat_id));
      } else if (r.status === 403 || r.status === 400) {
        // Бот заблокирован или чат удалён — подписка больше не нужна.
        updates.push(env.DB.prepare('DELETE FROM tg_subs WHERE chat_id = ?').bind(sub.chat_id));
      } else {
        updates.push(env.DB.prepare('UPDATE tg_subs SET fails = fails + 1 WHERE chat_id = ?').bind(sub.chat_id));
      }
    }
  }
  if (updates.length) {
    updates.push(env.DB.prepare('DELETE FROM tg_subs WHERE fails >= ?').bind(MAX_FAILS));
    await env.DB.batch(updates);
  }
  return budget;
}
