// Файлы первого захода на сайт: страница, стили и все подключённые в index.html скрипты.
// Общий список для бюджета скорости (budget.test.mjs) и проверки живого сайта (live-check.mjs).
import fs from 'node:fs';

export function firstLoadFiles() {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  const styles = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(m => m[1]);
  return ['index.html', ...styles, ...scripts];
}
