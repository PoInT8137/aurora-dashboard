// Эталонные ночи: реальные случаи, где уже известно, каким должен быть ответ сайта и сервера
// (общая функция quickLevel из core.js). Если правка расчёта ломает такой ответ, тест падает.
// Новые случаи добавляются в tools/golden-nights.json вместе с источником данных.
// Запуск: node --test tools/golden.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import '../core.js';

const Core = globalThis.AuroraCore;
const nights = JSON.parse(fs.readFileSync(new URL('./golden-nights.json', import.meta.url), 'utf8'));
const RANK = { low: 0, mid: 1, high: 2 };

for (const n of nights) {
  test('эталон: ' + n.name, () => {
    const point = Core.POINTS.find(p => p.id === n.point);
    assert.ok(point, n.point);
    const q = Core.quickLevel(n.activity, { value: n.cloud, conflict: false }, point, new Date(n.at), n.seen || 0);
    if (n.expect.level) assert.equal(q.level, n.expect.level);
    if (n.expect.levelAtLeast) assert.ok(RANK[q.level] >= RANK[n.expect.levelAtLeast], 'уровень ' + q.level);
    if (n.expect.ks !== undefined) assert.equal(q.ks, n.expect.ks);
    if (n.expect.by) assert.equal(q.by, n.expect.by);
  });
}

test('у каждого эталона указан источник данных', () => {
  for (const n of nights) assert.ok(n.source && n.source.length > 10, n.name);
});
