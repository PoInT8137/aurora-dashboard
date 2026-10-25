// Телефон: цели касания не меньше 44 px там, где они были меньше (кнопки карты, «Куда ехать»,
// подписи точек на карте). Запуск: node --test tools/mobile.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

test('на телефоне кнопки карты и «Куда ехать» не ниже 44 px, подписи точек с областью нажатия 44 px', () => {
  const start = css.indexOf('/* ---------- Телефон: тач-цели не меньше 44px ---------- */');
  const block = css.slice(start, css.indexOf('\n}\n', start));
  assert.match(block, /@media \(max-width: 719px\)/);
  for (const sel of ['.window__where', '.map__pick', '#map-open', '.clouds__toggle', '.clouds__slider']) {
    assert.ok(block.includes(sel), sel);
  }
  assert.match(block, /min-height: 44px;/);
  // подпись 24 px + 10 px сверху и снизу = 44 px, сама подпись не двигается
  assert.match(block, /\.mappt::before \{ content: ""; position: absolute; inset: -10px -2px; \}/);
});
