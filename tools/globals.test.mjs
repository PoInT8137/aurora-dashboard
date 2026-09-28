// Скрипты страницы подключаются обычными <script> и делят глобальные имена: одноимённая функция
// в другом файле молча подменяет первую (так однажды num() из share.js сломала разбор погоды).
// Запуск: node --test tools/globals.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');

test('функции и переменные верхнего уровня не повторяются в разных скриптах страницы', () => {
  const html = read('index.html');
  const files = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
  assert.ok(files.length > 10);
  const seen = new Map();
  const clashes = [];
  for (const file of files) {
    for (const [, name] of read(file).matchAll(/^(?:function|var|let|const)\s+([A-Za-z_$][\w$]*)/gm)) {
      if (seen.has(name) && seen.get(name) !== file) clashes.push(name + ': ' + seen.get(name) + ' и ' + file);
      else seen.set(name, file);
    }
  }
  assert.deepEqual(clashes, []);
});
