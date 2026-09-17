// Сравнение двух формул эффективной облачности
const W = { low: 1.0, mid: 0.8, high: 0.35 };

const sum = (l, m, h) => Math.min(100, Math.round(W.low * l + W.mid * m + W.high * h));

const prod = (l, m, h) => Math.round(100 * (1 -
  (1 - W.low * l / 100) * (1 - W.mid * m / 100) * (1 - W.high * h / 100)));

const score = p => p <= 25 ? 3 : p <= 50 ? 2 : p <= 75 ? 1 : 0;
const label = s => ['закрыто', 'просветы редки', 'переменная', 'ясно'][s];

const cases = [
  ['ясное небо',                    0,   0,   0],
  ['сплошной stratus',            100,   0,   0],
  ['сплошной альтостратус',         0, 100,   0],
  ['сплошные перистые',             0,   0, 100],
  ['всё затянуто',                100, 100, 100],
  ['сейчас в Мурманске',            7,   9,   0],
  ['лёгкая дымка везде',           10,  10,  10],
  ['по четверти в каждом',         25,  25,  25],
  ['по трети в каждом',            30,  30,  30],
  ['половина в каждом',            50,  50,  50],
  ['перистые над разорванным ср.',  0,  40,  80],
  ['кучёвка + вуаль перистых',     20,   0,  60],
  ['разорванные низ и средний',    50,  50,   0],
  ['тонкий сплошной верх + низ',   15,  20, 100],
  ['фронт заходит',                60,  70,  40]
];

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('случай', 30) + pad('low/mid/high', 14) + pad('сумма', 18) + pad('перекрытие', 18) + 'Δ');
console.log('-'.repeat(88));

for (const [name, l, m, h] of cases) {
  const a = sum(l, m, h), b = prod(l, m, h);
  const sa = score(a), sb = score(b);
  const mark = sa === sb ? '' : '  ← балл разный';
  console.log(
    pad(name, 30) +
    pad(`${l}/${m}/${h}`, 14) +
    pad(`${a}% (${sa}, ${label(sa)})`, 18) +
    pad(`${b}% (${sb}, ${label(sb)})`, 18) +
    (a - b) + mark
  );
}

// Сплошной прогон по всему пространству значений
let total = 0, diffScore = 0, clamped = 0, maxGap = 0, maxGapAt = null, gapSum = 0;
for (let l = 0; l <= 100; l += 5)
  for (let m = 0; m <= 100; m += 5)
    for (let h = 0; h <= 100; h += 5) {
      const a = sum(l, m, h), b = prod(l, m, h);
      total++;
      gapSum += a - b;
      if (score(a) !== score(b)) diffScore++;
      if (W.low * l + W.mid * m + W.high * h > 100) clamped++;
      if (a - b > maxGap) { maxGap = a - b; maxGapAt = `${l}/${m}/${h}`; }
    }

console.log('\nПрогон по всем сочетаниям с шагом 5 %:');
console.log(`  всего сочетаний:            ${total}`);
console.log(`  балл различается:           ${diffScore} (${(100 * diffScore / total).toFixed(1)} %)`);
console.log(`  сумма упирается в потолок:  ${clamped} (${(100 * clamped / total).toFixed(1)} %)`);
console.log(`  средний разрыв:             ${(gapSum / total).toFixed(1)} п.п.`);
console.log(`  максимальный разрыв:        ${maxGap} п.п. при ${maxGapAt}`);

// Насколько часто сумма даёт «небо закрыто» там, где перекрытие ещё нет
let falseShut = 0;
for (let l = 0; l <= 100; l += 5)
  for (let m = 0; m <= 100; m += 5)
    for (let h = 0; h <= 100; h += 5)
      if (score(sum(l, m, h)) === 0 && score(prod(l, m, h)) > 0) falseShut++;
console.log(`  сумма говорит «закрыто», перекрытие — нет: ${falseShut} (${(100 * falseShut / total).toFixed(1)} %)`);
