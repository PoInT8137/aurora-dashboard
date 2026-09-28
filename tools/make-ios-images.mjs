// Картинки для iPhone: иконка «Домой» 180×180 и стартовые экраны под размеры экранов.
// Рисует tools/ios-images.html, снимает Chrome без окна. Запуск (не тест, вручную):
//   node tools/make-ios-images.mjs [путь к chrome.exe]
// Список экранов — IOS_SCREENS; ссылки на них в index.html проверяет tools/ios-images.test.mjs.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Экраны iPhone в точках и плотность пикселей: из них — размер картинки и media-запрос. */
export const IOS_SCREENS = [
  { w: 440, h: 956, dpr: 3 },   // 16 Pro Max
  { w: 430, h: 932, dpr: 3 },   // 14 Pro Max, 15 Plus / Pro Max, 16 Plus
  { w: 428, h: 926, dpr: 3 },   // 12 / 13 Pro Max, 14 Plus
  { w: 402, h: 874, dpr: 3 },   // 16 Pro
  { w: 393, h: 852, dpr: 3 },   // 14 Pro, 15, 15 Pro, 16
  { w: 390, h: 844, dpr: 3 },   // 12, 13, 14
  { w: 375, h: 812, dpr: 3 },   // X, XS, 11 Pro, 12 / 13 mini
  { w: 414, h: 896, dpr: 2 },   // XR, 11
  { w: 375, h: 667, dpr: 2 }    // SE 2 / 3, 8
];

export const splashName = s => `icons/splash-${s.w * s.dpr}x${s.h * s.dpr}.png`;

function shoot(chrome, url, w, h, dpr, out) {
  execFileSync(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
    `--window-size=${w},${h}`, `--force-device-scale-factor=${dpr}`,
    `--screenshot=${path.join(root, out)}`, url
  ], { stdio: 'ignore' });
  console.log(out);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const chrome = process.argv[2] || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const page = pathToFileURL(path.join(root, 'tools/ios-images.html')).href;
  shoot(chrome, page + '?kind=icon&w=180&h=180', 180, 180, 1, 'icons/apple-touch-icon.png');
  for (const s of IOS_SCREENS) shoot(chrome, page + `?kind=splash&w=${s.w}&h=${s.h}`, s.w, s.h, s.dpr, splashName(s));
  if (!fs.existsSync(path.join(root, 'icons/apple-touch-icon.png'))) process.exit(1);
}
