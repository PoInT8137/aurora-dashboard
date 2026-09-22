// Погода для наблюдателя: разбор ответа Open-Meteo, главное условие, единицы, туман в вердикте.
// Запуск: node --test tools/weather.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadApp } from './app-sandbox.mjs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');

const element = () => ({
  textContent: '', hidden: false, disabled: false, className: '', style: { setProperty() {} },
  children: [], attrs: {}, listeners: {},
  setAttribute(k, v) { this.attrs[k] = String(v); },
  getAttribute(k) { return this.attrs[k] ?? null; },
  addEventListener(type, fn) { this.listeners[type] = fn; },
  querySelector() { return element(); },
  querySelectorAll() { return []; },
  appendChild(child) { this.children.push(child); return child; },
  set innerHTML(value) { if (value === '') this.children = []; },
  get innerHTML() { return ''; }
});

const NOW = '2026-12-15T22:00:00Z';   // полярная ночь, в Мурманске 01:00

function page({ fetch, now = NOW } = {}) {
  const elements = new Map();
  const getElement = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const ctx = loadApp(
    [['config.js', read('config.js')], ['core.js', read('core.js')], ['push.js', read('push.js')], ['app.js', read('app.js')]],
    { now: Date.parse(now), getElement, createElement: () => element(), fetch });
  ctx.state.point = ctx.findPoint('murmansk');
  return { ctx, el: getElement };
}

/** Поля current, как их отдаёт Open-Meteo (ветер — км/ч). */
const current = over => ({
  time: '2026-12-15T21:45', cloud_cover: 10, cloud_cover_low: 5, cloud_cover_mid: 5, cloud_cover_high: 0,
  temperature_2m: -12.4, apparent_temperature: -21.6, wind_speed_10m: 21.6, wind_gusts_10m: 43.2, wind_direction_10m: 185,
  precipitation: 0, rain: 0, snowfall: 0, weather_code: 1, visibility: 26100, relative_humidity_2m: 87, ...over
});

const wx = (ctx, over) => ctx.readWeather(current(over));

test('разбор: ветер из км/ч в м/с, пустые поля — null, без ответа — null', () => {
  const { ctx } = page();
  const w = wx(ctx, {});
  assert.equal(w.wind, 6);
  assert.equal(w.gusts, 12);
  assert.equal(w.feels, -21.6);
  assert.equal(w.vis, 26100);
  assert.equal(ctx.readWeather(null), null);
  const empty = ctx.readWeather({ temperature_2m: 1 });
  assert.equal(empty.wind, null);
  assert.equal(empty.vis, null);
});

test('главное условие и приоритет: туман важнее снега, снег — дождя, осадки — ветра', () => {
  const { ctx } = page();
  const c = over => ctx.weatherCondition(wx(ctx, over));
  assert.equal(c({}), 'clear');
  assert.equal(c({ weather_code: 45 }), 'fog');
  assert.equal(c({ weather_code: 48 }), 'fog');
  assert.equal(c({ visibility: 900 }), 'fog', 'видимость меньше километра — туман и без кода');
  assert.equal(c({ visibility: 1000 }), 'clear', 'ровно километр — ещё не туман');
  assert.equal(c({ snowfall: 0.2 }), 'snow');
  assert.equal(c({ weather_code: 73 }), 'snow');
  assert.equal(c({ weather_code: 86 }), 'snow');
  assert.equal(c({ rain: 0.4 }), 'rain');
  assert.equal(c({ weather_code: 61 }), 'rain');
  assert.equal(c({ weather_code: 81 }), 'rain');
  assert.equal(c({ weather_code: 95 }), 'rain', 'гроза');
  assert.equal(c({ wind_gusts_10m: 54 }), 'windy', 'порывы 15 м/с');
  assert.equal(c({ wind_gusts_10m: 50 }), 'clear', 'порывы 14 м/с');
  assert.equal(c({ weather_code: 45, snowfall: 1, wind_gusts_10m: 90 }), 'fog');
  assert.equal(c({ snowfall: 1, wind_gusts_10m: 90 }), 'snow');
  assert.equal(c({ rain: 1, wind_gusts_10m: 90 }), 'rain');
});

test('направление ветра: восемь сторон, откуда дует, с переходом через 360°', () => {
  const { ctx } = page();
  assert.deepEqual([0, 22, 23, 90, 185, 270, 338, 359, 360, -45].map(d => ctx.windDirText(d)),
    ['северный', 'северный', 'северо-восточный', 'восточный', 'южный', 'западный', 'северный', 'северный', 'северный', 'северо-западный']);
});

test('карточка: температура, условие, ощущается, ветер с порывами и направлением, видимость, влажность', () => {
  const { ctx, el } = page();
  ctx.renderWeather({ weather: wx(ctx, {}), stale: null });
  assert.equal(el('wx-value').textContent, '-12 °C');
  assert.equal(el('wx-caption').textContent, 'Осадков нет, видимость хорошая.');
  assert.equal(el('wx-facts').textContent, 'ощущается как -22 °C · ветер 6 м/с, порывы до 12 м/с, южный · видимость 26 км · влажность 87%');
  assert.equal(el('wx-card').attrs['data-state'], 'ok');
});

test('порывы не упоминаются, если почти не отличаются от ветра; направление — если штиль', () => {
  const { ctx, el } = page();
  ctx.renderWeather({ weather: wx(ctx, { wind_speed_10m: 18, wind_gusts_10m: 21.6 }), stale: null });
  assert.match(el('wx-facts').textContent, /ветер 5 м\/с, южный ·/);
  ctx.renderWeather({ weather: wx(ctx, { wind_speed_10m: 1.8, wind_gusts_10m: 3.6 }), stale: null });
  assert.match(el('wx-facts').textContent, /ветер 1 м\/с ·/);
});

test('единицы следуют настройкам: мили — ветер в милях в час и видимость в милях, °F — температура', () => {
  const { ctx, el } = page();
  ctx.setLang('en');
  ctx.setSetting('dist', 'mi');
  ctx.setSetting('temp', 'f');
  ctx.renderWeather({ weather: wx(ctx, {}), stale: null });
  assert.equal(el('wx-value').textContent, '10 °F');
  assert.equal(el('wx-facts').textContent, 'feels like -7 °F · wind 13 mph, gusts up to 27 mph, from the south · visibility 16 miles · humidity 87%');
});

test('видимость в туман — в метрах, округлённо', () => {
  const { ctx } = page();
  assert.equal(ctx.visibilityText(640), '600 м');
  assert.equal(ctx.visibilityText(26100), '26 км');
  ctx.setLang('zh');
  assert.equal(ctx.visibilityText(640), '600 米');
});

test('условия на трёх языках', () => {
  const { ctx, el } = page();
  for (const [lang, want] of [['ru', /^Туман/], ['en', /^Fog/], ['zh', /^有雾/]]) {
    ctx.setLang(lang);
    ctx.renderWeather({ weather: wx(ctx, { weather_code: 45 }), stale: null });
    assert.match(el('wx-caption').textContent, want, lang);
  }
});

test('без погоды (старый кэш до этой версии) карточка честно пишет, что данных нет', () => {
  const { ctx, el } = page();
  ctx.renderWeather({ value: 20, stale: null });
  assert.equal(el('wx-card').attrs['data-state'], 'error');
  ctx.renderWeather(null);
  assert.equal(el('wx-card').attrs['data-state'], 'error');
});

const verdict = (ctx, weather) =>
  ctx.computeVerdict({ value: 4.3, stale: null }, { value: 10, conflict: false, stale: null, weather });

test('туман в вердикте: фактор и пояснение, уровень не меняется; днём не упоминается', () => {
  const { ctx } = page();
  const clear = verdict(ctx, wx(ctx, {}));
  const foggy = verdict(ctx, wx(ctx, { weather_code: 45 }));
  assert.equal(foggy.level, clear.level);
  assert.ok(Array.from(foggy.factors).includes('Туман'));
  assert.match(foggy.hint, /Сейчас туман/);
  assert.ok(!Array.from(clear.factors).includes('Туман'));
  assert.equal(Array.from(foggy.factors).slice(0, 3).join('|'), Array.from(clear.factors).slice(0, 3).join('|'), 'первые три фактора — те же, они идут в уведомление');

  const day = page({ now: '2026-06-21T09:00:00Z' }).ctx;
  assert.doesNotMatch(verdict(day, wx(day, { weather_code: 45 })).hint, /туман/i);
});

test('запрос к Open-Meteo просит поля погоды, и ответ доходит до карточки', async () => {
  const body = { current: current({ weather_code: 73, snowfall: 0.5 }), hourly: { time: [] } };
  const { ctx, el } = page({ fetch: () => Promise.resolve(new Response(JSON.stringify(body), { status: 200 })) });
  const url = ctx.weatherUrl(ctx.findPoint('murmansk'));
  for (const field of ['apparent_temperature', 'wind_speed_10m', 'wind_gusts_10m', 'wind_direction_10m', 'snowfall', 'weather_code', 'visibility']) {
    assert.match(url, new RegExp(field), field);
  }
  await ctx.loadCloud();
  assert.equal(el('wx-caption').textContent, 'Идёт снег — небо, скорее всего, закрыто.');
  assert.equal(ctx.state.cloud.weather.snow, 0.5);
  assert.match(el('cloud-meta').textContent, /^(?!.*°C)/, 'температура больше не дублируется в облачности');
});

test('облачность недоступна — карточка погоды тоже в ошибке, а не висит в загрузке', async () => {
  const { ctx, el } = page({ fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
  await ctx.loadCloud();
  assert.equal(el('wx-card').attrs['data-state'], 'error');
});
