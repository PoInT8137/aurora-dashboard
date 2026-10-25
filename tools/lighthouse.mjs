// Замер скорости сайта Lighthouse как с телефона на медленном мобильном интернете (настройки
// Lighthouse по умолчанию для mobile). Не тест: запускается вручную до и после изменений.
//   node tools/lighthouse.mjs [адрес] [число прогонов]
// Скрипт антивируса, который встраивается в страницы на компьютере разработчика, блокируется:
// у посетителей его нет, и он искажал замер. Итог: медиана по прогонам.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2] || 'https://auroramurmansk.ru/?lang=ru';
const runs = Number(process.argv[3] || 3);
const KEYS = {
  'first-contentful-paint': 'первое содержимое',
  'largest-contentful-paint': 'главный блок',
  'speed-index': 'скорость отрисовки',
  'total-blocking-time': 'блокировка',
  'cumulative-layout-shift': 'сдвиги',
  'total-byte-weight': 'вес'
};

const results = [];
for (let i = 0; i < runs; i++) {
  const out = path.join(os.tmpdir(), 'aurora-lh-' + i + '.json');
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', 'lighthouse@12', url, '--quiet',
    '--chrome-flags=--headless=new', '--blocked-url-patterns=*kaspersky-labs.com*',
    '--only-categories=performance', '--form-factor=mobile', '--output=json', '--output-path=' + out],
  { stdio: 'ignore', shell: process.platform === 'win32' });
  results.push(JSON.parse(fs.readFileSync(out, 'utf8')));
}

const median = list => { const s = [...list].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
console.log(url + ', прогонов: ' + runs);
console.log('оценка: ' + median(results.map(r => r.categories.performance.score * 100)));
for (const [key, label] of Object.entries(KEYS)) {
  const v = median(results.map(r => r.audits[key].numericValue));
  const unit = key === 'cumulative-layout-shift' ? v.toFixed(3) : key === 'total-byte-weight' ? Math.round(v / 1024) + ' КБ' : (v / 1000).toFixed(2) + ' с';
  console.log(label + ': ' + unit);
}
