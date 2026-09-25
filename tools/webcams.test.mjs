// «Небо на веб-камерах»: список от ближней к дальней, только https, ссылки открываются отдельно,
// подписи на языке страницы, расстояния в выбранных единицах. Запуск: node --test tools/webcams.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadApp } from './app-sandbox.mjs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const element = () => ({ textContent: '', className: '', href: '', target: '', rel: '', children: [], attrs: {},
  setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); return c; },
  set innerHTML(v) { this.children = []; }, get innerHTML() { return ''; } });

function page() {
  const elements = new Map();
  const el = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const ctx = loadApp([['config.js', read('config.js')], ['core.js', read('core.js')], ['push.js', read('push.js')], ['app.js', read('app.js')]],
    { now: Date.parse('2026-09-26T00:00:00Z'), getElement: el, createElement: () => element() });
  return { ctx, el };
}

test('камеры — от ближней к дальней, первая — Териберка; все адреса https', () => {
  const { ctx } = page();
  const list = ctx.webcamList();
  assert.deepEqual([...list.map(i => i.cam.id)],['teriberka', 'sodankyla', 'skibotn', 'kiruna', 'abisko']);
  assert.equal(list[0].km, 84);
  for (const i of list) assert.ok(i.cam.url.startsWith('https://'), i.cam.url);
  for (const i of list) for (const l of ['ru', 'en', 'zh']) assert.ok(i.cam.names[l], i.cam.id + ' ' + l);
});

test('ссылки открываются в новой вкладке без доступа к нашей странице; подпись — вид, место, расстояние, владелец', () => {
  const { ctx, el } = page();
  ctx.renderWebcams();
  const items = el('webcams-list').children;
  assert.equal(items.length, 5);
  const [link, meta] = items[0].children;
  assert.equal(link.textContent, 'Териберка');
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(meta.textContent, 'прямая трансляция · Мурманская обл. · 84 км от Мурманска · auroracam.ru');
  ctx.setLang('en');
  ctx.setSetting('dist', 'mi');
  ctx.renderWebcams();
  assert.equal(el('webcams-list').children[1].children[0].textContent, 'Sodankylä');
  assert.match(el('webcams-list').children[1].children[1].textContent, /^all-sky camera · Finland · \d+ miles from Murmansk · SGO$/);
});

test('разметка: карточка на «Сейчас» после «Очевидцев», файл в оболочке service worker', () => {
  const html = read('index.html');
  const now = html.slice(html.indexOf('id="tab-now"'), html.indexOf('id="tab-tonight"'));
  assert.ok(now.indexOf('id="webcams-card"') > now.indexOf('id="reports-card"'));
  assert.match(read('sw.js'), /'js\/webcams\.js'/);
});
