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
// Ответы хранятся в памяти worker'а (у каждого файла свой срок); если NOAA не отвечает, отдаётся
// последняя удачная копия — страница сама видит её возраст по времени внутри данных.

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

const memory = new Map();

export function clearNoaaCache() {
  memory.clear();
}

/** [тело, статус, тип содержимого, из запаса ли] для /noaa/<name>. */
export async function noaaProxy(name, nowMs, fetchFn) {
  const source = Object.prototype.hasOwnProperty.call(SOURCES, name) ? SOURCES[name] : null;
  if (!source) return [JSON.stringify({ error: 'unknown_source' }), 404, 'json', false];

  const hit = memory.get(name);
  if (hit && nowMs - hit.at < source.ttl) return [hit.body, 200, source.type, false];

  try {
    const res = await fetchFn(BASE + source.path, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error('http ' + res.status);
    const text = await res.text();
    const body = source.trim ? source.trim(text, nowMs) : text;
    memory.set(name, { body, at: nowMs });
    return [body, 200, source.type, false];
  } catch (e) {
    if (hit && nowMs - hit.at < STALE_KEEP_MS) return [hit.body, 200, source.type, true];
    return [JSON.stringify({ error: 'upstream_unreachable' }), 502, 'json', false];
  }
}
