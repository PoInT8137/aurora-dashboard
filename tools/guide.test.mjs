// Вкладка «Гид»: место среди вкладок, разделы на трёх языках, без советов по одежде.
// Запуск: node --test tools/guide.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { loadApp } from './app-sandbox.mjs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const html = read('index.html');

function dictionaries() {
  const ctx = vm.createContext({});
  vm.runInContext(read('i18n.js'), ctx);
  for (const code of ['ru', 'en', 'zh']) vm.runInContext(read(`lang/${code}.js`), ctx);
  return JSON.parse(vm.runInContext('JSON.stringify(i18nDicts)', ctx));
}
const dicts = dictionaries();

test('вкладки по порядку: «Сейчас», «Куда ехать», «Карта», «Гид», «Настройки» — в разметке и в коде', () => {
  const order = [...html.matchAll(/role="tab" id="tab-btn-(\w+)" data-tab="(\w+)"/g)].map(m => m[2]);
  assert.deepEqual(order, ['now', 'tonight', 'map', 'guide', 'settings']);
  const ctx = loadApp([['config.js', read('config.js')], ['core.js', read('core.js')], ['push.js', read('push.js')], ['app.js', read('app.js')]], {});
  assert.deepEqual(Array.from(ctx.TAB_IDS), order, 'стрелки на клавиатуре идут в том же порядке, что кнопки');
  ctx.showTab('guide', 'replace');
  assert.equal(ctx.state.tab, 'guide');
});

test('панель гида связана с кнопкой и скрыта до выбора', () => {
  assert.match(html, /<section class="wrap" id="tab-guide" role="tabpanel" aria-labelledby="tab-btn-guide" tabindex="0" hidden>/);
  assert.match(html, /id="tab-btn-guide" data-tab="guide"\s+aria-controls="tab-guide"/);
});

test('все пять разделов на месте, у каждого пункта заголовок и текст на трёх языках', () => {
  const panel = html.slice(html.indexOf('id="tab-guide"'), html.indexOf('id="tab-settings"'));
  const sections = [...panel.matchAll(/id="guide-(\w+)"/g)].map(m => m[1]);
  assert.deepEqual(sections, ['expect', 'read', 'phone', 'camera', 'safety']);
  const keys = [...panel.matchAll(/data-i18n="(guide\.[\w.]+)"/g)].map(m => m[1]);
  assert.ok(keys.length >= 45, 'пунктов: ' + keys.length);
  for (const key of keys) {
    for (const code of ['ru', 'en', 'zh']) assert.ok(dicts[code][key], `${code}: ${key}`);
  }
  // русский текст в разметке совпадает со словарём — страница без скриптов покажет то же самое
  for (const m of panel.matchAll(/data-i18n="(guide\.[\w.]+)">([^<]+)</g)) assert.equal(m[2], dicts.ru[m[1]], m[1]);
});

test('в гиде нет советов по одежде — по просьбе владельца сайта', () => {
  const guide = ['ru', 'en', 'zh'].flatMap(code =>
    Object.entries(dicts[code]).filter(([k]) => k.startsWith('guide.')).map(([, v]) => v)).join('\n');
  assert.doesNotMatch(guide, /одежд|оденьт|одевайт|термобель|варежк|перчат|шапк|куртк|clothing|dress warm|gloves|jacket|layers|thermal|穿|衣服|手套|帽子/i);
});
