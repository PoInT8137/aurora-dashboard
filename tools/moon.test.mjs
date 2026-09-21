// Луна: фаза, освещённость, высота, восход и заход — против эталона Морской
// обсерватории США (tools/fixtures/usno-moon-2026.json).
//
// Допуски выбраны с запасом над измеренным расхождением, а не подогнаны под него:
// фазы — 10 минут (получилось до 3), восходы и заходы — 5 минут (получилось до 1),
// освещённость — 2 процентных пункта.
//
// Запуск: node --test tools/moon.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

await import('../core.js');
const C = globalThis.AuroraCore;
const ref = JSON.parse(fs.readFileSync(new URL('./fixtures/usno-moon-2026.json', import.meta.url), 'utf8'));
const place = id => ref.places.find(p => p.id === id);

const TARGET = { 'New Moon': 0, 'First Quarter': 90, 'Full Moon': 180, 'Last Quarter': 270 };
const signed = (e, target) => ((e - target + 540) % 360) - 180;

/** Момент, когда элонгация достигает целевого значения, ищется делением пополам около опорного времени. */
function phaseTime(target, aroundMs) {
  let lo = aroundMs - 30 * 36e5, hi = aroundMs + 30 * 36e5;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (signed(C.moonPhase(new Date(mid)).elongation, target) < 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

test('эталон загружен и полон', () => {
  assert.equal(ref.phases.length, 50);
  assert.ok(ref.days.length >= 15);
  assert.ok(ref.days.some(d => d.alwaysUp), 'есть сутки, когда Луна не заходит');
  assert.ok(ref.days.some(d => d.alwaysDown), 'есть сутки, когда Луна не восходит');
});

test('моменты 50 фаз Луны за 2026 год совпадают с эталоном в пределах 10 минут', () => {
  let worst = 0;
  for (const p of ref.phases) {
    const usno = Date.parse(p.at);
    const mine = phaseTime(TARGET[p.phase], usno);
    const diffMin = Math.abs(mine - usno) / 60000;
    worst = Math.max(worst, diffMin);
    assert.ok(diffMin < 10, `${p.phase} ${p.at}: расхождение ${diffMin.toFixed(1)} мин`);
  }
  console.log(`  наибольшее расхождение по 50 фазам: ${worst.toFixed(1)} мин`);
});

test('восходы и заходы Луны для Мурманска и Кандалакши: до 5 минут, включая полярные сутки', () => {
  let worst = 0, compared = 0;
  for (const day of ref.days) {
    const p = place(day.place);
    const [y, m, d] = day.date.split('-').map(Number);
    const events = C.moonEvents(new Date(Date.UTC(y, m - 1, d)), new Date(Date.UTC(y, m - 1, d + 1)), p.lat, p.lon);

    // у USNO сутки заканчиваются в 23:59, поэтому событие ровно в полночь может не попасть — берём только внутренние
    const expected = day.events.map(e => ({ type: e.type, at: Date.UTC(y, m - 1, d, +e.time.slice(0, 2), +e.time.slice(3)) }));

    if (day.alwaysUp || day.alwaysDown) {
      assert.equal(events.length, 0, `${day.place} ${day.date}: Луна ${day.alwaysUp ? 'не заходит' : 'не восходит'}, событий быть не должно`);
      const noon = C.moonInfo(new Date(Date.UTC(y, m - 1, d, 12)), p.lat, p.lon);
      assert.equal(noon.up, day.alwaysUp, `${day.place} ${day.date}: состояние в полдень`);
      continue;
    }

    for (const exp of expected) {
      const near = events.filter(e => e.type === exp.type)
        .sort((a, b) => Math.abs(a.at - exp.at) - Math.abs(b.at - exp.at))[0];
      assert.ok(near, `${day.place} ${day.date}: нет события ${exp.type}`);
      const diffMin = Math.abs(near.at - exp.at) / 60000;
      worst = Math.max(worst, diffMin);
      compared++;
      assert.ok(diffMin < 5, `${day.place} ${day.date} ${exp.type}: расхождение ${diffMin.toFixed(1)} мин`);
    }
    assert.equal(events.length, expected.length, `${day.place} ${day.date}: число событий (${events.map(e => e.type).join(',')} против ${expected.map(e => e.type).join(',')})`);
  }
  console.log(`  сравнено событий: ${compared}, наибольшее расхождение: ${worst.toFixed(1)} мин`);
});

test('освещённость диска в полдень: до 2 процентных пунктов', () => {
  for (const day of ref.days) {
    const p = place(day.place);
    const [y, m, d] = day.date.split('-').map(Number);
    const k = C.moonPhase(new Date(Date.UTC(y, m - 1, d, 12))).illumination;
    // USNO даёт освещённость на полдень по UTC с округлением до процента
    assert.ok(Math.abs(k - day.illumination) <= 0.02, `${day.date}: ${k.toFixed(3)} против ${day.illumination}`);
  }
});

test('освещённость и растущая/убывающая Луна согласованы с фазой в моменты, взятые из эталона', () => {
  const at = name => ref.phases.filter(p => p.phase === name).map(p => C.moonPhase(new Date(p.at)));

  for (const f of at('Full Moon')) assert.ok(f.illumination > 0.995, 'полнолуние: ' + f.illumination);
  for (const n of at('New Moon')) assert.ok(n.illumination < 0.005, 'новолуние: ' + n.illumination);
  for (const q of at('First Quarter')) {
    assert.ok(Math.abs(q.illumination - 0.5) < 0.02, 'первая четверть: ' + q.illumination);
    assert.equal(q.waxing, true);
  }
  for (const q of at('Last Quarter')) {
    assert.ok(Math.abs(q.illumination - 0.5) < 0.02, 'последняя четверть: ' + q.illumination);
    assert.equal(q.waxing, false);
  }
});

test('ключи фаз: восемь состояний по кругу элонгации', () => {
  const name = e => C.moonPhaseName({ elongation: e });
  assert.equal(name(0), 'new');
  assert.equal(name(359), 'new');
  assert.equal(name(45), 'waxing_crescent');
  assert.equal(name(90), 'first_quarter');
  assert.equal(name(135), 'waxing_gibbous');
  assert.equal(name(180), 'full');
  assert.equal(name(225), 'waning_gibbous');
  assert.equal(name(270), 'last_quarter');
  assert.equal(name(315), 'waning_crescent');
  // границы: 22,5° — уже waxing_crescent
  assert.equal(name(22.4), 'new');
  assert.equal(name(22.5), 'waxing_crescent');
  assert.equal(name(337.4), 'waning_crescent');
  assert.equal(name(337.5), 'new');
});

test('расчёт не портит переданную дату и не зависит от часового пояса машины', () => {
  const d = new Date('2026-09-26T16:49:00Z');
  const before = d.getTime();
  const a = C.moonInfo(d, 68.9678, 33.0992);
  assert.equal(d.getTime(), before);
  assert.deepEqual(C.moonInfo(new Date(before), 68.9678, 33.0992), a);
});

test('помеха от Луны: ниже горизонта нет, низкая и тонкая слабая, яркая и высокая сильная', () => {
  const impact = (k, alt) => C.moonImpact(k, alt).level;
  assert.equal(impact(1, -5), 'none', 'ниже горизонта');
  assert.equal(impact(1, C.MOON_HORIZON), 'none', 'ровно на горизонте');
  assert.equal(impact(0.05, 60), 'none', 'тонкий серп высоко');
  assert.equal(impact(1, 3), 'weak', 'полная Луна у горизонта светит мало');
  assert.equal(impact(0.5, 60), 'moderate');
  assert.equal(impact(1, 60), 'strong');
  assert.equal(impact(1, 25), 'strong');
  assert.ok(C.moonImpact(1, 60).effective > C.moonImpact(0.5, 60).effective, 'ярче — сильнее');
  assert.ok(C.moonImpact(1, 40).effective > C.moonImpact(1, 8).effective, 'выше — сильнее');
  assert.ok(C.moonImpact(1, 90).effective <= 1, 'не больше единицы');
});

test('пороги помехи проверены на границах, а не только на крайних значениях', () => {
  // Высота 90° даёт полный вклад высоты, поэтому effective равен освещённости.
  const at = k => C.moonImpact(k, 90).level;
  assert.equal(at(0.099), 'none');
  assert.equal(at(0.1), 'weak');
  assert.equal(at(0.299), 'weak');
  assert.equal(at(0.3), 'moderate');
  assert.equal(at(0.549), 'moderate');
  assert.equal(at(0.55), 'strong');

  // Вклад высоты нарастает линейно до 25° над горизонтом Луны.
  const half = C.moonImpact(1, C.MOON_HORIZON + 12.5).effective;
  assert.ok(Math.abs(half - 0.5) < 1e-9, 'на половине пути — половина вклада: ' + half);
  assert.equal(C.moonImpact(1, C.MOON_HORIZON + 25).effective, 1);
  assert.equal(C.moonImpact(1, C.MOON_HORIZON + 80).effective, 1);
});

test('очень короткое появление Луны над горизонтом не теряется (17, 57, 74 минуты)', () => {
  const p = place('murmansk');
  for (const [date, minutes] of [['2026-06-05', 17], ['2026-03-15', 57], ['2026-12-06', 74]]) {
    const [y, m, d] = date.split('-').map(Number);
    let up = 0;
    for (let t = Date.UTC(y, m - 1, d); t < Date.UTC(y, m - 1, d + 1); t += 60000) {
      if (C.moonAltitude(new Date(t), p.lat, p.lon) > C.MOON_HORIZON) up++;
    }
    assert.ok(Math.abs(up - minutes) <= 3, `${date}: над горизонтом ${up} мин, по эталону ${minutes}`);

    // и событие при этом найдено: сканирование не пропускает короткий промежуток
    const events = C.moonEvents(new Date(Date.UTC(y, m - 1, d)), new Date(Date.UTC(y, m - 1, d + 1)), p.lat, p.lon);
    assert.ok(events.length >= 1, `${date}: восход или заход должен быть найден`);
  }
});

test('самые короткие появления Луны за год находятся при любом выравнивании окна поиска', () => {
  const p = place('murmansk');
  const alt = t => C.moonAltitude(new Date(t), p.lat, p.lon) > C.MOON_HORIZON;

  // Непрерывные отрезки «над горизонтом» с шагом в минуту; берём шесть самых коротких.
  const runs = [];
  let start = null, prevUp = alt(Date.UTC(2026, 0, 1));
  for (let t = Date.UTC(2026, 0, 1) + 60000; t < Date.UTC(2027, 0, 1); t += 60000) {
    const up = alt(t);
    if (up && !prevUp) start = t;
    if (!up && prevUp && start !== null) runs.push({ start, end: t, minutes: (t - start) / 60000 });
    prevUp = up;
  }
  runs.sort((a, b) => a.minutes - b.minutes);
  assert.ok(runs.length > 150, 'отрезков за год: ' + runs.length);
  assert.ok(runs[0].minutes > 30 && runs[0].minutes < 90, 'самое короткое появление: ' + runs[0].minutes + ' мин');

  for (const run of runs.slice(0, 6)) {
    // все смещения начала окна в пределах часа: как бы сетка шага ни легла на отрезок,
    // восход и заход обязаны найтись
    for (let lead = 1; lead <= 59; lead++) {
      const events = C.moonEvents(new Date(run.start - lead * 60000), new Date(run.end + 19 * 60000), p.lat, p.lon);
      const rise = events.find(e => e.type === 'rise'), set = events.find(e => e.type === 'set');
      assert.ok(rise && set, `отрезок ${new Date(run.start).toISOString()} (${run.minutes} мин), смещение ${lead}: событие потеряно`);
      assert.ok(Math.abs(rise.at - run.start) < 90000, 'восход в пределах полутора минут');
      assert.ok(Math.abs(set.at - run.end) < 90000, 'заход в пределах полутора минут');
    }
  }
});

test('moonInfo: поля и согласованность', () => {
  const info = C.moonInfo(new Date('2026-09-26T21:43:00Z'), 68.9678, 33.0992);   // полнолуние в верхней кульминации
  assert.equal(info.phase, 'full');
  assert.ok(info.illumination > 0.99);
  assert.equal(info.up, true);
  assert.ok(info.altitude > 5 && info.altitude < 30, 'осенью полная Луна на широте Мурманска невысоко: ' + info.altitude);
  assert.equal(info.impact, C.moonImpact(info.illumination, info.altitude).level);

  const below = C.moonInfo(new Date('2026-09-26T12:00:00Z'), 68.9678, 33.0992);
  assert.equal(below.up, false);
  assert.equal(below.impact, 'none');
});

test('moonSummary: над горизонтом всю ночь, часть ночи и совсем нет', () => {
  const p = place('murmansk');
  const span = (a, b) => C.moonSummary(new Date(a), new Date(b), p.lat, p.lon);

  const allNight = span('2026-12-21T18:00:00Z', '2026-12-22T04:00:00Z');       // Луна не заходит
  assert.equal(allNight.upShare, 1);
  assert.equal(allNight.rise, null);
  assert.equal(allNight.set, null);

  const never = span('2026-02-11T18:00:00Z', '2026-02-12T04:00:00Z');          // Луна не восходит
  assert.equal(never.upShare, 0);
  assert.equal(never.impact, 'none');

  // По эталону USNO 27 сентября Луна в Мурманске заходит в 05:14 по UTC (взойдёт в 14:30).
  const partial = span('2026-09-26T18:00:00Z', '2026-09-27T08:00:00Z');
  assert.ok(Math.abs(partial.upShare - (11.2 / 14)) < 0.05, 'над горизонтом ~11,2 из 14 часов: ' + partial.upShare);
  assert.ok(partial.set instanceof Date, 'есть заход');
  assert.ok(Math.abs(partial.set.getTime() - Date.parse('2026-09-27T05:14:00Z')) < 5 * 60000, 'заход около 05:14: ' + partial.set.toISOString());
  assert.equal(partial.rise, null);
  assert.ok(partial.illumination > 0.99);
  assert.equal(partial.impact, 'strong');
});

test('moonSummary: пустой и вырожденный интервал не ломают расчёт', () => {
  const p = place('murmansk');
  const t = new Date('2026-09-26T21:43:00Z');
  const point = C.moonSummary(t, t, p.lat, p.lon);
  assert.equal(point.upShare, 1);
  const reversed = C.moonSummary(new Date('2026-09-27T00:00:00Z'), new Date('2026-09-26T00:00:00Z'), p.lat, p.lon);
  assert.ok(Number.isFinite(reversed.illumination));
});

test('события идут по возрастанию времени, а восход и заход чередуются', () => {
  const p = place('kandalaksha');
  for (const start of ['2026-03-01', '2026-07-01', '2026-11-01']) {
    const from = new Date(start + 'T00:00:00Z');
    const events = C.moonEvents(from, new Date(from.getTime() + 10 * 86400000), p.lat, p.lon);
    assert.ok(events.length >= 15, 'за 10 суток ~20 событий: ' + events.length);
    for (let i = 1; i < events.length; i++) {
      assert.ok(events[i].at > events[i - 1].at, 'порядок');
      assert.notEqual(events[i].type, events[i - 1].type, 'чередование');
    }
  }
});

test('высота Луны непрерывна и укладывается в физические пределы', () => {
  const p = place('murmansk');
  let prev = null;
  for (let t = Date.UTC(2026, 8, 1); t < Date.UTC(2026, 8, 8); t += 5 * 60000) {
    const alt = C.moonAltitude(new Date(t), p.lat, p.lon);
    assert.ok(alt >= -90 && alt <= 90);
    if (prev !== null) assert.ok(Math.abs(alt - prev) < 1.5, 'скачок высоты за 5 минут: ' + Math.abs(alt - prev));
    prev = alt;
  }
});

test('расстояние до Луны и её широта в пределах реальных значений', () => {
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 3 * 86400000) {
    const pos = C.moonPosition(new Date(t));
    assert.ok(pos.distance > 356000 && pos.distance < 407000, 'расстояние: ' + pos.distance);
    assert.ok(Math.abs(pos.lat) < 5.4, 'широта Луны не выходит за 5,3°: ' + pos.lat);
    assert.ok(pos.lon >= 0 && pos.lon < 360);
  }
});
