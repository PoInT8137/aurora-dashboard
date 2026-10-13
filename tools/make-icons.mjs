// Иконки приложения и превью ссылки со знака «Север» (icons/logo.svg). Рисует tools/brand.html,
// снимает Chrome без окна. Запуск (не тест, вручную), после — node tools/make-ios-images.mjs:
//   node tools/make-icons.mjs [путь к chrome]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { shoot } from './make-ios-images.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Что снимать: файл, вид картинки в brand.html и размер. */
export const BRAND_IMAGES = [
  { out: 'icons/icon-192.png',          kind: 'icon',     w: 192, h: 192 },
  { out: 'icons/icon-512.png',          kind: 'icon',     w: 512, h: 512 },
  { out: 'icons/icon-maskable-512.png', kind: 'maskable', w: 512, h: 512 },
  { out: 'icons/og-image.png',          kind: 'og',       w: 1200, h: 630 }
];

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const chrome = process.argv[2] || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const page = pathToFileURL(path.join(root, 'tools/brand.html')).href;
  for (const b of BRAND_IMAGES) shoot(chrome, page + `?kind=${b.kind}&w=${b.w}`, b.w, b.h, 1, b.out);
  if (!fs.existsSync(path.join(root, 'icons/icon-512.png'))) process.exit(1);
}
