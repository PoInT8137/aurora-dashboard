// Установка service worker: при первой установке файлы оболочки берутся из HTTP-кэша браузера
// (страница их только что загрузила), при обновлении версии запрашиваются заново мимо всех кэшей.
// Запуск: node --test tools/sw-install.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');

async function install(existingCaches) {
  const handlers = {};
  const requests = [];
  const stored = [];
  const ctx = {
    self: {
      addEventListener: (type, fn) => { handlers[type] = fn; },
      registration: { scope: 'https://auroramurmansk.ru/' },
      skipWaiting: () => Promise.resolve(),
      location: { origin: 'https://auroramurmansk.ru' }
    },
    importScripts() {},
    URL,
    Request: class { constructor(url, init = {}) { this.url = url; this.cache = init.cache || 'default'; } },
    fetch: async req => { requests.push(req); return { ok: true }; },
    caches: {
      open: async () => ({ put: async (url) => { stored.push(url); } }),
      keys: async () => existingCaches
    },
    Promise, console
  };
  vm.runInNewContext(source, ctx);
  let done;
  handlers.install({ waitUntil: p => { done = p; } });
  await done;
  return { requests, stored };
}

test('первая установка: без метки версии и без перезагрузки, то есть из HTTP-кэша браузера', async () => {
  const { requests, stored } = await install([]);
  assert.ok(requests.length > 20);
  for (const r of requests) {
    assert.doesNotMatch(r.url, /[?&]v=/, r.url);
    assert.equal(r.cache, 'default', r.url);
  }
  assert.ok(stored.includes('https://auroramurmansk.ru/index.html'));
});

test('обновление версии: с меткой ?v= и мимо HTTP-кэша, хранится под обычным адресом', async () => {
  const { requests, stored } = await install(['aurora-v1', 'чужой-кэш']);
  for (const r of requests) {
    assert.match(r.url, /[?&]v=v\d+$/, r.url);
    assert.equal(r.cache, 'reload', r.url);
  }
  assert.ok(stored.every(url => !/[?&]v=/.test(url)));
});
