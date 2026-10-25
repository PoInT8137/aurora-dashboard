// Бюджет скорости: сколько весит и из скольких файлов состоит первый заход на сайт (страница,
// стили и скрипты из index.html, сжатые gzip, как их отдаёт хостинг). Если правка делает сайт
// тяжелее бюджета, тест падает: скорость не должна ухудшаться незаметно.
// Бюджет затягивается, когда сайт становится легче. Запуск: node --test tools/budget.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { firstLoadFiles } from './first-load.mjs';

const BUDGET = { gzipKb: 215, files: 28 };   // 26.10.2026: 205 КБ, 27 файлов (словари по требованию)

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url));

test('первый заход укладывается в бюджет: размер в gzip и число файлов', () => {
  const files = firstLoadFiles();
  const sizes = files.map(f => ({ f, gz: zlib.gzipSync(read(f), { level: 9 }).length }));
  const total = sizes.reduce((s, x) => s + x.gz, 0) / 1024;
  const top = sizes.sort((a, b) => b.gz - a.gz).slice(0, 5).map(x => x.f + ' ' + Math.round(x.gz / 1024) + ' КБ').join(', ');
  assert.ok(total <= BUDGET.gzipKb, `первый заход ${total.toFixed(1)} КБ больше бюджета ${BUDGET.gzipKb} КБ; самые тяжёлые: ${top}`);
  assert.ok(files.length <= BUDGET.files, `файлов ${files.length}, бюджет ${BUDGET.files}`);
});

test('в разметке нет внешних скриптов и стилей: всё с нашего сайта, без лишних соединений', () => {
  for (const f of firstLoadFiles()) assert.doesNotMatch(f, /^(https?:)?\/\//, f);
});
