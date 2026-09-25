// Резервный источник облачности и погоды: MET Norway (api.met.no), когда Open-Meteo не отвечает
// совсем. Ответ пересобирается в формат Open-Meteo, поэтому страница разбирает его как обычно.
//
// Чем резерв хуже основного: ярусы облачности MET Norway противоречат её же общей облачности
// (см. README, «Почему выбрана эта модель прогноза»), поэтому отдаётся только общая облачность —
// страница посчитает по ней, как всегда делает без ярусов. Видимость модель не даёт — только
// долю тумана: густой туман превращается в видимость 500 м, иначе видимости нет.
//
// Условия MET Norway: запрос с User-Agent, по которому можно связаться с сайтом; координаты не
// точнее 4 знаков; не больше 20 запросов в секунду. Одна точка — один запрос, поэтому резерв —
// только для запросов до 10 точек (погода точки, «Куда ехать» со своими местами); сетке облаков
// над картой (90 точек) и прошлым дням (past_days, у MET их нет) он не положен.

const UA = 'auroramurmansk.ru https://auroramurmansk.ru';
const MAX_POINTS = 10;
const HOUR = 60 * 60 * 1000;
export const METNO_MODEL = 'MET Norway';

/** Код погоды ВМО из символа MET Norway — ровно настолько, насколько его читает страница. */
export function wmoFromSymbol(symbol) {
  const s = String(symbol || '');
  if (!s) return null;
  if (s.includes('thunder')) return 95;
  if (s.startsWith('fog')) return 45;
  if (s.includes('snow')) return s.startsWith('heavy') ? 75 : 71;
  if (s.includes('sleet')) return 66;
  if (s.includes('rain')) return s.startsWith('heavy') ? 65 : s.startsWith('light') ? 61 : 63;
  if (s.startsWith('clearsky')) return 0;
  if (s.startsWith('fair')) return 1;
  if (s.startsWith('partlycloudy')) return 2;
  if (s.startsWith('cloudy')) return 3;
  return null;
}

const iso = ms => new Date(ms).toISOString().slice(0, 16);
const round4 = v => Math.round(Number(v) * 10000) / 10000;

/** Сколько часов вперёд просили: forecast_hours либо forecast_days × 24 (по умолчанию 7 суток у Open-Meteo). */
function hoursWanted(params) {
  if (params.get('forecast_hours')) return Number(params.get('forecast_hours'));
  return Number(params.get('forecast_days') || 7) * 24;
}

/**
 * Одна точка: ответ MET Norway → объект в формате Open-Meteo с теми полями current/hourly, что
 * просили. Часы — от начала текущего часа, как у Open-Meteo.
 */
export function toOpenMeteo(met, lat, lon, params, nowMs) {
  const series = (met && met.properties && met.properties.timeseries) || [];
  const byTime = new Map(series.map(s => [Date.parse(s.time), s.data]));
  const start = Math.floor(nowMs / HOUR) * HOUR;
  const det = d => (d && d.instant && d.instant.details) || {};

  const current = (params.get('current') || '').split(',').filter(Boolean);
  const hourly = (params.get('hourly') || '').split(',').filter(Boolean);
  const out = { latitude: lat, longitude: lon, timezone: 'GMT', generator: METNO_MODEL };

  if (current.length) {
    // «Сейчас» — последний час, начавшийся до текущего момента.
    const first = series.filter(s => Date.parse(s.time) <= nowMs).pop() || series[0];
    const d = first ? first.data : null;
    const i = det(d);
    const next = (d && d.next_1_hours) || {};
    const amount = next.details ? next.details.precipitation_amount : null;
    const symbol = next.summary ? next.summary.symbol_code : null;
    const snow = /snow|sleet/.test(String(symbol || ''));
    const fields = {
      cloud_cover: i.cloud_area_fraction,
      cloud_cover_low: null, cloud_cover_mid: null, cloud_cover_high: null,
      temperature_2m: i.air_temperature,
      apparent_temperature: i.apparent_air_temperature ?? null,
      wind_speed_10m: i.wind_speed == null ? null : i.wind_speed * 3.6,        // Open-Meteo по умолчанию — км/ч
      wind_gusts_10m: i.wind_speed_of_gust == null ? null : i.wind_speed_of_gust * 3.6,
      wind_direction_10m: i.wind_from_direction,
      precipitation: amount,
      rain: amount == null ? null : (snow ? 0 : amount),
      snowfall: amount == null ? null : (snow ? amount : 0),
      weather_code: wmoFromSymbol(symbol),
      visibility: i.fog_area_fraction >= 50 ? 500 : null,
      relative_humidity_2m: i.relative_humidity
    };
    out.current = { time: first ? iso(Date.parse(first.time)) : iso(start), interval: 3600 };
    for (const f of current) out.current[f] = fields[f] === undefined ? null : fields[f];
  }

  if (hourly.length) {
    const n = hoursWanted(params);
    const times = [];
    const values = Object.fromEntries(hourly.map(f => [f, []]));
    for (let h = 0; h < n; h++) {
      const t = start + h * HOUR;
      const d = byTime.get(t);
      if (!d) continue;   // дальше ~2,5 суток MET даёт шаг 6 часов — такие часы пропускаются
      times.push(params.get('timeformat') === 'unixtime' ? t / 1000 : iso(t));
      for (const f of hourly) values[f].push(f === 'cloud_cover' ? det(d).cloud_area_fraction ?? null : null);
    }
    out.hourly = { time: times, ...values };
  }
  return out;
}

/**
 * Резервный ответ на запрос страницы (те же параметры, что у Open-Meteo) или null, если резерв
 * такому запросу не положен или MET Norway тоже не ответил.
 */
export async function metnoFallback(upstreamUrl, nowMs, fetchFn) {
  const params = new URL(upstreamUrl).searchParams;
  if (params.get('past_days')) return null;
  const lats = (params.get('latitude') || '').split(',');
  const lons = (params.get('longitude') || '').split(',');
  if (!lats[0] || lats.length !== lons.length || lats.length > MAX_POINTS) return null;

  try {
    const results = await Promise.all(lats.map(async (lat, i) => {
      const la = round4(lat), lo = round4(lons[i]);
      const res = await fetchFn('https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=' + la + '&lon=' + lo, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) throw new Error('met.no ' + res.status);
      return toOpenMeteo(await res.json(), la, lo, params, nowMs);
    }));
    return results.length === 1 ? results[0] : results;
  } catch {
    return null;
  }
}
