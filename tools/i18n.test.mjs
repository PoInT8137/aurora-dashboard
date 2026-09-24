// Переводы: словари согласованы между собой, все используемые ключи существуют,
// определение и переключение языка работают, тексты собираются на каждом языке.
// Запуск: node --test tools/i18n.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { loadApp, appSource } from './app-sandbox.mjs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');

/** Словари в чистом виде: движок нужен только для того, чтобы файлы отработали. */
function dictionaries() {
  const ctx = vm.createContext({});
  vm.runInContext(read('i18n.js'), ctx);
  for (const code of ['ru', 'en', 'zh']) vm.runInContext(read(`lang/${code}.js`), ctx, { filename: `lang/${code}.js` });
  return JSON.parse(vm.runInContext('JSON.stringify(i18nDicts)', ctx));
}

const dicts = dictionaries();
const ru = dicts.ru, en = dicts.en, zh = dicts.zh;

const CYRILLIC = /[А-Яа-яЁё]/;
const CJK = /[\u4e00-\u9fff]/;
const texts = value => (typeof value === 'object' ? Object.values(value) : [value]);
const placeholders = value => texts(value).flatMap(s => s.match(/\{\w+\}/g) || []).map(p => p).sort();
const uniq = list => [...new Set(list)];

test('словари: у английского и китайского те же ключи, что у русского, без лишних и пропущенных', () => {
  const base = Object.keys(ru).sort();
  assert.deepEqual(Object.keys(en).sort(), base, 'английский');
  assert.deepEqual(Object.keys(zh).sort(), base, 'китайский');
});

test('словари: подстановки {имя} в переводах те же, что в русском, — иначе значение потеряется или останется буквально', () => {
  for (const key of Object.keys(ru)) {
    const want = uniq(placeholders(ru[key]));
    for (const [code, dict] of [['en', en], ['zh', zh]]) {
      assert.deepEqual(uniq(placeholders(dict[key])), want, `${code}: ${key}`);
    }
  }
});

test('словари: формы множественного числа — объект только там, где он в русском, и в нём есть other', () => {
  for (const key of Object.keys(ru)) {
    const isPlural = typeof ru[key] === 'object';
    for (const [code, dict] of [['en', en], ['zh', zh]]) {
      assert.equal(typeof dict[key] === 'object', isPlural, `${code}: ${key}`);
      if (isPlural) assert.ok(dict[key].other, `${code}: ${key} без other`);
    }
    if (isPlural) assert.ok(ru[key].other && ru[key].many, `ru: ${key} без many/other`);
  }
});

test('словари: в английском и китайском нет кириллицы, а китайский написан по-китайски', () => {
  for (const [code, dict] of [['en', en], ['zh', zh]]) {
    for (const [key, value] of Object.entries(dict)) {
      for (const text of texts(value)) assert.doesNotMatch(text, CYRILLIC, `${code}: ${key}`);
    }
  }
  for (const [key, value] of Object.entries(zh)) {
    // исключения — обозначения без слов: «Kp {v}», названия моделей
    const plain = texts(value).every(text => !CJK.test(text));
    const asLatin = text => text.replace(/。$/, '.');
    // «{a}{b}» — вообще без слов, переводить нечего
    const wordless = texts(value).every(text => !/[A-Za-z]{2,}/.test(text.replace(/\{\w+\}/g, '')));
    if (plain && !wordless) assert.deepEqual(texts(value).map(asLatin), texts(en[key]), `zh: ${key} не переведён`);
  }
  for (const [key, value] of Object.entries(en)) {
    if (typeof ru[key] === 'string' && CYRILLIC.test(ru[key]) && ru[key].length > 25) {
      assert.notEqual(value, ru[key], `en: ${key} не переведён`);
    }
  }
});

test('словари: китайские тексты используют китайскую пунктуацию, а не английскую точку в конце', () => {
  for (const [key, value] of Object.entries(zh)) {
    if (typeof value !== 'string' || !CJK.test(value)) continue;
    assert.doesNotMatch(value, /[\u4e00-\u9fff]\.$/, `zh: ${key} оканчивается латинской точкой`);
  }
});

/** Первый аргумент вызова t(...): всё до запятой или закрывающей скобки на верхнем уровне. */
function firstArguments(source) {
  const out = [];
  for (const m of source.matchAll(/\bt\(/g)) {
    let depth = 0, i = m.index + m[0].length, arg = '';
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) break; depth--; }
      else if (c === ',' && depth === 0) break;
      arg += c;
    }
    out.push(arg);
  }
  return out;
}

/** Ключи, которые app.js и index.html называют прямо (в том числе в ветках условия). */
function usedKeys() {
  const app = appSource();
  const html = read('index.html');
  const used = new Set();
  for (const arg of firstArguments(app)) {
    for (const m of arg.matchAll(/'([a-z_0-9]+(?:\.[a-z_0-9]+)+)'/g)) used.add(m[1]);
  }
  for (const m of app.matchAll(/'(lead\.[\w.]+|check\.\w+)'/g)) used.add(m[1]);   // ключи, переданные значением
  for (const m of html.matchAll(/data-i18n="([\w.-]+)"/g)) used.add(m[1]);
  for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
    for (const pair of m[1].split(';')) used.add(pair.split(':')[1].trim());
  }
  return used;
}

/** Любые строки вида a.b в app.js: ключи могут лежать в переменных, поэтому для поиска мёртвых берём широко. */
function mentionedKeys() {
  const app = appSource();
  return new Set([...app.matchAll(/'([a-z_0-9]+(?:\.[a-z_0-9]+)+)'/g)].map(m => m[1]));
}

/** Семейства ключей, которые собираются из кусков: 'err.' + код, 'light.' + уровень + '.label'. */
const FAMILIES = [/^err\./, /^light\.\w+\.(label|hint)$/, /^layer\.\w+(\.alt)?$/, /^note\./, /^model\./,
  /^how\./, /^coord\./, /^moon\.phase\./, /^level\./, /^chance\./, /^unit\./, /^chk\./, /^tz\./, /^sw\.outlook\./, /^ov\.level\./, /^wx\.(clear|windy|snow|rain|fog)$/, /^wind\.dir\./, /^nchart\.row\./];

test('ключи: все, что называют app.js и index.html, есть в словаре', () => {
  const missing = [...usedKeys()].filter(key => !(key in ru));
  assert.deepEqual(missing, []);
});

test('ключи: в словаре нет мёртвых — каждый используется или относится к собираемому семейству', () => {
  const used = new Set([...usedKeys(), ...mentionedKeys()]);
  const dead = Object.keys(ru).filter(key => !used.has(key) && !FAMILIES.some(f => f.test(key)));
  assert.deepEqual(dead, []);
});

test('ключи-семейства: всё, что собирается из кусков, покрыто словарём', () => {
  const ctx = loadApp([['config.js', read('config.js')], ['core.js', read('core.js')], ['push.js', read('push.js')], ['app.js', read('app.js')]], { now: Date.UTC(2026, 8, 19, 18) });
  const need = [];
  for (const level of ctx.LIGHT_LEVELS) need.push(`light.${level}.label`, `light.${level}.hint`);
  for (const layer of ctx.CLOUD_LAYERS) need.push(`layer.${layer.key}`, `layer.${layer.key}.alt`);
  for (const point of ctx.POINTS) if (point.noteKey) need.push('note.' + point.noteKey);
  for (const phase of ['new', 'waxing_crescent', 'first_quarter', 'waxing_gibbous', 'full', 'waning_gibbous', 'last_quarter', 'waning_crescent']) need.push('moon.phase.' + phase);
  for (const code of ['http', 'timeout', 'offline', 'no_cloud', 'no_values', 'not_list', 'points_count', 'empty', 'no_rows', 'bad_kp']) need.push('err.' + code);
  for (const how of ['direct', 'sw']) need.push('how.' + how);
  for (const zone of ['murmansk', 'device']) need.push('tz.' + zone);
  for (const level of ['strong', 'south', 'weak', 'north']) need.push('sw.outlook.' + level);
  for (const level of ['high', 'mid', 'low', 'none']) need.push('ov.level.' + level);
  for (const c of ['clear', 'windy', 'snow', 'rain', 'fog']) need.push('wx.' + c);
  for (let d = 0; d < 8; d++) need.push('wind.dir.' + d);
  for (const row of ctx.NCHART_ROWS) need.push('nchart.row.' + row);
  for (const side of ['n', 's', 'e', 'w']) need.push('coord.' + side);
  for (const id of ['best_match', 'icon_eu', 'icon_seamless', 'icon_global', 'metno_seamless', 'ecmwf_ifs025', 'gfs_seamless', 'ukmo_seamless', 'meteofrance_seamless']) need.push('model.' + id);
  assert.deepEqual(need.filter(key => !(key in ru)), []);
  assert.ok(`model.${ctx.CONFIG.weatherModel}` in ru, 'модель прогноза, которая используется, есть в словаре');
});

test('точки: у каждой есть название на всех трёх языках, русское совпадает с name', () => {
  const ctx = loadApp([['core.js', read('core.js')]], {});
  for (const point of ctx.POINTS) {
    for (const code of ['ru', 'en', 'zh']) assert.ok(point.names[code], `${point.id}: ${code}`);
    assert.equal(point.names.ru, point.name);
    assert.doesNotMatch(point.names.en, CYRILLIC);
    assert.match(point.names.zh, CJK);
  }
});

/* ---------------- определение языка ---------------- */

const engine = () => loadApp([['i18n.js', read('i18n.js')]], {});

test('определение языка: адрес важнее сохранённого, сохранённое важнее браузера, браузер — по порядку предпочтений', () => {
  const c = engine();
  assert.equal(c.detectLang('zh', 'en', ['ru-RU']), 'zh');
  assert.equal(c.detectLang(null, 'en', ['ru-RU']), 'en');
  assert.equal(c.detectLang(null, null, ['ru-RU', 'en']), 'ru');
  assert.equal(c.detectLang(null, null, ['fr-FR', 'zh-Hans-CN', 'en-US']), 'zh');
  assert.equal(c.detectLang(null, null, ['zh-TW']), 'zh');   // традиционное письмо тоже ближе к китайскому, чем к английскому
});

test('определение языка: чужой язык браузера — английский; мусор в сохранённом и в адресе игнорируется', () => {
  const c = engine();
  assert.equal(c.detectLang(null, null, ['fr-FR', 'de']), 'en');
  assert.equal(c.detectLang(null, null, []), 'en');
  assert.equal(c.detectLang(null, null, undefined), 'en');
  assert.equal(c.detectLang('xx', 'klingon', ['ru']), 'ru');
  assert.equal(c.detectLang(null, '__proto__', ['zh']), 'zh');
});

test('движок: неизвестный язык не переключает, ключа нет — возвращается сам ключ, запасной язык — английский', () => {
  const c = engine();
  c.i18nRegister('ru', { a: 'русский', only_ru: 'только по-русски' });
  c.i18nRegister('en', { a: 'english' });
  assert.equal(c.setLang('xx'), 'ru');
  assert.equal(c.t('a'), 'русский');
  c.setLang('en');
  assert.equal(c.t('a'), 'english');
  assert.equal(c.t('only_ru'), 'только по-русски', 'нет в английском — берётся русский');
  assert.equal(c.t('nope'), 'nope');
  assert.equal(c.hasKey('nope'), false);
});

test('движок: подстановка не зависит от спецсимволов в значении и оставляет неизвестное как есть', () => {
  const c = engine();
  c.i18nRegister('ru', { a: 'x {v} y {w}' });
  assert.equal(c.t('a', { v: '$& $1' }), 'x $& $1 y {w}');
  assert.equal(c.t('a', { v: 0 }), 'x 0 y {w}');
});

test('движок: множественное число выбирает форму по правилам языка', () => {
  const c = engine();
  c.i18nRegister('ru', { m: { one: '{n} минуту', few: '{n} минуты', many: '{n} минут', other: '{n} минуты' } });
  c.i18nRegister('en', { m: { one: '{n} minute', other: '{n} minutes' } });
  c.i18nRegister('zh', { m: { other: '{n}分钟' } });
  const ruWords = n => { c.setLang('ru'); return c.t('m', { n }); };
  assert.deepEqual([1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111].map(ruWords),
    ['1 минуту', '2 минуты', '4 минуты', '5 минут', '11 минут', '12 минут', '14 минут', '21 минуту', '22 минуты', '25 минут', '101 минуту', '111 минут']);
  c.setLang('en');
  assert.deepEqual([1, 2, 11, 21].map(n => c.t('m', { n })), ['1 minute', '2 minutes', '11 minutes', '21 minutes']);
  c.setLang('zh');
  assert.deepEqual([1, 2, 30].map(n => c.t('m', { n })), ['1分钟', '2分钟', '30分钟']);
});

/* ---------------- страница на каждом языке ---------------- */

const element = () => ({
  textContent: '', hidden: false, disabled: false, className: '', style: { setProperty() {} },
  children: [], attrs: {},
  setAttribute(k, v) { this.attrs[k] = String(v); },
  getAttribute(k) { return this.attrs[k] ?? null; },
  addEventListener() {},
  querySelector() { return element(); },
  appendChild(child) { this.children.push(child); return child; },
  set innerHTML(value) { if (value === '') this.children = []; },
  get innerHTML() { return ''; }
});

const plainCopy = value => JSON.parse(JSON.stringify(value));

function page(nowIso = '2026-09-26T22:00:00Z', extra = {}) {
  const elements = new Map();
  const getElement = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const ctx = loadApp(
    [['config.js', read('config.js')], ['core.js', read('core.js')], ['push.js', read('push.js')], ['app.js', read('app.js')]],
    { now: Date.parse(nowIso), getElement, createElement: () => element(), ...extra });
  ctx.state.point = ctx.findPoint('murmansk');
  return { ctx, el: getElement, elements };
}

test('число: десятичная запятая только в русском', () => {
  const { ctx } = page();
  assert.equal(ctx.fmtKp(4.3), '4,3');
  ctx.setLang('en'); assert.equal(ctx.fmtKp(4.3), '4.3');
  ctx.setLang('zh'); assert.equal(ctx.fmtKp(4.3), '4.3');
});

test('возраст данных: русский склоняет, английский и китайский — по-своему', () => {
  const { ctx } = page();
  const min = 60000;
  const cases = {
    ru: [[0, 'меньше минуты назад'], [1, '1 минуту назад'], [22, '22 минуты назад'], [60, '1 час назад'], [65, '1 час 5 минут назад'], [125, '2 часа 5 минут назад'], [300, '5 часов назад']],
    en: [[0, 'less than a minute ago'], [1, '1 minute ago'], [22, '22 minutes ago'], [60, '1 hour ago'], [65, '1 hour 5 minutes ago'], [125, '2 hours 5 minutes ago']],
    zh: [[0, '不到 1 分钟前'], [1, '1分钟前'], [22, '22分钟前'], [60, '1小时前'], [65, '1小时5分钟前'], [125, '2小时5分钟前']]
  };
  for (const [lang, list] of Object.entries(cases)) {
    ctx.setLang(lang);
    for (const [mins, want] of list) assert.equal(ctx.fmtAge(mins * min), want, `${lang}, ${mins} мин`);
  }
});

test('время и дни недели: 24-часовой формат и московское время на любом языке', () => {
  const { ctx } = page();
  const date = new Date('2026-09-26T16:05:00Z');
  for (const lang of ['ru', 'en', 'zh']) {
    ctx.setLang(lang);
    assert.equal(ctx.fmtTime(date), '19:05', lang);
  }
  ctx.setLang('en'); assert.equal(ctx.fmtWeekday(date), 'Sat');
  ctx.setLang('zh'); assert.equal(ctx.fmtWeekday(date), '周六');
});

test('Луна и вердикт на английском и китайском: те же факты, слова другие', () => {
  const { ctx } = page('2026-09-26T22:00:00Z');
  ctx.setLang('en');
  assert.equal(ctx.moonFactor({ illumination: 0.923, up: true }), 'Moon: 92%, above the horizon');
  assert.equal(ctx.moonWindowText({ illumination: 0.6, upShare: 0.5, rise: new Date('2026-09-27T01:00:00Z'), set: new Date('2026-09-27T02:00:00Z') }), 'Moon 60%, above the horizon 04:00–05:00');
  const en = ctx.computeVerdict({ value: 4.3, stale: null }, { value: 10, conflict: false, stale: null });
  assert.equal(en.level, 'high');
  assert.equal(en.label, 'High');
  assert.deepEqual(Array.from(en.factors).slice(0, 3), ['Kp 4.3', 'Cloud cover 10%', 'Dark sky']);
  assert.match(en.hint, /^Good conditions/);

  ctx.setLang('zh');
  const zh = ctx.computeVerdict({ value: 4.3, stale: null }, { value: 10, conflict: false, stale: null });
  assert.equal(zh.level, 'high', 'уровень от языка не зависит');
  assert.equal(zh.label, '高');
  assert.deepEqual(Array.from(zh.factors).slice(0, 3), ['Kp 4.3', '云量 10%', '夜空漆黑']);
  assert.equal(ctx.moonFactor({ illumination: 0.5, up: false }), '月亮：50%，在地平线下');
});

test('уровень вердикта не зависит от языка на всей сетке входных данных', () => {
  const { ctx } = page();
  for (const kp of [0, 1.3, 2.7, 4.3, 6.7]) {
    for (const cloud of [0, 30, 60, 100]) {
      const levels = ['ru', 'en', 'zh'].map(lang => {
        ctx.setLang(lang);
        return ctx.computeVerdict({ value: kp, stale: null }, { value: cloud, conflict: false, stale: null }).level;
      });
      assert.equal(new Set(levels).size, 1, `Kp ${kp}, облачность ${cloud}: ${levels}`);
    }
  }
});

test('ошибки загрузки: текст строится по коду и переводится вместе со страницей', () => {
  const { ctx, el } = page();
  const error = ctx.appError('http', { status: 503 });
  ctx.showError('kp-error', 'kp.error', error);
  assert.equal(el('kp-error').textContent, 'NOAA SWPC недоступен: сервер ответил 503.');

  ctx.setLang('en');
  ctx.refreshErrors();
  assert.equal(el('kp-error').textContent, 'NOAA SWPC is unavailable: the server responded 503.');

  ctx.setLang('zh');
  ctx.refreshErrors();
  assert.equal(el('kp-error').textContent, 'NOAA SWPC 不可用：服务器返回 503。');

  // чужая ошибка без кода показывается как есть, а не пропадает
  ctx.showError('cloud-error', 'cloud.error', new Error('boom'));
  assert.equal(el('cloud-error').textContent, 'Open-Meteo 不可用：boom。');
});

test('ошибки разбора из общего ядра тоже несут код', () => {
  const { ctx } = page();
  assert.throws(() => ctx.normalizeRows([]), e => e.code === 'empty');
  assert.throws(() => ctx.readKpSeries([{ time_tag: '2026-09-26T00:00:00', kp_index: 'x' }]), e => typeof e.code === 'string');
});

test('строка статуса и подписи устаревших данных перерисовываются на новом языке', () => {
  const { ctx, el } = page();
  ctx.state.kp = { value: 2, time: null, stale: null };
  ctx.updateStatus();
  assert.match(el('updated').textContent, /^Обновлено в \d\d:\d\d$/);
  ctx.setLang('en');
  ctx.renderStatus();
  assert.match(el('updated').textContent, /^Updated at \d\d:\d\d$/);
  ctx.setLang('zh');
  ctx.renderStatus();
  assert.match(el('updated').textContent, /^更新于 \d\d:\d\d$/);

  const note = element(), text = element();
  note.querySelector = () => text;
  const original = ctx.$;
  ctx.$ = id => (id === 'kp-stale' ? note : original(id));
  ctx.applyFreshness('kp-card', 'kp-stale', 22 * 60000, 'lead.offline');
  assert.equal(text.textContent, '无网络连接，数据来自22分钟前');
  ctx.setLang('en');
  ctx.applyFreshness('kp-card', 'kp-stale', 65 * 60000, 'lead.calc_saved');
  assert.equal(text.textContent, 'Calculated from saved data: 1 hour 5 minutes ago');
});

test('вкладка «Куда ехать»: точка называется на языке страницы, в пути — часы в местной записи', () => {
  const { ctx, elements } = page('2026-09-26T22:00:00Z');
  const point = ctx.findPoint('teriberka');
  const from = new Date('2026-09-26T21:00:00Z'), to = new Date('2026-09-27T00:00:00Z');
  const list = [{ point, window: { polarDay: false, level: 2, from, to, cloudMin: 10, cloudMax: 20, kpMax: 4.3, fullDark: true, point } }];

  ctx.renderBest(list);
  assert.match(elements.get('best-value').textContent, /^Териберка, 00:00 — 03:00$/);
  assert.match(elements.get('best-hint').textContent, /От Мурманска 120 км, около 2,5 ч пути/);

  ctx.setLang('en');
  ctx.renderBest(list);
  assert.match(elements.get('best-value').textContent, /^Teriberka, 00:00 — 03:00$/);
  assert.match(elements.get('best-hint').textContent, /^high chance · cloud cover 10–20% · Kp up to 4\.3\. 120 km from Murmansk, about 2\.5 h by road\.$/);

  ctx.setLang('zh');
  ctx.renderBest(list);
  assert.match(elements.get('best-value').textContent, /^捷里别尔卡，00:00 — 03:00$/);
  assert.match(elements.get('best-hint').textContent, /^机会大 · 云量 10–20% · Kp 最高 4\.3。距摩尔曼斯克 120 公里，车程约 2\.5 小时。$/);
});

test('заголовок вкладки браузера и подпись точки — на языке страницы', () => {
  const { ctx, el } = page();
  const doc = ctx.document;
  ctx.renderPointMeta();
  assert.match(el('point-meta').textContent, /^68,97° с\. ш\., 33,10° в\. д\. · геомагнитная широта 64,9° · сияние заметно от Kp 1,0$/);
  ctx.setLang('en');
  ctx.renderPointMeta();
  assert.equal(el('point-meta').textContent, '68.97° N, 33.10° E · geomagnetic latitude 64.9° · aurora is noticeable from Kp 1.0');
  ctx.setLang('zh');
  ctx.renderPointMeta();
  assert.equal(el('point-meta').textContent, '北纬 68.97°，东经 33.10° · 地磁纬度 64.9° · Kp 达到 1.0 起可见极光');
  assert.ok(doc, 'документ подменён заглушкой');
});

test('уведомление страницы: язык указан в самом уведомлении и в его тексте', () => {
  const { ctx } = page();
  const shown = [];
  ctx.showAppNotification = (title, options) => { shown.push({ title, body: options.body }); return Promise.resolve('sw'); };
  vm.runInContext("Notification = window.Notification = { permission: 'granted' }; document.hasFocus = () => false;", ctx);
  ctx.localStorage.setItem('aurora.notify', 'on');
  ctx.setLang('en');
  const verdict = { level: 'high', stale: false, factors: ['Kp 4.3', 'Cloud cover 12%', 'Dark sky'] };
  ctx.state.lastLevel = { pointId: 'murmansk', level: 'mid' };
  ctx.checkHighChance(verdict);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, 'High chance of aurora — Murmansk');
  assert.equal(shown[0].body, 'Kp 4.3 · Cloud cover 12% · Dark sky. Look north.');
});

test('ошибки push: тексты на каждом языке, коды те же', () => {
  const { ctx } = page();
  const coded = code => Object.assign(new Error(code), { code });
  ctx.setLang('en');
  assert.match(ctx.pushErrorText(coded('too_often')), /^Too often/);
  assert.match(ctx.pushErrorText(new DOMException('x', 'NotAllowedError')), /permission was not granted/i);
  ctx.setLang('zh');
  assert.match(ctx.pushErrorText(coded('too_often')), /20 秒/);
  assert.match(ctx.pushErrorText(new TypeError('Failed to fetch')), /通知服务器不可用/);
});

test('переключатель: сохранённый язык и адрес читаются, порча хранилища не роняет', () => {
  const { ctx } = page();
  assert.equal(ctx.savedLang(), null);
  ctx.saveLang('zh');
  assert.equal(ctx.savedLang(), 'zh');
  assert.equal(ctx.langFromUrl(), null);
  vm.runInContext("location.search = '?lang=en&x=1'", ctx);
  assert.equal(ctx.langFromUrl(), 'en');
  vm.runInContext("location.search = '?foo=1&lang=zh-CN'", ctx);
  assert.equal(ctx.langFromUrl(), 'zh');
  vm.runInContext("location.search = '?lang=klingon'", ctx);
  assert.equal(ctx.langFromUrl(), null);

  vm.runInContext("localStorage.getItem = () => { throw new Error('заблокировано'); }; localStorage.setItem = () => { throw new Error('заблокировано'); };", ctx);
  assert.equal(ctx.savedLang(), null);
  assert.doesNotThrow(() => ctx.saveLang('en'));
});

test('разметка: у каждого языка кнопка в переключателе, а у страницы — атрибут lang исходного языка', () => {
  const html = read('index.html');
  for (const code of ['ru', 'en', 'zh']) assert.match(html, new RegExp(`data-lang="${code}"`));
  assert.match(html, /<html lang="ru">/);
  assert.match(html, /aria-label="Language · Язык · 语言"/);
});

test('оболочка service worker: движок и все словари лежат в кэше, версия поднята', () => {
  const sw = read('sw.js');
  for (const file of ['i18n.js', 'lang/ru.js', 'lang/en.js', 'lang/zh.js']) assert.ok(sw.includes(`'${file}'`), file);
  assert.ok(Number(/CACHE_VERSION = 'v(\d+)'/.exec(sw)[1]) >= 10);
});

test('подписка на сервер уведомлений несёт язык страницы; без движка переводов язык не указывается', () => {
  const { ctx } = page();
  ctx.setLang('zh');
  const body = plainCopy(ctx.pushSubscription('https://e.example/1', 'teriberka'));
  assert.deepEqual({ ...body, tz: typeof body.tz }, { endpoint: 'https://e.example/1', point: 'teriberka', lang: 'zh', quiet: null, tz: 'string', level: 'high', sky: false });

  const bare = loadApp([['push.js', read('push.js')]], {});
  assert.deepEqual({ ...bare.pushSubscription('https://e.example/1', 'teriberka') }, { endpoint: 'https://e.example/1', point: 'teriberka' });
});

/** Страница, в которой элементы запоминают обработчики — чтобы «нажать» на переключатель. */
function clickablePage() {
  const built = page();
  const listening = new Map();
  const wrap = id => {
    const node = built.el(id);
    if (!node.listeners) { node.listeners = {}; node.addEventListener = (type, fn) => { node.listeners[type] = fn; }; }
    listening.set(id, node);
    return node;
  };
  wrap('lang');
  const choose = code => built.el('lang').listeners.click({ target: { closest: () => ({ getAttribute: () => code }) } });
  return { ...built, choose };
}

test('нажатие на язык: выбор сохраняется, ?lang= убирается из адреса, карточки и ошибки переводятся, серверу уходит новый язык', async () => {
  const { ctx, el, choose } = clickablePage();
  vm.runInContext("location.search = '?lang=zh'; location.pathname = '/'; location.hash = '#now'; " +
    "var replaced = []; history.replaceState = function () { replaced.push([].slice.call(arguments)); };", ctx);

  ctx.initLanguage();
  assert.equal(ctx.getLang(), 'zh', 'адрес выбрал язык');
  assert.equal(ctx.savedLang(), 'zh', 'и запомнился');

  ctx.showError('kp-error', 'kp.error', ctx.appError('timeout'));
  ctx.state.kp = { value: 4.3, time: null, stale: null };
  choose('en');

  assert.equal(ctx.getLang(), 'en');
  assert.equal(ctx.savedLang(), 'en');
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(replaced)', ctx)), [[null, '', '/#now']], 'параметр убран из адреса');
  assert.equal(el('kp-error').textContent, 'NOAA SWPC is unavailable: timed out.', 'ошибка перестроена');
  assert.equal(el('kp-caption').textContent, 'Elevated activity — the auroral oval is overhead', 'карточка Kp перерисована');
  assert.match(el('point-meta').textContent, /^68\.97° N/);

  // повторное нажатие на тот же язык ничего не делает
  vm.runInContext('replaced.length = 0', ctx);
  ctx.showError('kp-error', 'kp.error', ctx.appError('offline'));
  choose('en');
  assert.equal(el('kp-error').textContent, 'NOAA SWPC is unavailable: timed out.'.replace('timed out', 'no connection'));
  assert.equal(vm.runInContext('replaced.length', ctx), 0);

  choose('zh');
  assert.equal(el('kp-error').textContent, 'NOAA SWPC 不可用：无网络连接。');
});

test('настоящий сбой загрузки: текст ошибки в карточках строится по коду и переводится вместе со страницей', async () => {
  const { ctx, el } = page('2026-09-26T22:00:00Z', { fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
  await Promise.all([ctx.loadKp(), ctx.loadCloud(), ctx.loadForecast()]);

  assert.equal(el('kp-error').textContent, 'NOAA SWPC недоступен: нет соединения.');
  assert.equal(el('cloud-error').textContent, 'Open-Meteo недоступен: нет соединения.');
  assert.equal(el('forecast-error').textContent, 'Прогноз NOAA недоступен: нет соединения.');

  ctx.setLang('en');
  ctx.refreshErrors();
  assert.equal(el('kp-error').textContent, 'NOAA SWPC is unavailable: no connection.');
  assert.equal(el('cloud-error').textContent, 'Open-Meteo is unavailable: no connection.');
  assert.equal(el('forecast-error').textContent, 'NOAA forecast is unavailable: no connection.');
});
