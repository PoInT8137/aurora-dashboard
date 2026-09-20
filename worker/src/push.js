// Web Push: проверка адреса подписки, подпись VAPID и отправка.
//
// Отправляется «пустой» push без полезной нагрузки: тогда не нужно шифровать
// сообщение (RFC 8291), а значит, нет целого класса тихих ошибок, когда push
// принят сервисом, но браузер не смог расшифровать. Текст уведомления
// service worker запрашивает у нашего API сам (POST /message).

const enc = new TextEncoder();

export function b64u(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function fromB64u(str) {
  const pad = '='.repeat((4 - (str.length % 4)) % 4);
  const bin = atob(str.replaceAll('-', '+').replaceAll('_', '/') + pad);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

/**
 * Принимаем адреса подписки только от известных push-сервисов. Иначе любой
 * мог бы прислать произвольный адрес, и worker стал бы рассылать запросы
 * куда угодно от нашего имени.
 */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,               // Chrome, Edge, Opera, Samsung Internet
  /^android\.googleapis\.com$/,           // старый адрес Chrome
  /(^|\.)push\.services\.mozilla\.com$/,  // Firefox
  /(^|\.)push\.apple\.com$/,              // Safari, iOS
  /(^|\.)notify\.windows\.com$/           // Edge на Windows
];

/** URL адреса подписки либо null, если адрес не подходит. */
export function checkEndpoint(value) {
  if (typeof value !== 'string' || value.length > 1000) return null;

  let url;
  try { url = new URL(value); } catch { return null; }

  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== '443') return null;
  if (!PUSH_HOSTS.some(re => re.test(url.hostname))) return null;
  return url;
}

let cachedKey = { id: null, key: null };

/** Байты ключа из base64url с проверкой длины; причина названа по имени переменной. */
function keyBytes(name, value, length) {
  let bytes = null;
  try { bytes = fromB64u(String(value || '')); } catch { /* не base64url — ниже */ }
  if (!bytes || bytes.length !== length) {
    throw new Error(name + ' должен быть ' + length + ' байт в base64url' +
      (length === 32 ? ' (43 символа, без кавычек и скобок)' : ' (0x04 | x | y)'));
  }
  return bytes;
}

/**
 * Ключ подписи из двух переменных: VAPID_PRIVATE_KEY (закрытая часть, 32 байта в
 * base64url) и VAPID_PUBLIC (65 байт: 0x04 | x | y). Так секрет — одна короткая
 * строка без кавычек и скобок: JSON внутри переменной окружения экранируется
 * по-разному разными инструментами и ломается тихо.
 *
 * При первом использовании ключи сверяются: подпись, сделанная закрытым ключом,
 * должна проверяться открытым. Иначе push слался бы, а никто бы его не принял.
 */
async function signingKey(env) {
  const id = env.VAPID_PRIVATE_KEY + '|' + env.VAPID_PUBLIC;
  if (cachedKey.id === id) return cachedKey.key;

  const d = String(env.VAPID_PRIVATE_KEY || '');
  keyBytes('VAPID_PRIVATE_KEY', d, 32);
  const point = keyBytes('VAPID_PUBLIC', env.VAPID_PUBLIC, 65);
  if (point[0] !== 4) throw new Error('VAPID_PUBLIC должен быть несжатой точкой P-256: первый байт 0x04, затем x и y');

  const curve = { name: 'ECDSA', namedCurve: 'P-256' };
  const mismatch = () => new Error('VAPID_PRIVATE_KEY и VAPID_PUBLIC не образуют пару (или повреждены)');

  // Одни среды выполнения отклоняют несовпадающую пару уже при импорте, другие —
  // только при проверке подписи ниже; сообщение в обоих случаях одно.
  let key;
  try {
    key = await crypto.subtle.importKey('jwk',
      { kty: 'EC', crv: 'P-256', d, x: b64u(point.slice(1, 33)), y: b64u(point.slice(33)) },
      curve, false, ['sign']);
  } catch {
    throw mismatch();
  }

  const probe = enc.encode('vapid-key-check');
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, probe);
  const publicKey = await crypto.subtle.importKey('raw', point, curve, false, ['verify']);
  if (!(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, probe))) {
    throw mismatch();
  }

  cachedKey = { id, key };
  return key;
}

/**
 * Заголовок Authorization по RFC 8292: vapid t=<JWT>, k=<открытый ключ>.
 * JWT подписан ES256; WebCrypto отдаёт подпись сразу в виде r||s (64 байта),
 * как того требует JWS, — конвертировать из DER не нужно.
 */
export async function vapidAuthorization(endpointUrl, env, nowMs) {
  const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64u(enc.encode(JSON.stringify({
    aud: endpointUrl.origin,
    exp: Math.floor(nowMs / 1000) + 12 * 3600,   // не больше суток по RFC
    sub: env.VAPID_SUBJECT || 'https://auroramurmansk.ru'
  })));

  const key = await signingKey(env);
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(header + '.' + payload));

  return `vapid t=${header}.${payload}.${b64u(new Uint8Array(signature))}, k=${env.VAPID_PUBLIC}`;
}

/**
 * Отправляет пустой push. Возвращает HTTP-статус ответа push-сервиса либо 0,
 * если запрос не удался вовсе. 404 и 410 означают, что подписки больше нет.
 */
export async function sendPush(endpoint, env, nowMs, fetchFn = fetch) {
  const url = checkEndpoint(endpoint);
  if (!url) return 400;

  // Подпись и сеть — разные сбои: без разделения неверно заданный ключ выглядел бы
  // как «сеть недоступна», а в журнале не осталось бы ни слова.
  let authorization;
  try {
    authorization = await vapidAuthorization(url, env, nowMs);
  } catch (error) {
    console.error('не удалось подписать push (проверьте VAPID_PRIVATE_KEY и VAPID_PUBLIC): ' + (error && error.message));
    return 0;
  }

  try {
    const res = await fetchFn(url.href, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        TTL: '3600',          // через час уведомление уже не актуально
        Urgency: 'high'
      },
      signal: AbortSignal.timeout(10000)
    });
    return res.status;
  } catch {
    return 0;
  }
}
