// Главная карточка: три шкалы (активность, небо, темнота) и уровень для оформления фона.
// Запуск: node --test tools/hero.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadApp } from './app-sandbox.mjs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const element = () => ({ textContent: '', className: '', children: [], attrs: {}, style: { setProperty() {} },
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, querySelector: () => null,
  setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); return c; },
  set innerHTML(v) { this.children = []; }, get innerHTML() { return ''; } });

function page() {
  const elements = new Map();
  const el = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const ctx = loadApp([['config.js', read('config.js')], ['core.js', read('core.js')], ['push.js', read('push.js')], ['app.js', read('app.js')]],
    { now: Date.parse('2026-12-15T18:00:00Z'), getElement: el, createElement: () => element() });
  return { ctx, el };
}

test('темнота баллом: день 0, сумерки 1, неполная темнота 2, ночь 3 — пороги как у вердикта', () => {
  const { ctx } = page();
  assert.deepEqual([5, -3, -8, -20].map(ctx.darkScore), [0, 1, 2, 3]);
  assert.equal(ctx.darkScore(ctx.DARK_USABLE), 2);
  assert.equal(ctx.darkScore(ctx.DARK_FULL), 3);
});

test('шкалы: по три деления, включено столько, сколько баллов; нет данных — ни одного, подпись словами', () => {
  const { ctx, el } = page();
  ctx.renderVerdictMeters({ kp: 2, sky: null, dark: 3 });
  const rows = el('verdict-meters').children;
  assert.equal(rows.length, 3);
  const on = row => row.children[1].children.filter(p => p.className.includes('--on')).length;
  assert.deepEqual(rows.map(on), [2, 0, 3]);
  assert.deepEqual(rows.map(r => r.className), ['meter meter--2', 'meter meter--none', 'meter meter--3']);
  assert.deepEqual(rows.map(r => r.children[0].textContent), ['Активность', 'Небо', 'Темнота']);
  assert.deepEqual(rows.map(r => r.children[2].textContent), ['2 из 3', 'нет данных', '3 из 3']);
  assert.equal(rows[0].children[1].attrs['aria-hidden'], 'true', 'деления — только для глаз');
});

test('вердикт отдаёт шкалы; карточка получает уровень для фона', () => {
  const { ctx, el } = page();
  ctx.state.kp = { value: 6, stale: 0 };
  ctx.state.cloud = { value: 10, conflict: false, stale: 0 };
  const v = ctx.computeVerdict(ctx.state.kp, ctx.state.cloud);
  assert.equal(v.meters.kp, 3);
  assert.equal(v.meters.sky, 3);
  assert.ok(v.meters.dark >= 0 && v.meters.dark <= 3);
  ctx.renderVerdict();
  assert.equal(el('verdict-card').attrs['data-level'], v.level);
});

test('небо за страницей: балл Kp 0 — спокойно, 1–2 — активно, 3 — буря; без данных — без изменений', () => {
  const { ctx } = page();
  assert.deepEqual([0, 1, 2, 3, null].map(ctx.skyMood), ['calm', 'active', 'active', 'storm', null]);
  const css = read('styles.css');
  const bg = /\n\.aurora-bg \{[^}]*\}/.exec(css)[0];
  assert.doesNotMatch(bg, /filter:/, 'размытие большого движущегося слоя — лишняя работа каждый кадр');
  assert.match(css, /html\[data-sky="active"\] \.aurora-bg \{/);
  assert.match(css, /html\[data-sky="storm"\] \.aurora-bg \{/);
  assert.match(read('index.html'), /<div class="sky-stars" aria-hidden="true"><\/div>/);
});

test('загрузка — заготовка: текст прозрачный (для скринридера), плашки пульсируют, без движения при «уменьшить движение»', () => {
  const css = read('styles.css');
  const loading = /\.card\[data-state="loading"\] \.card__loading \{[^}]*\}/.exec(css)[0];
  assert.match(loading, /color: transparent;/);
  assert.match(css, /\.card\[data-state="loading"\] \.card__loading::before \{[^}]*height: 42px;/);
  assert.match(css, /@keyframes skeleton-pulse/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.card\[data-state="loading"\] \.card__loading::before,\s*\.card\[data-state="loading"\] \.card__loading::after \{ animation: none; \}/);
});

test('стили: фон по уровню без размытия, анимация высокого уровня отключается при «уменьшить движение»', () => {
  const css = read('styles.css');
  for (const level of ['low', 'mid', 'high']) assert.match(css, new RegExp(`#verdict-card\\[data-level="${level}"\\]::before \\{`));
  const hero = css.slice(css.indexOf('#verdict-card { isolation'), css.indexOf('.verdict__hint {'));
  assert.doesNotMatch(hero, /filter:/);
  assert.match(hero, /prefers-reduced-motion: reduce\) \{\s*#verdict-card\[data-level="high"\]::before \{ animation: none; \}/);
});
