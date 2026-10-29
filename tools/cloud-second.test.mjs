// Второе мнение об облаках (MET Norway): сравнение с основной моделью и подпись в вердикте.
// Запуск: node --test tools/cloud-second.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadApp } from './app-sandbox.mjs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const NOW = Date.parse('2026-12-15T22:10:00Z');
const HOUR = 3600;

function app() {
  return loadApp([['config.js', read('config.js')], ['core.js', read('core.js')], ['push.js', read('push.js')], ['app.js', read('app.js')]],
    { now: NOW, fetch: () => Promise.reject(new TypeError('x')) });
}

const at = Date.parse('2026-12-15T22:00:00Z');
const cloud = (over = {}) => ({ value: 80, total: 85, pointId: 'murmansk', model: null, time: new Date(at), ...over });
const second = (value, over = {}) => ({ pointId: 'murmansk', at: NOW, model: 'MET Norway',
  hours: [[at / 1000 - HOUR, 0], [at / 1000, value], [at / 1000 + HOUR, 0]], ...over });

test('модели расходятся на 40 п.п. и больше: сравнивается общая облачность того же часа', () => {
  const ctx = app();
  const far = ctx.cloudSecondOpinion(cloud(), second(20));
  assert.deepEqual(JSON.parse(JSON.stringify(far)), { other: 20, main: 85, model: 'MET Norway', disagree: true });
  assert.equal(ctx.cloudSecondOpinion(cloud(), second(60)).disagree, false);
});

test('нет второго мнения: другая точка, нет нужного часа, основная модель сама MET Norway', () => {
  const ctx = app();
  assert.equal(ctx.cloudSecondOpinion(cloud(), second(20, { pointId: 'teriberka' })), null);
  assert.equal(ctx.cloudSecondOpinion(cloud(), second(20, { hours: [[at / 1000 + 5 * HOUR, 20]] })), null);
  assert.equal(ctx.cloudSecondOpinion(cloud({ model: 'MET Norway' }), second(20)), null);
  assert.equal(ctx.cloudSecondOpinion(cloud(), null), null);
});

test('расхождение попадает в «Подробнее» вердикта, уровень от него не меняется', () => {
  const ctx = app();
  ctx.state.point = ctx.findPoint('murmansk');
  ctx.state.kp = { value: 3, time: new Date(NOW), stale: null };
  const base = ctx.computeVerdict(ctx.state.kp, cloud());
  ctx.state.cloud2 = second(10);
  const v = ctx.computeVerdict(ctx.state.kp, cloud());
  assert.equal(v.level, base.level);
  assert.ok(v.factors.some(f => /MET Norway/.test(f) && /10%/.test(f)), v.factors.join(' | '));
});

test('тексты второго мнения есть на трёх языках', () => {
  for (const lang of ['ru', 'en', 'zh']) {
    const src = read('lang/' + lang + '.js');
    for (const key of ['cloud.second.agree', 'cloud.second.disagree', 'verdict.f.models']) assert.match(src, new RegExp("'" + key.replace(/\./g, '\.') + "': "), lang + ' ' + key);
  }
});
