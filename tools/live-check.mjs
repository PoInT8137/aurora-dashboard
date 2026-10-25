// Проверка живого сайта после публикации. Не тест: запускается вручную.
//   node tools/live-check.mjs [ожидаемая версия, по умолчанию из js/base.js]
// Что проверяет: сайт отдаёт ожидаемую версию (ждёт до 6 минут, пока обновится хостинг), все
// файлы первого захода отвечают 200, сервер данных отвечает на каждый адрес, и сколько на это
// уходит времени. Код выхода 1, если что-то не так.
import fs from 'node:fs';
import { firstLoadFiles } from './first-load.mjs';

const SITE = 'https://auroramurmansk.ru/';
const API = 'https://aurora-push.aurora-murmansk.workers.dev';
const ORIGIN = { Origin: 'https://auroramurmansk.ru' };
const local = /APP_VERSION = '([^']+)'/.exec(fs.readFileSync(new URL('../js/base.js', import.meta.url), 'utf8'))[1];
const want = process.argv[2] || local;
const problems = [];

async function timed(url, init) {
  const t = Date.now();
  try {
    const res = await fetch(url, { ...init, cache: 'no-store', signal: AbortSignal.timeout(15000) });
    const body = await res.text();
    return { ok: res.ok, status: res.status, ms: Date.now() - t, body };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t, body: String(e && e.message) };
  }
}

// 1. Версия на сайте
let live = null;
for (let i = 0; i < 24; i++) {
  const r = await timed(SITE + 'sw.js?t=' + Date.now());
  live = (/CACHE_VERSION = '([^']+)'/.exec(r.body) || [])[1] || null;
  if (live === want) break;
  await new Promise(r => setTimeout(r, 15000));
}
console.log('версия на сайте: ' + live + (live === want ? '' : ' (ждали ' + want + ')'));
if (live !== want) problems.push('версия ' + live + ' вместо ' + want);

// 2. Файлы первого захода
for (const f of firstLoadFiles()) {
  const r = await timed(SITE + f + '?t=' + Date.now());
  if (!r.ok) problems.push(f + ': ' + r.status);
}
console.log('файлы первого захода: ' + firstLoadFiles().length + ', с ошибкой: ' + problems.filter(p => p.includes(':')).length);

// 3. Сервер данных
const endpoints = ['/health', '/noaa/kp', '/noaa/kp-forecast', '/noaa/sw-mag', '/noaa/sw-speed', '/noaa/ovation', '/noaa/hp30', '/reports', '/verify'];
for (const path of endpoints) {
  const r = await timed(API + path, { headers: ORIGIN });
  const stale = /"stale":true/.test(r.body) ? ' (запасная копия)' : '';
  console.log(path.padEnd(18) + String(r.status).padEnd(5) + String(r.ms).padStart(5) + ' мс' + stale);
  if (!r.ok) problems.push(path + ': ' + r.status);
}

if (problems.length) {
  console.log('\nПРОБЛЕМЫ:\n- ' + problems.join('\n- '));
  process.exit(1);
}
console.log('\nвсё в порядке');
