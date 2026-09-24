// Общие помощники тестов: база, ключи VAPID, подмена fetch.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { b64u } from '../src/push.js';

/** Прослойка с интерфейсом D1 поверх SQLite из Node: D1 — это и есть SQLite. */
export function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));

  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...args).map(r => ({ ...r })) }),
    first: async () => { const r = db.prepare(sql).get(...args); return r ? { ...r } : null; },
    run: async () => ({ meta: { changes: db.prepare(sql).run(...args).changes } }),
    _exec: () => db.prepare(sql).run(...args)
  });

  return {
    raw: db,
    prepare: sql => wrap(sql),
    // Как в D1: все операторы пакета — в одной транзакции.
    batch: async stmts => {
      db.exec('BEGIN');
      try { for (const s of stmts) s._exec(); db.exec('COMMIT'); }
      catch (e) { db.exec('ROLLBACK'); throw e; }
      return [];
    }
  };
}

export async function makeKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { jwk, publicKey: pair.publicKey, publicB64: b64u(publicRaw) };
}

export async function makeEnv() {
  const keys = await makeKeys();
  return {
    keys,
    env: {
      DB: makeDb(),
      VAPID_PUBLIC: keys.publicB64,
      VAPID_PRIVATE_KEY: keys.jwk.d,
      ALLOWED_ORIGINS: 'https://auroramurmansk.ru,http://localhost:8765',
      VAPID_SUBJECT: 'https://auroramurmansk.ru'
    }
  };
}

export const ORIGIN = 'https://auroramurmansk.ru';
export const NIGHT = Date.UTC(2026, 11, 15, 22, 0, 0);   // полярная ночь: Солнце глубоко под горизонтом
export const DAY = Date.UTC(2026, 5, 21, 9, 0, 0);       // июнь, полдень: Солнце над горизонтом
export const MIN = 60 * 1000;
export const HOUR = 60 * MIN;

export const ep = (n, host = 'fcm.googleapis.com') => `https://${host}/fcm/send/device-${n}`;

/** Подписка напрямую в базу (обход API), чтобы задать created и last_sent. */
// Тот же id, что считает API: SHA-256 адреса. Иначе подписка, добавленная в базу
// напрямую, и подписка через API оказались бы двумя разными записями.
export const idOf = endpoint => createHash('sha256').update(endpoint).digest('hex');

export function addSub(env, { n, point = 'murmansk', created = NIGHT - HOUR, lastSent = 0, host, lang }) {
  // lang не указан — как у подписки, оформленной до появления выбора языка: берётся значение по умолчанию.
  const columns = lang ? 'id, endpoint, point, created, last_sent, lang' : 'id, endpoint, point, created, last_sent';
  const marks = lang ? '?, ?, ?, ?, ?, ?' : '?, ?, ?, ?, ?';
  const values = [idOf(ep(n, host)), ep(n, host), point, created, lastSent];
  env.DB.raw.prepare('INSERT INTO subs(' + columns + ') VALUES(' + marks + ')').run(...values, ...(lang ? [lang] : []));
  return ep(n, host);
}

export const subRow = (env, n) => env.DB.raw.prepare('SELECT * FROM subs WHERE id = ?').get(idOf(ep(n)));
export const stateRow = (env, point) => env.DB.raw.prepare('SELECT * FROM point_state WHERE point = ?').get(point);

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * Подделка внешнего мира: NOAA, Open-Meteo и push-серверы. Записывает все
 * обращения в .calls. Параметры меняются между запусками через .opts.
 */
export function makeFetch(now, initial = {}) {
  const opts = {
    kp: 4.3,
    kpAgeMs: MIN,               // насколько свежо последнее измерение Kp
    kpDown: false,
    weatherDown: false,
    weatherBroken: false,       // ответ с неверным числом точек
    // ярусы и суммарная облачность; функция от индекса точки может дать разные значения
    cloud: () => ({ low: 5, mid: 5, high: 0, total: 8 }),
    pushStatus: {},             // адрес -> статус; по умолчанию 201
    bz: 3,                      // Bz из сводки NOAA, нТл; по умолчанию северный — раннего сигнала нет
    bzAgeMs: 5 * MIN,
    bzDown: false,
    ...initial
  };

  const fetchFn = async (url, init = {}) => {
    const u = String(url);
    fetchFn.calls.push({ url: u, init });

    if (u.includes('planetary_k_index_1m')) {
      if (opts.kpDown) return new Response('down', { status: 503 });
      const t = new Date(now - opts.kpAgeMs).toISOString().slice(0, 19);
      return json([{ time_tag: t, kp_index: Math.round(opts.kp), estimated_kp: opts.kp, kp: '4P' }]);
    }
    if (u.includes('noaa-planetary-k-index')) return new Response('nope', { status: 404 });

    if (u.includes('solar-wind-mag-field')) {
      if (opts.bzDown) return new Response('down', { status: 503 });
      const t = new Date(now - opts.bzAgeMs).toISOString().slice(0, 19) + 'Z';
      return json([{ bt: 12, bz_gsm: opts.bz, time_tag: t }]);
    }

    if (u.includes('api.open-meteo.com')) {
      if (opts.weatherDown) return new Response('down', { status: 500 });
      const lats = u.match(/latitude=([^&]+)/)[1].split(',');
      const items = lats.map((lat, i) => {
        const c = opts.cloud(i, lat);
        // почасовой прогноз на 4 часа с текущего часа; по умолчанию — как сейчас
        const start = Math.floor(now / HOUR) * HOUR;
        const hours = [0, 1, 2, 3].map(h => ({ t: start + h * HOUR, c: opts.hourly ? opts.hourly(i, h, lat) : c }));
        return {
          current: { time: new Date(now).toISOString().slice(0, 16), cloud_cover: c.total,
            cloud_cover_low: c.low, cloud_cover_mid: c.mid, cloud_cover_high: c.high },
          hourly: {
            time: hours.map(x => new Date(x.t).toISOString().slice(0, 16)),
            cloud_cover: hours.map(x => x.c.total), cloud_cover_low: hours.map(x => x.c.low),
            cloud_cover_mid: hours.map(x => x.c.mid), cloud_cover_high: hours.map(x => x.c.high)
          }
        };
      });
      if (opts.weatherBroken) return json(items.concat(items[0]));   // на один элемент больше, чем точек
      return json(items.length === 1 ? items[0] : items);   // как настоящий API
    }

    // push-сервер
    const status = opts.pushStatus[u] ?? 201;
    return new Response(null, { status });
  };

  fetchFn.calls = [];
  fetchFn.opts = opts;
  fetchFn.pushCalls = () => fetchFn.calls.filter(c => c.url.startsWith('https://fcm.googleapis.com/')
    || c.url.includes('push.services.mozilla.com') || c.url.includes('push.apple.com') || c.url.includes('notify.windows.com'));
  return fetchFn;
}

/** Запрос к API worker'а от имени страницы сайта. */
export function apiRequest(path, body, { origin = ORIGIN, method = 'POST', raw } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (origin) headers.Origin = origin;
  return new Request('https://aurora-push.example.workers.dev' + path, {
    method, headers, body: method === 'POST' ? (raw ?? JSON.stringify(body)) : undefined
  });
}

export const fakeCtx = () => ({ pending: [], waitUntil(p) { this.pending.push(p); } });
