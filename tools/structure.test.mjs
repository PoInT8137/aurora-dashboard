// Код приложения разбит на js/*.js: все части подключены, в нужном порядке и лежат в оболочке офлайна.
// Запуск: node --test tools/structure.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { APP_PARTS } from './app-sandbox.mjs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const html = read('index.html');
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);

test('каждый файл из js/ подключён в index.html, и ничего лишнего', () => {
  const onDisk = fs.readdirSync(new URL('../js/', import.meta.url)).filter(f => f.endsWith('.js')).map(f => 'js/' + f).sort();
  assert.deepEqual([...APP_PARTS].sort(), onDisk);
});

test('порядок: ядро, карта, переводы, push — затем части приложения — и последним app.js', () => {
  const at = name => scripts.indexOf(name);
  for (const dep of ['config.js', 'core.js', 'map.js', 'i18n.js', 'lang/ru.js', 'push.js']) {
    assert.ok(at(dep) < at(APP_PARTS[0]), dep + ' раньше частей приложения');
  }
  assert.equal(scripts[scripts.length - 1], 'app.js');
  assert.deepEqual(scripts.filter(s => s.startsWith('js/')), [...APP_PARTS]);
  assert.equal(APP_PARTS[0], 'js/base.js', 'основа — первой: её переменные нужны остальным при загрузке');
});

test('у каждой части свой строгий режим и заголовок о назначении', () => {
  for (const part of [...APP_PARTS, 'app.js']) {
    const src = read(part);
    assert.match(src, /^\/\* [^\n]+/, part);
    assert.match(src.slice(0, 600), /\n'use strict';\n/, part);
  }
});

test('app.js — только точка входа: запуск и service worker', () => {
  const app = read('app.js');
  assert.ok(app.split('\n').length < 120, 'строк ' + app.split('\n').length);
  assert.match(app, /document\.addEventListener\('DOMContentLoaded', init\);/);
  assert.match(app, /function registerServiceWorker\(\)/);
});

test('все части в оболочке service worker — приложение открывается без сети', () => {
  const sw = read('sw.js');
  for (const part of [...APP_PARTS, 'app.js']) assert.ok(sw.includes(`'${part}'`), part);
});

test('все id в index.html уникальны: иначе getElementById молча берёт первый, а второй не работает', () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  const seen = new Set();
  const dup = ids.filter(id => (seen.has(id) ? true : (seen.add(id), false)));
  assert.deepEqual(dup, []);
  assert.ok(ids.length > 100, 'id найдены: ' + ids.length);
});
