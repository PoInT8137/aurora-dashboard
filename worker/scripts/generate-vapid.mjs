// Генерация пары ключей VAPID для сервера уведомлений.
//
//   node scripts/generate-vapid.mjs <файл для закрытого ключа>
//
// Открытый ключ печатается в терминал (он публичный: идёт в config.js и
// wrangler.toml). Закрытый в терминал НЕ печатается — он записывается в файл,
// чтобы не остаться в истории терминала и в логах. Файл храните вне репозитория
// и не публикуйте: закрытый ключ позволяет слать уведомления от имени сайта.
//
// Из закрытого ключа сделан секрет worker'а:
//   wrangler secret put VAPID_PRIVATE_KEY   (значение — содержимое файла)

import fs from 'node:fs';

const out = process.argv[2];
if (!out) {
  console.error('Укажите файл для закрытого ключа: node scripts/generate-vapid.mjs <файл>');
  process.exit(1);
}
if (fs.existsSync(out)) {
  console.error(`Файл ${out} уже существует — перезаписывать закрытый ключ нельзя: подписки, оформленные с прежним ключом, перестанут работать.`);
  process.exit(1);
}

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));

// jwk.d — закрытая часть, 32 байта в base64url, ровно то, что ждёт worker.
fs.writeFileSync(out, jwk.d + '\n', { mode: 0o600, flag: 'wx' });

console.log('Закрытый ключ записан в: ' + out + ' (в терминал не выводится)');
console.log('');
console.log('Открытый ключ — впишите в config.js (vapidPublicKey) и в worker/wrangler.toml (VAPID_PUBLIC):');
console.log(Buffer.from(publicRaw).toString('base64url'));
