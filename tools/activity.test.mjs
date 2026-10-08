// Активность в вердикте — не только Kp: Kp за час, Hp30, OVATION, южный Bz; отметки очевидцев;
// честная подсказка при облаках. Запуск: node --test tools/activity.test.mjs
//
// Повод: 8.10.2026 вечером в Мурманске было яркое сияние, а сайт писал «низкий»: оценочный Kp
// 0,67 — ниже порога 1,0, балл активности 0, и при умножении на облачность — «низкий» всегда.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadApp } from './app-sandbox.mjs';
import '../core.js';

const Core = globalThis.AuroraCore;
const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const murmansk = Core.POINTS.find(p => p.id === 'murmansk');
const kandalaksha = Core.POINTS.find(p => p.id === 'kandalaksha');
const NIGHT = Date.parse('2026-10-08T19:00:00Z');   // 22:00 МСК, темно

test('Kp чуть ниже порога (до 0,5) — уже «возможно»: у овала слабое сияние видно на севере', () => {
  assert.equal(Core.kpActivityScore(0.67, murmansk), 1, '8.10.2026: Kp 0,67 при пороге 1,0');
  assert.equal(Core.kpActivityScore(0.4, murmansk), 0);
  assert.equal(Core.kpActivityScore(2.2, murmansk), 2, 'выше порога — как раньше');
  // у южных точек порог свой, и «рядом» отсчитывается от него
  const low = Core.kpThresholds(kandalaksha).low;
  assert.equal(Core.kpActivityScore(low - 0.6, kandalaksha), 0);
  assert.equal(Core.kpActivityScore(low - 0.4, kandalaksha), 1);
});

test('балл активности — лучший из признаков, и видно, по какому', () => {
  assert.equal(Core.activityScore({}, murmansk), null, 'ничего не известно');
  assert.deepEqual({ ...Core.activityScore({ kp: 0.3 }, murmansk) }, { score: 0, by: 'kp' });
  assert.deepEqual({ ...Core.activityScore({ kp: 0.3, kpHour: 2.1 }, murmansk) }, { score: 2, by: 'kp' }, 'максимум за час');
  assert.deepEqual({ ...Core.activityScore({ kp: 0.7, hp30: 3.3 }, murmansk) }, { score: 3, by: 'hp30' });
  assert.deepEqual({ ...Core.activityScore({ kp: 0.7, ovation: 35 }, murmansk) }, { score: 2, by: 'ovation' });
  assert.deepEqual({ ...Core.activityScore({ kp: 0.7, ovation: 55 }, murmansk) }, { score: 3, by: 'ovation' });
  assert.deepEqual({ ...Core.activityScore({ kp: 0.7, bz: 'loading' }, murmansk) }, { score: 2, by: 'bz' });
  assert.deepEqual({ ...Core.activityScore({ kp: 0.7, bz: 'strong' }, murmansk) }, { score: 3, by: 'bz' });
  assert.deepEqual({ ...Core.activityScore({ kp: 2.5, ovation: 35 }, murmansk) }, { score: 2, by: 'kp' }, 'при равенстве — Kp');
  assert.deepEqual({ ...Core.activityScore({ ovation: 22 }, murmansk) }, { score: 1, by: 'ovation' }, 'без Kp — по остальным');
});

test('Bz «копит энергию»: в среднем за час южнее −2 нТл — суббуря вероятна', () => {
  assert.equal(Core.bzActivity(null), null);
  assert.equal(Core.bzActivity({ level: 'south', mean60: -1 }), 'south');
  assert.equal(Core.bzActivity({ level: 'weak', mean60: -2.4 }), 'loading');
  assert.equal(Core.bzActivity({ level: 'weak', mean60: -1.5 }), null);
  assert.equal(Core.bzActivity({ level: 'north', mean60: null }), null);
});

test('сводка ветра считает средний Bz за час', () => {
  const now = NIGHT;
  const rows = [];
  for (let m = 0; m < 120; m++) rows.push({ time_tag: new Date(now - m * 60000).toISOString().slice(0, 19), active: true, source: 'S', bz_gsm: m < 60 ? -3 : 4, bt: 5 });
  const sw = Core.solarWindSummary(rows, now);
  assert.equal(sw.mean60, -3);
  assert.equal(Core.bzActivity(sw), 'loading');
});

test('Kp из поминутного ряда: текущее и максимум за последний час', () => {
  const t0 = Date.parse('2026-10-08T18:00:00Z');
  const rows = [];
  for (let m = 90; m >= 0; m--) rows.push({ time_tag: new Date(t0 - m * 60000).toISOString().slice(0, 19), estimated_kp: m === 30 ? 2.67 : (m === 80 ? 4 : 0.67) });
  const kp = Core.readKpSeries(rows);
  assert.equal(kp.value, 0.67);
  assert.equal(kp.hourMax, 2.67, 'всплеск 30 минут назад — в счёт, 80 минут назад — нет');
});

test('Hp30: максимум двух последних получасов, если данные свежие', () => {
  const rows = [['2026-10-07T17:00:00Z', 1.667], ['2026-10-07T17:30:00Z', 4], ['2026-10-07T18:00:00Z', 4], ['2026-10-07T18:30:00Z', 3]];
  assert.equal(Core.hp30Recent(rows, Date.parse('2026-10-07T19:00:00Z')), 4);
  assert.equal(Core.hp30Recent(rows, Date.parse('2026-10-07T21:00:00Z')), null, 'старше 90 минут');
  assert.equal(Core.hp30Recent([], Date.now()), null);
  assert.equal(Core.hp30Recent({ error: 1 }, Date.now()), null);
});

test('отметки очевидцев в темноте — шанс не ниже среднего; днём — нет', () => {
  assert.equal(Core.verdictLevel(0, 0, -20, 0), 'low');
  assert.equal(Core.verdictLevel(0, 0, -20, 2), 'mid', 'видят своими глазами — облака могли разойтись');
  assert.equal(Core.verdictLevel(3, 3, -20, 1), 'high', 'выше не опускаем');
  assert.equal(Core.verdictLevel(3, 3, 5, 3), 'low', 'днём сияния не видно, какие бы ни были отметки');
});

test('сервер: quickLevel принимает признаки активности и отметки, число Kp — как раньше', () => {
  const date = new Date(NIGHT);
  const cloud = { value: 47, conflict: false };
  assert.equal(Core.quickLevel(0.67, cloud, murmansk, date).level, 'mid', 'Kp рядом с порогом × облачность 47%');
  assert.equal(Core.quickLevel({ kp: 0.3 }, cloud, murmansk, date).level, 'low');
  const q = Core.quickLevel({ kp: 0.3, hp30: 3.3 }, { value: 10, conflict: false }, murmansk, date);
  assert.deepEqual([q.level, q.ks, q.by], ['high', 3, 'hp30']);
  assert.equal(Core.quickLevel({ kp: 0.3 }, { value: 95, conflict: false }, murmansk, date, 1).level, 'mid');
});

function page() {
  const elements = new Map();
  const element = () => ({ textContent: '', className: '', children: [], attrs: {}, style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, querySelector: () => null,
    setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); return c; },
    set innerHTML(v) { this.children = []; }, get innerHTML() { return ''; } });
  const el = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const ctx = loadApp([['config.js', read('config.js')], ['core.js', read('core.js')], ['push.js', read('push.js')], ['app.js', read('app.js')]],
    { now: NIGHT, getElement: el, createElement: () => element() });
  return { ctx, el };
}
const verdict = (ctx, kp, cloud) => ctx.computeVerdict({ value: kp, hourMax: kp, stale: null }, { value: cloud, conflict: false, stale: null });

test('сайт, 8.10.2026: Kp 0,67, облачность 47%, OVATION 22% — «средний», а не «низкий»', () => {
  const { ctx } = page();
  ctx.state.ov = { stale: null, points: { murmansk: { overhead: 22, view: 22 } } };
  const v = verdict(ctx, 0.67, 47);
  assert.equal(v.level, 'mid');
  assert.equal(v.meters.kp, 1);
});

test('сайт: активность поднята не по Kp — в условиях видно, по какому признаку', () => {
  const { ctx } = page();
  ctx.state.hp30 = { value: 3.33 };
  const v = verdict(ctx, 0.67, 20);
  assert.equal(v.meters.kp, 3);
  assert.equal(v.level, 'high');
  assert.ok(v.factors.includes('Hp30 3,3'), v.factors.join(' | '));

  const o = page();
  o.ctx.state.ov = { stale: null, points: { murmansk: { overhead: 40, view: 40 } } };
  assert.ok(verdict(o.ctx, 0.67, 20).factors.includes('OVATION 40%'));
  o.ctx.state.ov.stale = 2 * 3600 * 1000;   // сохранённый два часа назад — не в счёт
  assert.equal(verdict(o.ctx, 0.67, 20).meters.kp, 1);
});

test('сайт: Kp за час заметно выше текущего — в условиях оба числа', () => {
  const { ctx } = page();
  const v = ctx.computeVerdict({ value: 0.67, hourMax: 2, stale: null }, { value: 24, conflict: false, stale: null });
  assert.equal(v.meters.kp, 2);
  assert.equal(v.factors[0], 'Kp 0,7, за час до 2,0');
  assert.equal(verdict(ctx, 0.67, 24).factors[0], 'Kp 0,7', 'максимум не выше — одно число');
});

test('сайт: облачно, но активность есть — подсказка про просветы, а не «не будет видно»', () => {
  const { ctx } = page();
  ctx.state.hp30 = { value: 2.3 };
  const v = verdict(ctx, 0.67, 95);
  assert.equal(v.level, 'low');
  assert.match(v.hint, /^Активность есть, но модель показывает сплошные облака/);
  const calm = verdict(page().ctx, 0.3, 95);
  assert.match(calm.hint, /^Небо затянуто облаками/);
});

test('сайт: очевидцы рядом за последний час — «средний» даже при облаках, подсказка первой', () => {
  const { ctx } = page();
  ctx.state.reports = { error: false, data: { points: { murmansk: { count: 3, bright: 1 } } } };
  const v = verdict(ctx, 0.3, 95);
  assert.equal(v.level, 'mid');
  assert.match(v.hint, /^Очевидцы видят сияние прямо сейчас: 3 отметки рядом за последний час — выходите смотреть\./);
  ctx.state.reports.error = true;
  assert.equal(verdict(ctx, 0.3, 95).level, 'low', 'сводка не загрузилась — не выдумываем');
});

test('Hp30 — через сервер, тексты новых признаков на трёх языках, пороги OVATION общие с карточкой', () => {
  assert.match(read('js/now.js'), /AURORA_CONFIG\.pushApi \+ '\/noaa\/hp30'/);
  for (const lang of ['ru', 'en', 'zh']) {
    const dict = read('lang/' + lang + '.js');
    for (const key of ['verdict.f.hp30', 'verdict.f.ovation', 'verdict.f.bz', 'verdict.hint.cloudy_active', 'verdict.hint.seen']) {
      assert.ok(dict.includes(`'${key}'`), lang + ' ' + key);
    }
  }
  assert.match(read('js/now.js'), /view >= OVATION_ACTIVITY\[1\]/);
});
