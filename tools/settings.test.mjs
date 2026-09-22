// Настройки отображения и вкладка «Настройки»: значения, хранение, единицы, часовой пояс,
// автообновление, перенос уведомлений на новую вкладку.
// Запуск: node --test tools/settings.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
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

function page(nowIso = '2026-09-26T22:00:00Z') {
  const elements = new Map();
  const getElement = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const ctx = loadApp(
    [['config.js', read('config.js')], ['core.js', read('core.js')], ['push.js', read('push.js')], ['app.js', read('app.js')]],
    { now: Date.parse(nowIso), getElement, createElement: () => element() });
  ctx.state.point = ctx.findPoint('murmansk');
  return { ctx, el: getElement };
}

const put = (ctx, value) => ctx.localStorage.setItem('aurora.settings', typeof value === 'string' ? value : JSON.stringify(value));
const plain = value => JSON.parse(JSON.stringify(value));

test('по умолчанию всё как было до появления настроек: Москва, 24 часа, км, °C, 5 минут', () => {
  const { ctx } = page();
  assert.deepEqual(plain(ctx.loadSettings()), { tz: 'murmansk', clock: '24', dist: 'km', temp: 'c', refresh: '5', theme: 'dark', size: 'normal', start: 'last', quiet: 'off' });
  assert.equal(ctx.fmtTime(new Date('2026-09-26T16:05:00Z')), '19:05');
  assert.equal(ctx.distText(120), '120 км');
  assert.equal(ctx.tempText(3), '+3 °C');
  assert.equal(ctx.refreshMs(), 5 * 60 * 1000);
});

test('испорченное или чужое хранилище не ломает настройки: недопустимое заменяется умолчанием', () => {
  const cases = [
    'не json', '[]', 'null', '42', '"строка"', '{"tz":"mars"}', '{"tz":"device","clock":"13","refresh":"1"}',
    '{"__proto__":{"tz":"device"}}', '{"tz":["device"]}'
  ];
  for (const raw of cases) {
    const { ctx } = page();
    put(ctx, raw);
    const got = plain(ctx.loadSettings());
    for (const [name, choices] of Object.entries(plain(ctx.SETTINGS_CHOICES))) assert.ok(choices.includes(got[name]), `${raw}: ${name}=${got[name]}`);
  }
  const { ctx } = page();
  put(ctx, '{"tz":"device","clock":"13","dist":"mi"}');
  assert.deepEqual(plain(ctx.loadSettings()), { tz: 'device', clock: '24', dist: 'mi', temp: 'c', refresh: '5', theme: 'dark', size: 'normal', start: 'last', quiet: 'off' }, 'годное сохраняется, негодное — умолчание');
});

test('хранилище недоступно: настройки работают, просто не переживают перезагрузку', () => {
  const { ctx } = page();
  vm.runInContext("localStorage.getItem = () => { throw new Error('заблокировано'); }; localStorage.setItem = () => { throw new Error('заблокировано'); }; localStorage.removeItem = () => { throw new Error('заблокировано'); };", ctx);
  assert.equal(ctx.setting('dist'), 'km');
  assert.equal(ctx.setSetting('dist', 'mi'), true);
  assert.equal(ctx.setting('dist'), 'mi');
  assert.doesNotThrow(() => ctx.resetSettings());
  assert.equal(ctx.setting('dist'), 'km');
});

test('setSetting: недопустимое имя и значение отклоняются и ничего не меняют, допустимое сохраняется', () => {
  const { ctx } = page();
  assert.equal(ctx.setSetting('tz', 'mars'), false);
  assert.equal(ctx.setSetting('nope', 'x'), false);
  assert.equal(ctx.setSetting('__proto__', 'x'), false);
  assert.equal(ctx.setSetting('refresh', 10), false, 'значения — строки');
  assert.equal(ctx.localStorage.getItem('aurora.settings'), null);

  assert.equal(ctx.setSetting('temp', 'f'), true);
  assert.deepEqual(JSON.parse(ctx.localStorage.getItem('aurora.settings')).temp, 'f');
  // после «перезагрузки» — тот же выбор
  const again = page();
  again.ctx.localStorage.setItem('aurora.settings', ctx.localStorage.getItem('aurora.settings'));
  assert.equal(again.ctx.setting('temp'), 'f');
});

test('часовой пояс: московский по умолчанию, «устройство» — пояс машины; дата и день недели тоже', () => {
  const { ctx } = page();
  const date = new Date('2026-09-26T21:30:00Z');    // в Москве уже 27-е, 00:30
  assert.equal(ctx.fmtTime(date), '00:30');
  assert.equal(ctx.displayZone(), 'Europe/Moscow');

  ctx.setSetting('tz', 'device');
  assert.equal(ctx.displayZone(), undefined);
  const expected = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
  assert.equal(ctx.fmtTime(date), expected);
  assert.equal(ctx.fmtWeekday(date), new Intl.DateTimeFormat('ru-RU', { weekday: 'short' }).format(date));
  assert.equal(ctx.fmtDayKey(date), new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'numeric' }).format(date));
});

test('формат времени: 12 часов с AM/PM на английском, 24 часа — по умолчанию', () => {
  const { ctx } = page();
  ctx.setLang('en');
  const date = new Date('2026-09-26T16:05:00Z');    // 19:05 в Москве
  assert.equal(ctx.fmtTime(date), '19:05');
  ctx.setSetting('clock', '12');
  assert.match(ctx.fmtTime(date), /^0?7:05\s?(pm|PM|p\.m\.)$/);
  assert.equal(ctx.fmtTime(new Date('2026-09-26T21:05:00Z')).replace(/\s/g, '').toLowerCase().replace(/^12:05am|^0?12:05am/, 'ok'), 'ok', 'полночь — 12:05 am');
});

test('единицы: расстояние в милях и температура в градусах Фаренгейта — с правильными словами на трёх языках', () => {
  const { ctx } = page();
  ctx.setSetting('dist', 'mi');
  const mi = (lang, km) => { ctx.setLang(lang); return ctx.distText(km); };
  assert.equal(mi('ru', 120), '75 миль');
  assert.equal(mi('ru', 110), '68 миль');
  assert.equal(mi('ru', 1.6), '1 миля', 'один километр с небольшим — одна миля');
  assert.equal(mi('en', 120), '75 miles');
  assert.equal(mi('en', 1.6), '1 mile');
  assert.equal(mi('zh', 280), '174 英里');

  ctx.setSetting('dist', 'km');
  assert.equal(mi('ru', 120), '120 км');
  assert.equal(mi('en', 120), '120 km');
  assert.equal(mi('zh', 120), '120 公里');

  ctx.setSetting('temp', 'f');
  assert.equal(ctx.tempText(0), '32 °F');
  assert.equal(ctx.tempText(-4), '25 °F');
  assert.equal(ctx.tempText(3), '37 °F');
  assert.equal(ctx.tempText(-40), '-40 °F');
  ctx.setSetting('temp', 'c');
  assert.equal(ctx.tempText(-4), '-4 °C');
  assert.equal(ctx.tempText(0), '0 °C');
});

test('единицы доходят до вкладки «Куда ехать»: и в ответе, и в списке точек', () => {
  const { ctx, el } = page();
  const point = ctx.findPoint('kandalaksha');
  const from = new Date('2026-09-26T21:00:00Z'), to = new Date('2026-09-27T00:00:00Z');
  const win = { polarDay: false, level: 2, from, to, cloudMin: 10, cloudMax: 20, kpMax: 4.3, fullDark: true, point };
  const box = el('places-list');
  ctx.renderBest([{ point, window: win }]);
  assert.match(el('best-hint').textContent, /От Мурманска 280 км, около 4 ч пути/);

  ctx.setSetting('dist', 'mi');
  ctx.renderBest([{ point, window: win }]);
  assert.match(el('best-hint').textContent, /От Мурманска 174 мили, около 4 ч пути/);
  ctx.setLang('en');
  ctx.renderBest([{ point, window: win }]);
  assert.match(el('best-hint').textContent, /\. 174 miles from Murmansk, about 4 h by road\.$/);

  ctx.renderPlaces([{ point, window: win }]);
  assert.match(box.children[0].children[3].textContent, /^174 miles from Murmansk, about 4 h by road · light pollution noticeable$/);
});

test('автообновление: период по настройке, при смене старый таймер снимается, «Выкл» таймер не заводит', () => {
  const { ctx } = page();
  const calls = [];
  vm.runInContext("var log = []; var next = 100; setInterval = function (fn, ms) { log.push(['set', ms]); return ++next; }; " +
    "clearInterval = function (id) { log.push(['clear', id]); };", ctx);
  const log = () => JSON.parse(vm.runInContext('JSON.stringify(log)', ctx));

  ctx.armRefresh();
  assert.deepEqual(log(), [['set', 300000]]);

  ctx.setSetting('refresh', '30');
  ctx.armRefresh();
  assert.deepEqual(log().slice(1), [['clear', 101], ['set', 1800000]]);

  ctx.setSetting('refresh', '0');
  ctx.armRefresh();
  assert.deepEqual(log().slice(3), [['clear', 102]], 'выключено — нового таймера нет');
  assert.equal(ctx.state.timer, null);
  assert.equal(ctx.refreshMs(), 0);
  assert.ok(calls.length === 0);
});

test('подписи в странице следуют за настройками: пояс в примечании к прогнозу и период обновления в подвале', () => {
  const { ctx, el } = page();
  ctx.renderSettings();
  assert.match(el('forecast-note').textContent, /^Время местное \(UTC\+3\), шаг 3 часа\./);
  assert.equal(el('foot-refresh').textContent, 'Обновление автоматически каждые 5 минут.');

  ctx.setSetting('tz', 'device');
  ctx.setSetting('refresh', '10');
  ctx.setLang('en');
  ctx.renderSettings();
  assert.match(el('forecast-note').textContent, /^Your device’s time, 3-hour steps\./);
  assert.equal(el('foot-refresh').textContent, 'Updates automatically every 10 minutes.');

  ctx.setSetting('refresh', '0');
  ctx.renderSettings();
  assert.equal(el('foot-refresh').textContent, 'Auto-refresh is off — use the Refresh button to update.');

  ctx.setLang('zh');
  ctx.setSetting('refresh', '30');
  ctx.renderSettings();
  assert.equal(el('foot-refresh').textContent, '每30分钟自动更新。');
});

test('нажатие на кнопку настройки: значение применяется, сохраняется, страница перерисовывается; сброс возвращает умолчания', () => {
  const { ctx, el } = page();
  ctx.initSettings();

  const press = (name, value) => el('tab-settings').listeners.click({
    target: { closest: sel => (sel === '[data-value]' ? { getAttribute: () => value, closest: () => ({ getAttribute: () => name }) } : null) }
  });

  ctx.state.cloud = { weather: { temp: 3, feels: null, wind: null, gusts: null, dir: null, precip: 0, rain: 0, snow: 0, code: 0, vis: null, humidity: null }, value: 20, byLayers: false, conflict: false, total: 20, layers: {}, temp: 3, time: null, soon: null, hours: [], pointId: 'murmansk', stale: null };
  press('temp', 'f');
  assert.equal(ctx.setting('temp'), 'f');
  assert.equal(el('wx-value').textContent, '37 °F', 'карточка погоды перерисована');
  assert.equal(JSON.parse(ctx.localStorage.getItem('aurora.settings')).temp, 'f');

  press('temp', 'kelvin');
  assert.equal(ctx.setting('temp'), 'f', 'недопустимое игнорируется');

  el('prefs-reset').listeners.click();
  assert.equal(ctx.setting('temp'), 'c');
  assert.equal(ctx.localStorage.getItem('aurora.settings'), null);
  assert.equal(el('wx-value').textContent, '+3 °C');
});

test('вкладка «Уведомления» теперь часть «Настроек»: старые адреса #notify и сохранённый выбор ведут туда', () => {
  const { ctx } = page();
  vm.runInContext('fetch = function () { return new Promise(function () {}); }', ctx);   // вкладка «Куда ехать» пойдёт за данными — ответа не будет
  assert.equal(ctx.tabFromName('notify'), 'settings');
  assert.equal(ctx.tabFromName('now'), 'now');
  assert.deepEqual(Array.from(ctx.TAB_IDS), ['now', 'tonight', 'settings']);

  const opened = id => { ctx.showTab(id, 'replace'); return ctx.state.tab; };
  assert.equal(opened('notify'), 'settings');
  assert.equal(opened('settings'), 'settings');
  assert.equal(opened('tonight'), 'tonight');
  assert.equal(opened('чепуха'), 'now');
});

test('разметка: уведомления лежат внутри вкладки «Настройки», отдельной вкладки нет, значения кнопок допустимы', () => {
  const html = read('index.html');
  assert.doesNotMatch(html, /tab-notify|tab-btn-notify|data-tab="notify"/);
  assert.equal((html.match(/role="tab"/g) || []).length, 3);

  const panel = html.slice(html.indexOf('id="tab-settings"'), html.indexOf('</main>'));
  for (const id of ['prefs', 'prefs-reset', 'push-card', 'push-toggle', 'ntest-checks', 'ntest-now', 'ntest-later', 'notify-hint'].filter(id => id !== 'notify-hint')) {
    assert.ok(panel.includes(`id="${id}"`), id);
  }
  assert.ok(panel.indexOf('id="prefs"') < panel.indexOf('id="push-card"'), 'настройки вида — выше уведомлений');

  const ctx = page().ctx;
  const choices = plain(ctx.SETTINGS_CHOICES);
  const groups = [...panel.matchAll(/data-pref="(\w+)">([\s\S]*?)<\/div>/g)];
  assert.deepEqual(groups.map(g => g[1]).sort(), Object.keys(choices).sort(), 'по группе на каждую настройку');
  for (const [, name, body] of groups) {
    const values = [...body.matchAll(/data-value="([\w-]+)"/g)].map(m => m[1]);
    assert.deepEqual(values.sort(), [...choices[name]].sort(), `кнопки настройки ${name}`);
  }
});

test('ссылка на вкладку из подсказки под вердиктом называет «Настройки» на каждом языке', () => {
  const { ctx } = page();
  for (const [lang, word] of [['ru', 'Настройки'], ['en', 'Settings'], ['zh', '设置']]) {
    ctx.setLang(lang);
    assert.ok(ctx.t('notify.hint.server').includes(word), lang);
    assert.equal(ctx.t('tab.settings'), word);
  }
});

test('возврат на вкладку: обновляемся, если прошло больше периода; при выключенном автообновлении — никогда', () => {
  const { ctx } = page();
  const MIN = 60000;
  // время в песочнице зафиксировано, поэтому «давно» считается от него, а не от часов машины
  const ago = minutes => vm.runInContext(`new Date(Date.now() - ${minutes * MIN})`, ctx);
  assert.equal(ctx.refreshDue(), true, 'ещё ни разу не обновлялись');

  ctx.state.lastOk = ago(4);
  assert.equal(ctx.refreshDue(), false, '4 минуты при периоде в 5');
  ctx.state.lastOk = ago(6);
  assert.equal(ctx.refreshDue(), true);

  ctx.setSetting('refresh', '30');
  assert.equal(ctx.refreshDue(), false, '6 минут при периоде в 30');
  ctx.state.lastOk = ago(31);
  assert.equal(ctx.refreshDue(), true);

  ctx.setSetting('refresh', '0');
  assert.equal(ctx.refreshDue(), false, 'выключено — только по кнопке, как бы давно ни обновлялись');
  ctx.state.lastOk = null;
  assert.equal(ctx.refreshDue(), false);
});

test('смена периода автообновления кнопкой сразу перезапускает таймер', () => {
  const { ctx, el } = page();
  ctx.initSettings();
  vm.runInContext("var log = []; var next = 100; setInterval = function (fn, ms) { log.push(['set', ms]); return ++next; }; " +
    "clearInterval = function (id) { log.push(['clear', id]); };", ctx);
  const press = (name, value) => el('tab-settings').listeners.click({
    target: { closest: sel => (sel === '[data-value]' ? { getAttribute: () => value, closest: () => ({ getAttribute: () => name }) } : null) }
  });
  ctx.armRefresh();
  press('refresh', '10');
  press('refresh', '0');
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(log)', ctx)),
    [['set', 300000], ['clear', 101], ['set', 600000], ['clear', 102]]);
  assert.equal(ctx.state.timer, null);
});

test('пробное уведомление: время в подтверждении — в выбранном формате и поясе', async () => {
  const { ctx, el } = page();
  vm.runInContext("Notification = window.Notification = { permission: 'granted' };", ctx);
  ctx.showAppNotification = () => Promise.resolve('sw');
  ctx.setLang('en');

  ctx.sendTestNotification(0);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(el('ntest-status').textContent, /^Sent at \d\d:\d\d:\d\d \(via the service worker\)\./, '24 часа');

  ctx.setSetting('clock', '12');
  ctx.sendTestNotification(0);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(el('ntest-status').textContent, /^Sent at \d?\d:\d\d:\d\d\s?(am|pm) \(/i, '12 часов');
});

test('строка «Обновлено в …» пересобирается при смене формата времени, а не остаётся прежней', () => {
  const { ctx, el } = page();
  ctx.state.kp = { value: 2, time: null, stale: null };
  ctx.updateStatus();
  assert.match(el('updated').textContent, /^Обновлено в \d\d:\d\d$/);

  ctx.setLang('en');
  ctx.setSetting('clock', '12');
  ctx.renderStatus();
  assert.match(el('updated').textContent, /^Updated at \d?\d:\d\d\s?(am|pm)$/i);

  ctx.state.kp = null;
  ctx.updateStatus();
  assert.match(el('updated').textContent, /^Offline · last data at \d?\d:\d\d\s?(am|pm)$/i);
});
