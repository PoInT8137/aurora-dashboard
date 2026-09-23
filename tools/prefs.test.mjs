// Оформление и поведение: тема, размер текста, стартовая вкладка, тихие часы.
// Запуск: node --test tools/prefs.test.mjs
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

const put = (ctx, value) => ctx.localStorage.setItem('aurora.settings', JSON.stringify(value));
const plain = value => JSON.parse(JSON.stringify(value));

/** Корневой элемент и <meta theme-color>, которые запоминают атрибуты; matchMedia подконтролен. */
function appearance(ctx, { systemLight = false } = {}) {
  const root = { attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); } };
  const meta = { attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); } };
  ctx.document.documentElement = root;
  ctx.document.querySelector = sel => (sel === 'meta[name="theme-color"]' ? meta : null);
  ctx.window.matchMedia = query => ({ matches: query.includes('light') && systemLight, addEventListener() {} });
  return { root, meta };
}

test('тема: тёмная по умолчанию, светлая по выбору, «как в системе» следует за системой; цвет строки состояния в тон', () => {
  const { ctx } = page();
  const { root, meta } = appearance(ctx);
  ctx.applyAppearance();
  assert.deepEqual([root.attrs['data-theme'], root.attrs['data-size'], meta.attrs.content], ['dark', 'normal', '#060b14']);

  ctx.setSetting('theme', 'light');
  ctx.applyAppearance();
  assert.deepEqual([root.attrs['data-theme'], meta.attrs.content], ['light', '#eef4f8']);

  ctx.setSetting('theme', 'auto');
  ctx.applyAppearance();
  assert.equal(root.attrs['data-theme'], 'dark', 'система тёмная');

  const light = appearance(ctx, { systemLight: true });
  ctx.applyAppearance();
  assert.equal(light.root.attrs['data-theme'], 'light', 'система светлая');

  ctx.setSetting('size', 'xlarge');
  ctx.applyAppearance();
  assert.equal(light.root.attrs['data-size'], 'xlarge');
});

test('до первой отрисовки: встроенный скрипт из <head> ставит те же атрибуты, что applyAppearance()', () => {
  const html = read('index.html');
  const script = /<script>\s*\/\*[\s\S]*?<\/script>/.exec(html)[0].replace(/^<script>|<\/script>$/g, '');

  const combos = [
    {}, { theme: 'light' }, { theme: 'dark', size: 'large' }, { theme: 'auto' }, { theme: 'auto', size: 'xlarge' },
    { theme: 'mars', size: 'huge' }
  ];
  for (const systemLight of [false, true]) {
    for (const saved of combos) {
      const early = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
      vm.runInContext(script, vm.createContext({
        localStorage: { getItem: () => JSON.stringify(saved) }, document: { documentElement: early },
        matchMedia: q => ({ matches: q.includes('light') && systemLight }), JSON
      }));

      const { ctx } = page();
      put(ctx, saved);
      const { root } = appearance(ctx, { systemLight });
      ctx.applyAppearance();

      // для значений по умолчанию скрипт атрибута не ставит — там работает CSS без атрибутов
      const effective = attr => early.attrs[attr] ?? (attr === 'data-theme' ? 'dark' : 'normal');
      assert.equal(effective('data-theme'), root.attrs['data-theme'], JSON.stringify({ saved, systemLight }));
      assert.equal(effective('data-size'), root.attrs['data-size'], JSON.stringify({ saved, systemLight }));
    }
  }

  // испорченное хранилище не роняет скрипт
  for (const raw of ['не json', 'null', '[]']) {
    assert.doesNotThrow(() => vm.runInContext(script, vm.createContext({
      localStorage: { getItem: () => raw }, document: { documentElement: { setAttribute() {} } }, matchMedia: () => ({ matches: false }), JSON
    })));
  }
});

const cssVars = block => Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
const css = read('styles.css');
const darkVars = cssVars(/:root\s*{([\s\S]*?)\n}/.exec(css)[1]);
const lightVars = cssVars(/html\[data-theme="light"\]\s*{([\s\S]*?)\n}/.exec(css)[1]);
const nightVars = cssVars(/html\[data-theme="night"\]\s*{([\s\S]*?)\n}/.exec(css)[1]);

test('светлая тема переопределяет все цветовые переменные тёмной: ничего не остаётся «тёмным» на светлом фоне', () => {
  const NOT_COLORS = ['--radius'];
  for (const vars of [lightVars, nightVars]) {
    const missing = Object.keys(darkVars).filter(name => !NOT_COLORS.includes(name) && !(name in vars));
    assert.deepEqual(missing, []);
  }
});

/** Контраст по WCAG для цветов #rrggbb. */
const luminance = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
/** Цвет карточки поверх фона: rgba(r, g, b, a) → #rrggbb. */
const over = (rgba, bg) => {
  const [r, g, b, a] = /rgba\(([^)]+)\)/.exec(rgba)[1].split(',').map(Number);
  const under = [1, 3, 5].map(i => parseInt(bg.slice(i, i + 2), 16));
  return '#' + [r, g, b].map((c, i) => Math.round(c * a + under[i] * (1 - a)).toString(16).padStart(2, '0')).join('');
};

test('контраст текста и тонов не ниже 4,5:1 на фоне страницы и на карточке — во всех темах', () => {
  for (const [theme, vars] of [['тёмная', { ...darkVars }], ['светлая', { ...darkVars, ...lightVars }], ['ночное зрение', { ...darkVars, ...nightVars }]]) {
    const card = over(vars['--bg-card'], vars['--bg']);
    for (const name of ['--text', '--text-dim', '--text-faint', '--ok', '--mid', '--bad', '--aurora-green', '--aurora-teal', '--aurora-violet', '--text-stale']) {
      for (const [where, ground] of [['фон', vars['--bg']], ['карточка', card]]) {
        const ratio = contrast(vars[name], ground);
        assert.ok(ratio >= 4.5, `${theme}: ${name} на фоне «${where}» — ${ratio.toFixed(2)}:1`);
      }
    }
  }
});

test('тона в коде — ссылки на переменные CSS, а не цвета: тема меняет их без перерисовки', () => {
  const { ctx } = page();
  assert.deepEqual(plain(ctx.TONE), { ok: 'var(--ok)', mid: 'var(--mid)', bad: 'var(--bad)' });
  assert.ok(darkVars['--ok'] && darkVars['--mid'] && darkVars['--bad']);
});

test('в правилах нет цветов-литералов мимо переменных, кроме фона-сияния: тема не может оставить тёмное пятно', () => {
  const withoutVarBlocks = css
    .replace(/:root\s*{[\s\S]*?\n}/, '')
    .replace(/html\[data-theme="light"\]\s*{[\s\S]*?\n}/, '')
    .replace(/html\[data-theme="night"\]\s*{[\s\S]*?\n}/, '');
  const literals = withoutVarBlocks.split('\n')
    .filter(line => /#[0-9a-fA-F]{3,6}\b|rgba?\((?!var)/.test(line))
    .filter(line => !/radial-gradient/.test(line));
  assert.deepEqual(literals, []);
});

test('размер текста: крупный и очень крупный масштабируют страницу целиком', () => {
  assert.match(css, /html\[data-size="large"\]\s+body\s*{\s*zoom:\s*1\.15;/);
  assert.match(css, /html\[data-size="xlarge"\]\s+body\s*{\s*zoom:\s*1\.3;/);
});

test('стартовая вкладка: адрес важнее всего, «где закрыл» помнит последнюю, остальное — как выбрано', () => {
  const { ctx } = page();
  assert.equal(ctx.startTab('', 'tonight'), 'tonight', 'по умолчанию — где закрыл');
  assert.equal(ctx.startTab('', 'чепуха'), 'now');
  assert.equal(ctx.startTab('', null), 'now');
  assert.equal(ctx.startTab('settings', 'now'), 'settings', 'ссылка с адресом');

  ctx.setSetting('start', 'tonight');
  assert.equal(ctx.startTab('', 'now'), 'tonight');
  assert.equal(ctx.startTab('settings', 'now'), 'settings', 'адрес всё равно важнее');
  ctx.setSetting('start', 'now');
  assert.equal(ctx.startTab('', 'settings'), 'now');
  assert.equal(ctx.startTab('мусор', 'settings'), 'now', 'негодный адрес не мешает');
});

test('тихие часы на странице: окно по выбранному поясу, включая переход через полночь', () => {
  const inQuiet = (iso, quiet, tz = 'murmansk') => {
    const { ctx } = page(iso);
    ctx.setSetting('quiet', quiet);
    ctx.setSetting('tz', tz);
    return ctx.inQuietNow();
  };
  // 22:00 UTC = 01:00 по Москве
  assert.equal(inQuiet('2026-12-15T22:00:00Z', 'off'), false);
  assert.equal(inQuiet('2026-12-15T22:00:00Z', '00-06'), true);
  assert.equal(inQuiet('2026-12-15T22:00:00Z', '23-07'), true, 'через полночь');
  assert.equal(inQuiet('2026-12-15T22:00:00Z', '22-08'), true);
  assert.equal(inQuiet('2026-12-15T12:00:00Z', '22-08'), false, '15:00 по Москве');
  assert.equal(inQuiet('2026-12-15T04:00:00Z', '00-06'), false, '07:00 по Москве: окно закончилось');
  assert.equal(inQuiet('2026-12-15T03:00:00Z', '00-06'), false, '06:00 — граница не включается');

  const { ctx } = page();
  ctx.setSetting('quiet', '23-07');
  assert.deepEqual(plain(ctx.quietWindow()), { from: 23, to: 7 });
  ctx.setSetting('quiet', 'off');
  assert.equal(ctx.quietWindow(), null);
});

test('уведомление страницы молчит в тихие часы и говорит вне их', () => {
  const run = (iso, quiet) => {
    const { ctx } = page(iso);
    const shown = [];
    ctx.showAppNotification = title => { shown.push(title); return Promise.resolve('sw'); };
    vm.runInContext("Notification = window.Notification = { permission: 'granted' }; document.hasFocus = () => false;", ctx);
    ctx.localStorage.setItem('aurora.notify', 'on');
    ctx.setSetting('quiet', quiet);
    ctx.state.lastLevel = { pointId: 'murmansk', level: 'mid' };
    ctx.checkHighChance({ level: 'high', stale: false, factors: ['Kp 5', 'Облачность 5%', 'Тёмное небо'] });
    return shown.length;
  };
  assert.equal(run('2026-12-15T22:00:00Z', 'off'), 1);
  assert.equal(run('2026-12-15T22:00:00Z', '00-06'), 0, '01:00 по Москве');
  assert.equal(run('2026-12-15T12:00:00Z', '00-06'), 1, '15:00 по Москве');
});

test('предпочтения для сервера: язык, окно тихих часов и пояс — то, по чему сервер считает; пояс следует за настройкой', () => {
  const { ctx } = page();
  ctx.setLang('zh');
  ctx.setSetting('quiet', '23-07');
  let prefs = plain(ctx.pushPreferences());
  assert.deepEqual(prefs, { lang: 'zh', quiet: { from: 23, to: 7 }, tz: 'Europe/Moscow' });

  ctx.setSetting('tz', 'device');
  prefs = plain(ctx.pushPreferences());
  assert.equal(prefs.tz, Intl.DateTimeFormat().resolvedOptions().timeZone);

  ctx.setSetting('quiet', 'off');
  assert.equal(plain(ctx.pushPreferences()).quiet, null, 'выключено — явный null, чтобы сервер снял окно');
});

test('смена пояса или тихих часов сообщается серверу, смена единиц и оформления — нет', () => {
  const { ctx, el } = page();
  ctx.initSettings();
  vm.runInContext("var syncs = 0; pushSync = function () { syncs++; return Promise.resolve('off'); };", ctx);
  const press = (name, value) => el('tab-settings').listeners.click({
    target: { closest: sel => (sel === '[data-value]' ? { getAttribute: () => value, closest: () => ({ getAttribute: () => name }) } : null) }
  });
  const syncs = () => vm.runInContext('syncs', ctx);

  press('temp', 'f'); press('dist', 'mi'); press('theme', 'light'); press('size', 'large'); press('clock', '12');
  assert.equal(syncs(), 0);
  press('quiet', '23-07');
  assert.equal(syncs(), 1);
  press('tz', 'device');
  assert.equal(syncs(), 2);
  el('prefs-reset').listeners.click();
  assert.equal(syncs(), 3);
});

test('разметка: значения кнопок совпадают с допустимыми, у каждой настройки есть подпись на трёх языках', () => {
  const html = read('index.html');
  const { ctx } = page();
  const choices = plain(ctx.SETTINGS_CHOICES);
  const groups = [...html.matchAll(/data-pref="(\w+)">([\s\S]*?)<\/div>/g)];
  assert.deepEqual(groups.map(g => g[1]).sort(), Object.keys(choices).sort());
  for (const [, name, body] of groups) {
    const values = [...body.matchAll(/data-value="([\w-]+)"/g)].map(m => m[1]);
    assert.deepEqual(values.sort(), [...choices[name]].sort(), name);
  }
  assert.ok(html.indexOf('id="quiet-card"') < html.indexOf('id="push-card"'), 'тихие часы — до уведомлений');
});

test('нажатие на тему и размер сразу меняет оформление страницы, а не только запись в хранилище', () => {
  const { ctx, el } = page();
  const { root, meta } = appearance(ctx);
  ctx.initSettings();
  const press = (name, value) => el('tab-settings').listeners.click({
    target: { closest: sel => (sel === '[data-value]' ? { getAttribute: () => value, closest: () => ({ getAttribute: () => name }) } : null) }
  });

  press('theme', 'light');
  assert.equal(root.attrs['data-theme'], 'light');
  assert.equal(meta.attrs.content, '#eef4f8');
  press('size', 'large');
  assert.equal(root.attrs['data-size'], 'large');
  el('prefs-reset').listeners.click();
  assert.deepEqual([root.attrs['data-theme'], root.attrs['data-size']], ['dark', 'normal'], 'сброс возвращает оформление');
});

/** Оттенок цвета #rrggbb в градусах (0 — красный). */
const hue = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return null;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};
const hex = rgb => '#' + rgb.map(n => Number(n).toString(16).padStart(2, '0')).join('');

test('ночное зрение: все цвета — красные (оттенок до 25°), красный преобладает; фон почти чёрный', () => {
  for (const [name, value] of Object.entries(nightVars)) {
    const colors = [...value.matchAll(/#[0-9a-f]{6}/gi)].map(m => m[0]);
    const triple = /^(\d+),\s*(\d+),\s*(\d+)$/.exec(value);
    if (triple) colors.push(hex(triple.slice(1)));
    for (const m of value.matchAll(/rgba\((\d+),\s*(\d+),\s*(\d+)/g)) colors.push(hex(m.slice(1)));
    for (const c of colors) {
      if (c === '#000000') continue;   // тень
      const h = hue(c);
      assert.ok(h !== null && (h <= 25 || h >= 355), `${name}: ${c}, оттенок ${h}`);
      const [r, g, b] = [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
      assert.ok(r >= g && r >= b, `${name}: ${c} — красный преобладает`);
    }
  }
  assert.ok(luminance(nightVars['--bg']) < 0.002, 'фон почти чёрный: экран не светит');
  assert.match(css, /html\[data-theme="night"\] \.aurora-bg \{ display: none; \}/);
  assert.match(css, /html\[data-theme="night"\] img,\s*html\[data-theme="night"\] \.share__qr \{ filter:/);
});

test('ночное зрение применяется до первой отрисовки, красит строку состояния и отмечает кнопку', () => {
  const head = /<script>([\s\S]*?)<\/script>/.exec(read('index.html'))[1];
  const root = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  vm.runInContext(head, vm.createContext({
    localStorage: { getItem: () => JSON.stringify({ theme: 'night' }) }, document: { documentElement: root }, matchMedia: () => ({ matches: false }), JSON
  }));
  assert.equal(root.attrs['data-theme'], 'night');
  const { ctx, el } = page();
  ctx.setSetting('theme', 'night');
  ctx.applyAppearance();
  assert.equal(el('night-btn').attrs['aria-pressed'], 'true');
  assert.equal(ctx.THEME_COLORS.night, '#070101');
  ctx.setSetting('theme', 'dark');
  ctx.applyAppearance();
  assert.equal(el('night-btn').attrs['aria-pressed'], 'false');
});

test('кнопка в шапке: включает ночное зрение и возвращает прежнюю тему, в том числе светлую', () => {
  const { ctx, el } = page();
  ctx.initSettings();
  ctx.setSetting('theme', 'light');
  el('night-btn').listeners.click();
  assert.equal(ctx.setting('theme'), 'night');
  el('night-btn').listeners.click();
  assert.equal(ctx.setting('theme'), 'light', 'вернулась светлая');
  // включили в настройках, а не кнопкой — выключение ведёт к теме по умолчанию
  const other = page();
  other.ctx.initSettings();
  other.ctx.setSetting('theme', 'night');
  other.el('night-btn').listeners.click();
  assert.equal(other.ctx.setting('theme'), 'dark');
});
