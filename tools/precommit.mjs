// Проверки перед коммитом (вызывает .githooks/pre-commit). Код выхода 1 останавливает коммит.
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const problems = [];
const EM_DASH = String.fromCharCode(0x2014);   // длинное тире
const run = (cmd, cwd) => {
  try {
    execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf8' });
    return true;
  } catch (e) {
    const out = String(e.stdout || '') + String(e.stderr || '');
    const failed = out.split('\n').filter(l => /^✖/.test(l)).slice(0, 10);
    problems.push(cmd + (cwd ? ' (' + cwd + ')' : '') + ':\n  ' + (failed.join('\n  ') || out.slice(-600)));
    return false;
  }
};

const staged = execSync('git diff --cached --name-only', { encoding: 'utf8' }).split('\n').filter(Boolean);

// Версия на странице и у кэша service worker должна совпадать (иначе обновление не дойдёт).
const app = /APP_VERSION = '([^']+)'/.exec(fs.readFileSync('js/base.js', 'utf8'))[1];
const cache = /CACHE_VERSION = '([^']+)'/.exec(fs.readFileSync('sw.js', 'utf8'))[1];
if (app !== cache) problems.push('APP_VERSION ' + app + ' и CACHE_VERSION ' + cache + ' различаются');

// Длинное тире в новых строках кода, комментариев, README и текстов интерфейса.
const added = execSync('git diff --cached -U0 -- "*.js" "*.mjs" "*.css" "*.html" "*.md" "*.toml" "*.sql"', { encoding: 'utf8' })
  .split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++') && l.includes(EM_DASH));
if (added.length) problems.push('длинное тире в новых строках:\n  ' + added.slice(0, 8).map(l => l.slice(0, 120)).join('\n  '));

run('node --test "tools/*.test.mjs"', '.');
if (staged.some(f => f.startsWith('worker/') || f === 'core.js')) run('npm test --silent', 'worker');

if (problems.length) {
  console.error('Коммит остановлен:\n- ' + problems.join('\n- '));
  process.exit(1);
}
console.log('проверки перед коммитом пройдены');
