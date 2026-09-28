// Данные NOAA для страницы через сервер: GET /noaa/<имя>.
//
// Зачем: браузер ходил к services.swpc.noaa.gov сам — это до 2 МБ за обновление (один только
// поминутный ряд солнечного ветра весит 1 МБ), и сайт переставал работать, если сеть не пускала
// к NOAA. Сервер отдаёт компактные версии тех же файлов в том же формате, так что разбор на
// странице не меняется, а прямой запрос к NOAA остаётся запасным путём.
//
// У бесплатного worker'а 10 мс процессорного времени на запрос, а полный разбор OVATION занимает
// около 7 мс, поэтому тяжёлые файлы не разбираются целиком: нужный кусок вырезается поиском по
// строке, и разбирается только он.
//
// Ответы хранятся в памяти worker'а и в таблице noaa_cache (у каждого файла свой срок свежести).
// Поход к NOAA из Европы — около секунды, поэтому копия чуть старше срока (до REVALIDATE_MS сверх
// него) отдаётся сразу, а свежая загружается в фоне для следующего запроса. Если NOAA не отвечает,
// отдаётся последняя удачная копия — страница сама видит её возраст по времени внутри данных.

const BASE = 'https://services.swpc.noaa.gov/';
const MIN = 60 * 1000;

/** Вырезка из поминутного ряда солнечного ветра: последние 2 часа 10 минут всех спутников, нужные поля. */
export function trimRtsw(text, nowMs) {
  const cutoff = nowMs - 130 * MIN;
  const marker = '{"time_tag": "';
  let pos = text.indexOf(marker);
  let end = -1;
  while (pos >= 0) {
    const time = Date.parse(text.slice(pos + marker.length, pos + marker.length + 19) + 'Z');
    if (Number.isFinite(time) && time < cutoff) { end = pos; break; }
    pos = text.indexOf(marker, pos + marker.length);
  }
  const head = end < 0 ? text : text.slice(0, end).replace(/,\s*$/, '') + ']';
  const rows = JSON.parse(head);
  return JSON.stringify(rows.map(r => ({ time_tag: r.time_tag, active: r.active, source: r.source, bt: r.bt, bz_gsm: r.bz_gsm })));
}

/**
 * Вырезка из OVATION: долготы lonFrom..lonTo и широты latFrom..latTo, с заголовком. В файле точки
 * идут по долготе, внутри — по широте, поэтому нужные долготы — один сплошной кусок.
 */
export function trimOvation(text, { lonFrom = 17, lonTo = 53, latFrom = 55, latTo = 80 } = {}) {
  const head = JSON.parse(text.slice(0, text.indexOf('"coordinates"')).replace(/,\s*$/, '') + '}');
  const start = text.indexOf('[' + lonFrom + ', ');
  let stop = text.indexOf('[' + (lonTo + 1) + ', ', start);
  if (start < 0) throw new Error('ovation: нет долготы ' + lonFrom);
  if (stop < 0) stop = text.lastIndexOf(']]');
  const chunk = JSON.parse('[' + text.slice(start, stop).replace(/,\s*$/, '') + ']');
  head.coordinates = chunk.filter(c => c[0] >= lonFrom && c[0] <= lonTo && c[1] >= latFrom && c[1] <= latTo);
  return JSON.stringify(head);
}

/** Что отдаётся: адрес NOAA, срок хранения, тип и обработка. */
export const SOURCES = {
  'kp':          { path: 'json/planetary_k_index_1m.json', ttl: MIN, type: 'json' },
  'kp-3h':       { path: 'products/noaa-planetary-k-index.json', ttl: 5 * MIN, type: 'json' },
  'kp-forecast': { path: 'products/noaa-planetary-k-index-forecast.json', ttl: 10 * MIN, type: 'json' },
  'sw-mag':      { path: 'json/rtsw/rtsw_mag_1m.json', ttl: MIN, type: 'json', trim: trimRtsw },
  'sw-speed':    { path: 'products/summary/solar-wind-speed.json', ttl: MIN, type: 'json' },
  'ovation':     { path: 'json/ovation_aurora_latest.json', ttl: 5 * MIN, type: 'json', trim: text => trimOvation(text) },
  'outlook':     { path: 'text/27-day-outlook.txt', ttl: 60 * MIN, type: 'text' }
};

/** Последняя удачная копия дольше срока свежести — на случай, если NOAA не отвечает. */
export const STALE_KEEP_MS = 6 * 60 * MIN;

/** Насколько копия может быть старше срока свежести, чтобы её отдать сразу и обновить в фоне. */
export const REVALIDATE_MS = 10 * MIN;

const memory = new Map();
const pending = new Map();   // идущие загрузки: одновременные запросы ждут одну и ту же

export function clearNoaaCache() {
  memory.clear();
  pending.clear();
}

async function readSaved(db, name) {
  if (!db) return null;
  try {
    const row = await db.prepare('SELECT body, at FROM noaa_cache WHERE name = ?').bind(name).first();
    return row ? { body: row.body, at: row.at } : null;
  } catch (e) {
    return null;   // таблицы нет или база недоступна — просто идём к NOAA
  }
}

function load(name, source, nowMs, fetchFn, db) {
  if (pending.has(name)) return pending.get(name);
  const job = (async () => {
    const res = await fetchFn(BASE + source.path, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error('http ' + res.status);
    const text = await res.text();
    const body = source.trim ? source.trim(text, nowMs) : text;
    memory.set(name, { body, at: nowMs });
    if (db) {
      try {
        await db.prepare('INSERT INTO noaa_cache (name, body, at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(name) DO UPDATE SET body = excluded.body, at = excluded.at').bind(name, body, nowMs).run();
      } catch (e) { /* копия в базе — только ускорение */ }
    }
    return body;
  })();
  pending.set(name, job);
  job.then(() => pending.delete(name), () => pending.delete(name));
  return job;
}

/**
 * [тело, статус, тип содержимого, из запаса ли] для /noaa/<name>. opts.db — база с таблицей
 * noaa_cache, opts.waitUntil — чтобы фоновая загрузка пережила ответ.
 */
export async function noaaProxy(name, nowMs, fetchFn, opts = {}) {
  const source = Object.prototype.hasOwnProperty.call(SOURCES, name) ? SOURCES[name] : null;
  if (!source) return [JSON.stringify({ error: 'unknown_source' }), 404, 'json', false];
  const db = opts.db || null;

  let hit = memory.get(name);
  if (!hit || nowMs - hit.at >= source.ttl) {
    const saved = await readSaved(db, name);
    if (saved && (!hit || saved.at > hit.at)) { hit = saved; memory.set(name, saved); }
  }
  if (hit && nowMs - hit.at < source.ttl) return [hit.body, 200, source.type, false];

  if (hit && nowMs - hit.at < source.ttl + REVALIDATE_MS && opts.waitUntil) {
    opts.waitUntil(load(name, source, nowMs, fetchFn, db).catch(() => {}));
    return [hit.body, 200, source.type, false];
  }

  try {
    const body = await load(name, source, nowMs, fetchFn, db);
    return [body, 200, source.type, false];
  } catch (e) {
    if (hit && nowMs - hit.at < STALE_KEEP_MS) return [hit.body, 200, source.type, true];
    return [JSON.stringify({ error: 'upstream_unreachable' }), 502, 'json', false];
  }
}
