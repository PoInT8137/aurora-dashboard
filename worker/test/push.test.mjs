import test from 'node:test';
import assert from 'node:assert/strict';
import { b64u, fromB64u, checkEndpoint, vapidAuthorization, sendPush } from '../src/push.js';
import { makeEnv, ep, NIGHT } from './helpers.mjs';

test('base64url: круговое преобразование и алфавит без + / =', () => {
  const bytes = Uint8Array.from({ length: 200 }, (_, i) => (i * 37) % 256);
  const text = b64u(bytes);
  assert.match(text, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(fromB64u(text), bytes);
});

test('адрес подписки: принимаются push-сервисы браузеров', () => {
  for (const url of [
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://android.googleapis.com/gcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/QGxyz',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
    'https://fcm.googleapis.com:443/fcm/send/abc'
  ]) assert.ok(checkEndpoint(url), 'должен приниматься: ' + url);
});

test('адрес подписки: всё остальное отклоняется', () => {
  for (const url of [
    'http://fcm.googleapis.com/fcm/send/abc',                 // не https
    'https://fcm.googleapis.com.evil.example/fcm/send/abc',   // чужой домен с похожим началом
    'https://evilfcm.googleapis.com/fcm/send/abc',
    'https://evil.example/https://fcm.googleapis.com/',
    'https://user:pass@fcm.googleapis.com/fcm/send/abc',      // учётные данные в адресе
    'https://fcm.googleapis.com:8443/fcm/send/abc',           // нестандартный порт
    'https://evilpush.apple.com/x',                           // не поддомен push.apple.com
    'https://localhost/x', 'https://127.0.0.1/x', 'https://169.254.169.254/latest/meta-data',
    'https://fcm.googleapis.com/' + 'a'.repeat(1100),         // слишком длинный
    'not a url', '', null, undefined, 42, {}, ['https://fcm.googleapis.com/x']
  ]) assert.equal(checkEndpoint(url), null, 'должен отклоняться: ' + String(url).slice(0, 60));
});

test('VAPID: заголовок разбирается, подпись проверяется открытым ключом', async () => {
  const { env, keys } = await makeEnv();
  const url = checkEndpoint(ep(1));
  const auth = await vapidAuthorization(url, env, NIGHT);

  const m = auth.match(/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/);
  assert.ok(m, 'формат «vapid t=<jwt>, k=<ключ>»: ' + auth.slice(0, 60));
  const [, h, p, sig, k] = m;

  assert.deepEqual(JSON.parse(new TextDecoder().decode(fromB64u(h))), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(new TextDecoder().decode(fromB64u(p)));
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.sub, 'https://auroramurmansk.ru');
  assert.ok(claims.exp > NIGHT / 1000 && claims.exp <= NIGHT / 1000 + 24 * 3600, 'срок не больше суток');
  assert.equal(k, keys.publicB64);
  assert.equal(fromB64u(k).length, 65, 'несжатая точка P-256');

  const signature = fromB64u(sig);
  assert.equal(signature.length, 64, 'подпись r||s, а не DER');
  const data = new TextEncoder().encode(h + '.' + p);
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keys.publicKey, signature, data), true);

  // подмена содержимого подпись не переживает
  const forged = new TextEncoder().encode(h + '.' + b64u(new TextEncoder().encode('{"aud":"x"}')));
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keys.publicKey, signature, forged), false);
});

test('VAPID: aud берётся из адреса подписки каждого сервиса', async () => {
  const { env } = await makeEnv();
  for (const [endpoint, aud] of [
    ['https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://updates.push.services.mozilla.com'],
    ['https://web.push.apple.com/abc', 'https://web.push.apple.com']
  ]) {
    const auth = await vapidAuthorization(checkEndpoint(endpoint), env, NIGHT);
    const claims = JSON.parse(new TextDecoder().decode(fromB64u(auth.match(/t=[\w-]+\.([\w-]+)\./)[1])));
    assert.equal(claims.aud, aud);
  }
});

test('sendPush: пустой запрос с заголовками, статус возвращается как есть', async () => {
  const { env } = await makeEnv();
  let seen;
  const fetchFn = async (url, init) => { seen = { url, init }; return new Response(null, { status: 201 }); };

  assert.equal(await sendPush(ep(1), env, NIGHT, fetchFn), 201);
  assert.equal(seen.url, ep(1));
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.body, undefined, 'без полезной нагрузки');
  assert.equal(seen.init.headers.TTL, '3600');
  assert.equal(seen.init.headers.Urgency, 'high');
  assert.match(seen.init.headers.Authorization, /^vapid t=/);
});

test('sendPush: сетевой сбой даёт 0, чужой адрес — 400 без единого запроса', async () => {
  const { env } = await makeEnv();
  assert.equal(await sendPush(ep(1), env, NIGHT, async () => { throw new Error('сеть'); }), 0);

  let called = false;
  assert.equal(await sendPush('https://evil.example/x', env, NIGHT, async () => { called = true; }), 400);
  assert.equal(called, false);
});

/** Запускает sendPush и собирает то, что попало в console.error. */
async function sendLogged(env) {
  const logged = [];
  const realError = console.error;
  console.error = message => logged.push(String(message));
  let reachedNetwork = false;
  let status;
  try {
    status = await sendPush(ep(1), env, NIGHT, async () => { reachedNetwork = true; return new Response(null, { status: 201 }); });
  } finally {
    console.error = realError;
  }
  return { status, logged, reachedNetwork };
}

test('sendPush: неверный закрытый ключ — статус 0, в журнале названа причина, до сети дело не доходит', async () => {
  for (const broken of ['не ключ', '', undefined, 'AAAA', '{"kty":"EC"}', 'A'.repeat(42), 'A'.repeat(44)]) {
    const { env } = await makeEnv();
    env.VAPID_PRIVATE_KEY = broken;
    const { status, logged, reachedNetwork } = await sendLogged(env);
    assert.equal(status, 0, 'секрет: ' + JSON.stringify(broken));
    assert.equal(reachedNetwork, false);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /VAPID_PRIVATE_KEY должен быть 32 байт/, JSON.stringify(broken));
  }
});

test('sendPush: неверный открытый ключ — то же самое, причина названа', async () => {
  for (const broken of ['', 'AAAA', 'не ключ', undefined]) {
    const { env } = await makeEnv();
    env.VAPID_PUBLIC = broken;
    const { status, logged } = await sendLogged(env);
    assert.equal(status, 0);
    assert.match(logged[0], /VAPID_PUBLIC должен быть 65 байт/, JSON.stringify(broken));
  }

  // правильной длины, но не несжатая точка (первый байт не 0x04)
  const { env } = await makeEnv();
  const bytes = fromB64u(env.VAPID_PUBLIC);
  bytes[0] = 3;
  env.VAPID_PUBLIC = b64u(bytes);
  const { logged } = await sendLogged(env);
  assert.match(logged[0], /первый байт 0x04/);
});

test('sendPush: ключ правильной длины, но недействительный (нулевой), не образует пары с открытым', async () => {
  const { env } = await makeEnv();
  env.VAPID_PRIVATE_KEY = 'A'.repeat(43);                 // 32 нулевых байта
  const { status, logged } = await sendLogged(env);
  assert.equal(status, 0);
  assert.match(logged[0], /не образуют пару/);
});

test('sendPush: закрытый и открытый ключи от разных пар распознаются сразу, а не после недели тишины', async () => {
  const a = await makeEnv();
  const b = await makeEnv();
  a.env.VAPID_PUBLIC = b.env.VAPID_PUBLIC;          // ключи перепутали при настройке

  const { status, logged, reachedNetwork } = await sendLogged(a.env);
  assert.equal(status, 0);
  assert.equal(reachedNetwork, false);
  assert.match(logged[0], /не образуют пару/);
});

test('sendPush: движок, не проверивший пару ключей при импорте, всё равно ловится проверкой подписи', async () => {
  const { env } = await makeEnv();

  // Подменяем проверку подписи: как будто подпись закрытым ключом открытый не принял.
  Object.defineProperty(crypto.subtle, 'verify', { value: async () => false, configurable: true });
  let result;
  try {
    result = await sendLogged(env);
  } finally {
    delete crypto.subtle.verify;
  }

  assert.equal(result.status, 0);
  assert.equal(result.reachedNetwork, false);
  assert.match(result.logged[0], /не образуют пару/);
});
