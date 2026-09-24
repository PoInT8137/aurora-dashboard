// Сервер уведомлений о северном сиянии (Cloudflare Worker).
//
//   POST /subscribe    { endpoint, point, lang?, quiet?, tz?, level?, sky? } оформить подписку,
//                                              сменить точку, язык, тихие часы (quiet: {from, to}
//                                              или null), порог (level: high | mid) и «небо откроется»
//   POST /unsubscribe  { endpoint }            удалить подписку
//   POST /message      { endpoint }            текст последнего уведомления — его
//                                              забирает service worker при push
//   POST /test         { endpoint, delay? }    пробное уведомление (с задержкой до 20 с,
//                                              чтобы успеть закрыть приложение)
//   GET  /health                               доступность и пульс: { ok, lastCheck, outcome }
//   POST /report       { point, strength }     отметка «Вижу сияние» (strength: faint | bright)
//   GET  /reports                              сводка отметок за последний час
//   cron */10 * * * *                          runCheck: проверка условий и рассылка
//
// Адрес подписки (endpoint) — секрет: зная его, можно слать push этому человеку.
// Поэтому он не попадает в журналы и в ответы API.

import '../../core.js';
import { checkEndpoint, sendPush } from './push.js';
import { normalizeLang, normalizeQuiet, normalizeZone, testMessage } from './messages.js';
import { acceptReport, reportSummary } from './reports.js';

const Core = globalThis.AuroraCore;

/** Потолок числа подписок: защита базы и лимитов от переполнения мусором. */
export const MAX_SUBS = 5000;
const MAX_BODY = 4096;
const TEST_MIN_INTERVAL_MS = 20000;
const MAX_TEST_DELAY_S = 20;   // после ответа worker живёт ещё ~30 с

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin || !allowedOrigins(env).includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

function reply(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(cors || {}) }
  });
}

async function subscriptionId(endpoint) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Читает JSON-тело с ограничением размера. Возвращает объект либо null. */
async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) return { tooLarge: true };
  try {
    const data = JSON.parse(text);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

export async function handleRequest(request, env, ctx, nowMs = Date.now(), fetchFn = fetch, sleepFn = sleep) {
  const url = new URL(request.url);
  const cors = corsHeaders(request, env);

  if (request.method === 'OPTIONS') {
    return cors ? new Response(null, { status: 204, headers: cors }) : new Response(null, { status: 403 });
  }

  if (url.pathname === '/health' && request.method === 'GET') {
    // Пульс проверок по расписанию: время и итог последнего прохода. Не секрет — ни адресов,
    // ни числа подписчиков. Таблицы может не быть (база до миграции) — тогда просто null.
    let beat = null;
    try {
      beat = await env.DB.prepare('SELECT at, outcome FROM heartbeat WHERE id = 1').first();
    } catch { /* до миграции таблицы нет */ }
    return reply({ ok: true, lastCheck: beat ? beat.at : null, outcome: beat ? beat.outcome : null }, 200, cors);
  }

  if (url.pathname === '/reports' && request.method === 'GET') {
    // Только числа по точкам за последний час. Меняется не чаще раза в минуту — можно кэшировать.
    let summary;
    try {
      summary = await reportSummary(env, nowMs);
    } catch {
      summary = { window: 60, total: 0, points: {} };   // база до миграции
    }
    return new Response(JSON.stringify(summary), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60', ...(cors || {}) }
    });
  }

  if (request.method !== 'POST') return reply({ error: 'not_found' }, 404, cors);

  // Запросы принимаем только со страницы сайта. Это не защита от целенаправленной
  // подделки заголовка, но отсекает случайные и скриптовые обращения.
  if (!cors) return reply({ error: 'forbidden_origin' }, 403);

  const body = await readJson(request);
  if (body && body.tooLarge) return reply({ error: 'too_large' }, 413, cors);
  if (!body) return reply({ error: 'bad_json' }, 400, cors);

  // Отметка очевидца не связана с подпиской: адрес push-сервиса не нужен.
  if (url.pathname === '/report') {
    try {
      const [result, status] = await acceptReport(env, body, request.headers.get('CF-Connecting-IP'), nowMs);
      return reply(result, status, cors);
    } catch {
      return reply({ error: 'unavailable' }, 503, cors);   // база до миграции
    }
  }

  const endpointUrl = checkEndpoint(body.endpoint);
  if (!endpointUrl) return reply({ error: 'bad_endpoint' }, 400, cors);
  const endpoint = endpointUrl.href;
  const id = await subscriptionId(endpoint);

  switch (url.pathname) {
    case '/subscribe': {
      const point = Core.POINTS.find(p => p.id === body.point);
      if (!point) return reply({ error: 'bad_point' }, 400, cors);

      const existing = await env.DB.prepare('SELECT 1 AS found FROM subs WHERE id = ?').bind(id).first();
      if (!existing) {
        const { c } = await env.DB.prepare('SELECT COUNT(*) AS c FROM subs').first();
        if (c >= MAX_SUBS) return reply({ error: 'limit' }, 503, cors);
      }

      // Смена точки начинает отсчёт заново: по новой точке человек не получит
      // сообщения о «высоком», которое уже идёт, — только о следующем.
      // Язык уведомлений — тот, что выбран на сайте. Не указан (старая версия страницы) —
      // у новой подписки русский, а у существующей остаётся прежний.
      const lang = normalizeLang(body.lang);
      // Тихие часы и пояс: не присланное (старая версия страницы) не трогаем, quiet: null выключает.
      const quiet = normalizeQuiet(body);
      const tz = normalizeZone(body.tz);
      // Порог и «небо откроется»: не присланное (старая страница) не трогаем.
      const level = body.level === 'mid' || body.level === 'high' ? body.level : null;
      const sky = typeof body.sky === 'boolean' ? (body.sky ? 1 : 0) : null;
      await env.DB.prepare(
        "INSERT INTO subs(id, endpoint, point, created, lang, quiet_from, quiet_to, tz) " +
        "VALUES(?, ?, ?, ?, COALESCE(?, 'ru'), ?, ?, ?) " +
        'ON CONFLICT(id) DO UPDATE SET ' +
        'created = CASE WHEN subs.point != excluded.point THEN excluded.created ELSE subs.created END, ' +
        'point = excluded.point, lang = COALESCE(?, subs.lang), ' +
        'quiet_from = CASE WHEN ? THEN ? ELSE subs.quiet_from END, ' +
        'quiet_to = CASE WHEN ? THEN ? ELSE subs.quiet_to END, ' +
        'tz = COALESCE(?, subs.tz)'
      ).bind(id, endpoint, point.id, nowMs, lang, quiet.from ?? null, quiet.to ?? null, tz,
        lang, quiet.set ? 1 : 0, quiet.from ?? null, quiet.set ? 1 : 0, quiet.to ?? null, tz).run();
      // Отдельным запросом: база до миграции (без колонок) не мешает самой подписке.
      if (level !== null || sky !== null) {
        try {
          await env.DB.prepare('UPDATE subs SET min_level = COALESCE(?, min_level), sky = COALESCE(?, sky) WHERE id = ?')
            .bind(level, sky, id).run();
        } catch (e) {
          console.error('настройки уведомлений не сохранены: ' + (e && e.message));
        }
      }

      return reply({ ok: true, point: point.id }, 200, cors);
    }

    case '/unsubscribe': {
      await env.DB.prepare('DELETE FROM subs WHERE id = ?').bind(id).run();
      return reply({ ok: true }, 200, cors);
    }

    case '/message': {
      const row = await env.DB.prepare('SELECT msg FROM subs WHERE id = ?').bind(id).first();
      if (!row || !row.msg) return reply({ error: 'no_message' }, 404, cors);
      return new Response(row.msg, {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors }
      });
    }

    case '/test': {
      const row = await env.DB.prepare('SELECT point, last_test, lang FROM subs WHERE id = ?').bind(id).first();
      if (!row) return reply({ error: 'not_subscribed' }, 404, cors);
      if (nowMs - row.last_test < TEST_MIN_INTERVAL_MS) return reply({ error: 'too_often' }, 429, cors);

      const delay = Math.min(Math.max(Math.round(Number(body.delay) || 0), 0), MAX_TEST_DELAY_S);
      const point = Core.POINTS.find(p => p.id === row.point);
      const msg = JSON.stringify(testMessage(point || row.point, nowMs, row.lang));

      await env.DB.prepare('UPDATE subs SET msg = ?, last_test = ? WHERE id = ?').bind(msg, nowMs, id).run();

      const send = async () => {
        if (delay) await sleepFn(delay * 1000);
        const status = await sendPush(endpoint, env, Date.now(), fetchFn);
        if (status === 404 || status === 410) {
          await env.DB.prepare('DELETE FROM subs WHERE id = ?').bind(id).run();
        }
        return status;
      };

      // С задержкой: отвечаем сразу, отправка идёт в фоне. Без задержки ждём
      // результат, чтобы честно сказать, принял ли push-сервис сообщение.
      if (delay) {
        ctx.waitUntil(send());
        return reply({ ok: true, delay }, 200, cors);
      }
      const status = await send();
      return reply({ ok: status >= 200 && status < 300, status, delay: 0 }, 200, cors);
    }

    default:
      return reply({ error: 'not_found' }, 404, cors);
  }
}
