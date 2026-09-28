/* «Поделиться»: ссылка на нужном языке и QR-код.
   Часть приложения: общие переменные и функции — глобальные, порядок подключения задан
   в index.html (см. js/README.md). */
'use strict';

/* ------------------------------------------------------------------ */
/*  «Поделиться»: ссылка на нужном языке и QR-код для печати.          */
/*  Библиотека QR (vendor/qrcode.js, MIT) подгружается при первом      */
/*  открытии окна: остальным она не нужна, а в офлайне берётся из кэша. */
/* ------------------------------------------------------------------ */

var QR_LIB = 'vendor/qrcode.js';
var QR_MARGIN = 4;   // тихая зона по стандарту — 4 модуля, без неё телефоны читают хуже
var qrLibLoading = null;

/** Ссылка на сайт, которая откроет его на языке lang. */
function shareUrl(lang) {
  return location.origin + location.pathname + '?lang=' + lang;
}

function loadQrLib() {
  if (typeof qrcode === 'function') return Promise.resolve();
  if (qrLibLoading) return qrLibLoading;
  qrLibLoading = new Promise(function (resolve, reject) {
    var script = document.createElement('script');
    script.src = QR_LIB;
    script.onload = function () { resolve(); };
    script.onerror = function () { qrLibLoading = null; reject(appError('qr_lib')); };
    document.head.appendChild(script);
  });
  return qrLibLoading;
}

/** Матрица QR: массив строк из true/false. Уровень коррекции M — запас на мятую бумагу. */
function qrMatrix(text) {
  var qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  var n = qr.getModuleCount();
  var rows = [];
  for (var r = 0; r < n; r++) {
    var row = [];
    for (var c = 0; c < n; c++) row.push(qr.isDark(r, c));
    rows.push(row);
  }
  return rows;
}

/* Оформление кода. Модули — скруглённые квадратики с зазором, три поисковых узора («глазки»
   по углам) — сплошные скруглённые рамки. Цвет — градиент сияния от тёмно-бирюзового к
   фиолетовому: оба оттенка тёмные, контраст с белым фоном выше 6:1 — камеры читают код так же
   уверенно, как чёрно-белый. Белый фон и тихая зона остаются: без них код читается хуже. */
var QR_INK = [['0', '#0b5f55'], ['0.5', '#134a6e'], ['1', '#3a1d78']];
var QR_DOT = { inset: 0.07, radius: 0.3 };   // доли модуля

/** Что рисовать: поисковые узоры (левый верхний угол 7×7) и остальные тёмные модули. */
function qrShapes(matrix) {
  var n = matrix.length;
  var eyes = [[0, 0], [0, n - 7], [n - 7, 0]];
  var inEye = function (r, c) {
    return eyes.some(function (e) { return r >= e[0] && r < e[0] + 7 && c >= e[1] && c < e[1] + 7; });
  };
  var dots = [];
  matrix.forEach(function (row, r) {
    row.forEach(function (dark, c) { if (dark && !inEye(r, c)) dots.push([r, c]); });
  });
  return { eyes: eyes, dots: dots };
}

function qrNum(x) { return String(Math.round(x * 1000) / 1000); }

/** Контур скруглённого прямоугольника для SVG-пути. */
function roundRectPath(x, y, w, h, r) {
  return 'M' + qrNum(x + r) + ' ' + qrNum(y) + 'h' + qrNum(w - 2 * r) + 'a' + r + ' ' + r + ' 0 0 1 ' + r + ' ' + r +
    'v' + qrNum(h - 2 * r) + 'a' + r + ' ' + r + ' 0 0 1 -' + r + ' ' + r +
    'h-' + qrNum(w - 2 * r) + 'a' + r + ' ' + r + ' 0 0 1 -' + r + ' -' + r +
    'v-' + qrNum(h - 2 * r) + 'a' + r + ' ' + r + ' 0 0 1 ' + r + ' -' + r + 'z';
}

/** SVG из матрицы: белый фон с тихой зоной, модули и «глазки» одним путём с градиентом сияния. */
function qrSvg(matrix, label) {
  var size = matrix.length + QR_MARGIN * 2;
  var shapes = qrShapes(matrix);
  var s = 1 - 2 * QR_DOT.inset;
  var path = '';
  shapes.eyes.forEach(function (e) {
    var x = e[1] + QR_MARGIN, y = e[0] + QR_MARGIN;
    path += roundRectPath(x, y, 7, 7, 2) + roundRectPath(x + 1, y + 1, 5, 5, 1.3) + roundRectPath(x + 2, y + 2, 3, 3, 0.9);
  });
  shapes.dots.forEach(function (d) {
    path += roundRectPath(d[1] + QR_MARGIN + QR_DOT.inset, d[0] + QR_MARGIN + QR_DOT.inset, s, s, QR_DOT.radius);
  });
  var stops = QR_INK.map(function (st) { return '<stop offset="' + st[0] + '" stop-color="' + st[1] + '"/>'; }).join('');
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '"' +
    ' role="img" aria-label="' + label.replace(/[&"<>]/g, '') + '">' +
    '<defs><linearGradient id="qr-ink" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="' + size + '" y2="' + size + '">' +
    stops + '</linearGradient></defs>' +
    '<rect width="' + size + '" height="' + size + '" fill="#fff"/>' +
    '<path fill="url(#qr-ink)" fill-rule="evenodd" d="' + path + '"/></svg>';
}

/** Скруглённый прямоугольник на canvas; старые браузеры без roundRect получают обычный. */
function canvasRoundRect(g, x, y, w, h, r) {
  if (g.roundRect) g.roundRect(x, y, w, h, r);
  else g.rect(x, y, w, h);
}

/**
 * PNG для печати: тот же рисунок, по scale пикселей на модуль, и подпись с адресом сайта под
 * кодом — чтобы на листовке было понятно, куда он ведёт. Отдаёт canvas.
 */
function qrCanvas(matrix, scale, caption) {
  var size = (matrix.length + QR_MARGIN * 2) * scale;
  var footer = caption ? Math.round(scale * 3) : 0;
  var canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size + footer;
  var g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, size, size + footer);

  var ink = g.createLinearGradient(0, 0, size, size);
  QR_INK.forEach(function (st) { ink.addColorStop(Number(st[0]), st[1]); });
  g.fillStyle = ink;

  var shapes = qrShapes(matrix);
  g.beginPath();
  shapes.eyes.forEach(function (e) {
    var x = (e[1] + QR_MARGIN) * scale, y = (e[0] + QR_MARGIN) * scale;
    canvasRoundRect(g, x, y, 7 * scale, 7 * scale, 2 * scale);
    canvasRoundRect(g, x + scale, y + scale, 5 * scale, 5 * scale, 1.3 * scale);
    canvasRoundRect(g, x + 2 * scale, y + 2 * scale, 3 * scale, 3 * scale, 0.9 * scale);
  });
  g.fill('evenodd');

  var inset = QR_DOT.inset * scale, s = (1 - 2 * QR_DOT.inset) * scale;
  g.beginPath();
  shapes.dots.forEach(function (d) {
    canvasRoundRect(g, (d[1] + QR_MARGIN) * scale + inset, (d[0] + QR_MARGIN) * scale + inset, s, s, QR_DOT.radius * scale);
  });
  g.fill();

  if (caption) {
    g.fillStyle = '#134a6e';
    g.font = '600 ' + Math.round(scale * 1.6) + 'px system-ui, -apple-system, "Segoe UI", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    // под тихой зоной, а не в ней: надпись в тихой зоне мешает камере найти код
    g.fillText(caption, size / 2, size + footer / 2 - scale / 2);
  }
  return canvas;
}

function setShareStatus(key, params) {
  $('share-status').textContent = key ? t(key, params) : '';
}

function renderShare() {
  var lang = state.shareLang || getLang();
  var url = shareUrl(lang);
  Array.prototype.forEach.call(document.querySelectorAll('[data-share-lang]'), function (btn) {
    btn.setAttribute('aria-pressed', String(btn.getAttribute('data-share-lang') === lang));
  });
  $('share-url').textContent = url;
  $('share-native').hidden = !(navigator.share);

  var box = $('share-qr');
  return loadQrLib().then(function () {
    state.shareMatrix = qrMatrix(url);
    box.innerHTML = qrSvg(state.shareMatrix, t('share.qr_label', { url: url }));
  }, function () {
    state.shareMatrix = null;
    box.innerHTML = '';
    setShareStatus('share.qr_failed');
  });
}

function openShare() {
  state.shareLang = getLang();
  setShareStatus(null);
  var dialog = $('share-dialog');
  if (dialog.showModal) dialog.showModal();
  else dialog.setAttribute('open', '');
  return renderShare();
}

function copyShareUrl() {
  var url = shareUrl(state.shareLang || getLang());
  var done = function () { setShareStatus('share.copied'); };
  var fail = function () { setShareStatus('share.copy_failed'); };
  if (!navigator.clipboard || !navigator.clipboard.writeText) { fail(); return Promise.resolve(); }
  return navigator.clipboard.writeText(url).then(done, fail);
}

function nativeShare() {
  var url = shareUrl(state.shareLang || getLang());
  if (!navigator.share) return Promise.resolve();
  // Отмена в системном меню — тоже отказ промиса; сообщать о нём незачем.
  return navigator.share({ title: t('title.point', { name: pointName(currentPoint()) }), text: t('share.text'), url: url })
    .catch(function () {});
}

function downloadQrPng() {
  if (!state.shareMatrix) return;
  var canvas = qrCanvas(state.shareMatrix, 12, location.host);
  var link = document.createElement('a');
  link.download = 'aurora-murmansk-qr-' + (state.shareLang || getLang()) + '.png';
  link.href = canvas.toDataURL('image/png');
  link.click();
}

function initShare() {
  $('share-btn').addEventListener('click', openShare);
  $('share-lang').addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-share-lang]') : null;
    if (!btn) return;
    state.shareLang = btn.getAttribute('data-share-lang');
    setShareStatus(null);
    renderShare();
  });
  $('share-copy').addEventListener('click', copyShareUrl);
  $('share-native').addEventListener('click', nativeShare);
  $('share-png').addEventListener('click', downloadQrPng);
}
