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

/** SVG из матрицы: один путь из квадратиков, белый фон с тихой зоной — читается и в тёмной теме. */
function qrSvg(matrix, label) {
  var size = matrix.length + QR_MARGIN * 2;
  var path = '';
  matrix.forEach(function (row, r) {
    row.forEach(function (dark, c) {
      if (dark) path += 'M' + (c + QR_MARGIN) + ' ' + (r + QR_MARGIN) + 'h1v1h-1z';
    });
  });
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" shape-rendering="crispEdges"' +
    ' role="img" aria-label="' + label.replace(/[&"<>]/g, '') + '">' +
    '<rect width="' + size + '" height="' + size + '" fill="#fff"/><path fill="#000" d="' + path + '"/></svg>';
}

/** PNG для печати: по scale пикселей на модуль. Отдаёт canvas — вызывающий превращает его в файл. */
function qrCanvas(matrix, scale) {
  var size = (matrix.length + QR_MARGIN * 2) * scale;
  var canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  var g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, size, size);
  g.fillStyle = '#000';
  matrix.forEach(function (row, r) {
    row.forEach(function (dark, c) {
      if (dark) g.fillRect((c + QR_MARGIN) * scale, (r + QR_MARGIN) * scale, scale, scale);
    });
  });
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
  var canvas = qrCanvas(state.shareMatrix, 12);
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
