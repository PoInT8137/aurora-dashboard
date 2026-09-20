// Сервер уведомлений о северном сиянии (Cloudflare Worker).
//
//   POST /subscribe    { endpoint, point }     оформить подписку или сменить точку
//   POST /unsubscribe  { endpoint }            удалить подписку
//   POST /message      { endpoint }            текст последнего уведомления — его
//                                              забирает service worker при push
//   POST /test         { endpoint, delay? }    пробное уведомление (с задержкой до 20 с,
//                                              чтобы успеть закрыть приложение)
//   GET  /health                               проверка доступности
//   cron */10 * * * *                          runCheck: проверка условий и рассылка
//
// Адрес подписки (endpoint) — секрет: зная его, можно слать push этому человеку.
// Поэтому он не попадает в журналы и в ответы API.

import '../../core.js';
import { checkEndpoint, sendPush } from './push.js';

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
    return reply({ ok: true }, 200, cors);
  }

  if (request.method !== 'POST') return reply({ error: 'not_found' }, 404, cors);

  // Запросы принимаем только со страницы сайта. Это не защита от целенаправленной
  // подделки заголовка, но отсекает случайные и скриптовые обращения.
  if (!cors) return reply({ error: 'forbidden_origin' }, 403);

  const body = await readJson(request);
  if (body && body.tooLarge) return reply({ error: 'too_large' }, 413, cors);
  if (!body) return reply({ error: 'bad_json' }, 400, cors);

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
      await env.DB.prepare(
        'INSERT INTO subs(id, endpoint, point, created) VALUES(?, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET ' +
        'created = CASE WHEN subs.point != excluded.point THEN excluded.created ELSE subs.created END, ' +
        'point = excluded.point'
      ).bind(id, endpoint, point.id, nowMs).run();

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
      const row = await env.DB.prepare('SELECT point, last_test FROM subs WHERE id = ?').bind(id).first();
      if (!row) return reply({ error: 'not_subscribed' }, 404, cors);
      if (nowMs - row.last_test < TEST_MIN_INTERVAL_MS) return reply({ error: 'too_often' }, 429, cors);

      const delay = Math.min(Math.max(Math.round(Number(body.delay) || 0), 0), MAX_TEST_DELAY_S);
      const point = Core.POINTS.find(p => p.id === row.point);
      const msg = JSON.stringify({
        title: 'Пробное уведомление',
        body: 'Сервер уведомлений работает. О высоком шансе в точке «' + (point ? point.name : row.point) +
          '» сообщим так же — даже когда приложение закрыто.',
        test: true,
        at: nowMs
      });

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
