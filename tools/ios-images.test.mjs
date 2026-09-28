// Иконка и стартовые экраны для iPhone: ссылки в index.html совпадают со списком экранов, файлы
// на месте и нужного размера. Запуск: node --test tools/ios-images.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { IOS_SCREENS, splashName } from './make-ios-images.mjs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url));
const pngSize = buf => [buf.readUInt32BE(16), buf.readUInt32BE(20)];
const html = read('index.html').toString();

test('иконка «Домой» — 180×180, своя, а не уменьшенная браузером 192', () => {
  assert.match(html, /<link rel="apple-touch-icon" href="icons\/apple-touch-icon\.png" sizes="180x180">/);
  assert.deepEqual(pngSize(read('icons/apple-touch-icon.png')), [180, 180]);
});

test('стартовый экран на каждый размер iPhone: ссылка с точным media и картинка в пикселях экрана', () => {
  for (const s of IOS_SCREENS) {
    const file = splashName(s);
    const media = `(device-width: ${s.w}px) and (device-height: ${s.h}px) and (-webkit-device-pixel-ratio: ${s.dpr}) and (orientation: portrait)`;
    assert.ok(html.includes(`<link rel="apple-touch-startup-image" href="${file}" media="${media}">`), file);
    assert.deepEqual(pngSize(read(file)), [s.w * s.dpr, s.h * s.dpr], file);
  }
});

test('стартовые экраны не входят в оболочку service worker — их берёт сама iOS', () => {
  assert.doesNotMatch(read('sw.js').toString(), /splash-\d+x\d+\.png/);
});
