/* Отметки «Вижу сияние»: сводка очевидцев за последний час и кнопка своей отметки.
   Часть приложения: общие переменные и функции — глобальные, порядок подключения задан
   в index.html (см. js/README.md). Сервер — worker/src/reports.js. */
'use strict';

/* ------------------------------------------------------------------ */
/*  Очевидцы                                                           */
/*                                                                     */
/*  Прогноз говорит, что сияние возможно; отметка очевидца, что оно    */
/*  есть. Отметка анонимна: точка, время и «слабое / яркое», без       */
/*  текста и фотографий. Сервер принимает её, только если у точки      */
/*  темно, и с одного устройства у одной точки раз в час; страница те  */
/*  же правила показывает заранее. Подтверждением сияния отметки       */
/*  считаются от REPORTS.confirm разных устройств за час, иначе это    */
/*  просто число. Для своего места отметка ставится у ближайшей точки. */
/* ------------------------------------------------------------------ */

var REPORTS = {
  intervalMs: 60 * 60 * 1000,   // устройство и точка, как на сервере (DEVICE_INTERVAL_MS)
  confirm: 3,                   // разных устройств за час для подтверждения (CONFIRM_DEVICES)
  refreshMs: 2 * 60 * 1000,     // сводку — не чаще раза в 2 минуты: сервер и так кэширует минуту
  timeoutMs: 6000               // ожидание сводки
};

function reportsEnabled() {
  return pushConfigured();
}

/** Сводка с сервера: { window, total, points: { id: { count, bright, last } } }. */
function loadReports(force) {
  if (!reportsEnabled()) return Promise.resolve(null);
  if (!force && state.reports && Date.now() - state.reports.loadedAt < REPORTS.refreshMs) {
    renderReports();
    return Promise.resolve(state.reports);
  }
  // Сводка второстепенная: ждём недолго и без повтора — подвисший сервер не должен держать
  // обновление (раньше — до 25 секунд при обычном ожидании с повтором).
  return fetchJsonDirect(AURORA_CONFIG.pushApi + '/reports', CONFIG.retries, 'json', REPORTS.timeoutMs)
    .then(function (data) {
      if (!data || typeof data.points !== 'object' || data.points === null) throw appError('bad_format');
      state.reports = { data: data, loadedAt: Date.now(), error: false };
      renderReports();
      return state.reports;
    })
    .catch(function () {
      state.reports = state.reports ? Object.assign(state.reports, { error: true }) : { data: null, loadedAt: 0, error: true };
      renderReports();
      return null;
    });
}

/**
 * Случайный номер этого устройства для отметок: по нему сервер не даёт одному устройству
 * отмечать одну точку чаще раза в час. Это не личные данные: просто случайная строка в
 * хранилище браузера, и сервер хранит не её саму, а её хеш с солью. Без хранилища номера нет,
 * тогда сервер считает устройством хеш IP.
 */
function reportDevice() {
  var key = CACHE.prefix + 'device';
  try {
    var saved = localStorage.getItem(key);
    if (saved && /^[A-Za-z0-9_-]{16,64}$/.test(saved)) return saved;
    var bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    var made = Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    localStorage.setItem(key, made);
    return made;
  } catch (e) {
    return null;
  }
}

/**
 * Подтверждено ли сияние у точки. Решает сервер (разные устройства и разные сети); по числу
 * устройств судим, только если ответ старого сервера без поля confirmed.
 */
function reportsConfirmed(p) {
  if (!p) return false;
  if (typeof p.confirmed === 'boolean') return p.confirmed;
  return (p.devices || 0) >= REPORTS.confirm;
}

/** Когда можно снова отметить эту точку (мс) или 0, если уже можно. */
function reportAgainAt(point) {
  var last = 0;
  point = point || pushPoint();
  try { last = Number(localStorage.getItem(CACHE.prefix + 'reportAt-' + point.id)) || 0; } catch (e) { /* без хранилища решит сервер */ }
  var next = last + REPORTS.intervalMs;
  return next > Date.now() ? next : 0;
}

/** Темно ли сейчас у точки — по тому же порогу, что у сервера и у вердикта. */
function reportDark(point) {
  return solarAltitude(new Date(), point.lat, point.lon) <= DARK_USABLE;
}

/** Текст сводки: у своей точки подробно, у остальных — списком. */
function reportsSummaryText(data, point) {
  var mine = data.points[point.id];
  var parts = [];
  if (mine && mine.count) {
    var devices = mine.devices || mine.count;
    parts.push(reportsConfirmed(mine)
      ? t('reports.confirmed', { name: pointName(point), devices: t('reports.devices', { n: devices }) })
      : t('reports.unconfirmed', { name: pointName(point), n: mine.count, need: REPORTS.confirm }));
    parts.push((mine.bright ? t('reports.bright', { n: mine.bright }) + ' ' : '') +
      t('reports.last', { time: fmtTime(new Date(mine.last)) }));
  }
  var others = POINTS.filter(function (p) { return p.id !== point.id && data.points[p.id] && data.points[p.id].count; })
    .map(function (p) { return t('reports.other', { name: pointName(p), n: data.points[p.id].count }); });
  if (others.length) parts.push(t(mine && mine.count ? 'reports.also' : 'reports.elsewhere', { list: others.join(t('sep.list')) }));
  if (!parts.length) parts.push(t('reports.none', { minutes: data.window || 60 }));
  return parts.join(' ');
}

function renderReports() {
  var card = $('reports-card');
  if (!card) return;
  card.hidden = !reportsEnabled();
  if (card.hidden) return;

  var point = pushPoint();   // своё место — у ближайшей точки области
  var summary = $('reports-summary');
  var r = state.reports;
  if (r && r.data) {
    summary.textContent = reportsSummaryText(r.data, point);
    var here = r.data.points[point.id];
    // Зелёным карточка становится, только когда сияние подтверждено разными устройствами.
    setTone(card, reportsConfirmed(here) ? TONE.ok : null);
  } else {
    summary.textContent = r && r.error ? t('reports.error') : t('reports.loading');
  }

  var btn = $('report-btn');
  var dark = reportDark(point);
  var again = reportAgainAt(point);
  btn.disabled = !dark || !!again || state.reportBusy;
  $('report-note').textContent = !dark ? t('reports.not_dark')
    : again ? t('reports.again', { time: fmtTime(new Date(again)) })
    : currentPoint().custom ? t('reports.custom', { name: pointName(point) })
    : '';
  if (btn.disabled) $('report-choice').hidden = true;
}

function setReportStatus(key, params) {
  $('report-status').textContent = key ? t(key, params) : '';
}

/** Отправка отметки; strength — faint | bright. */
function sendReport(strength) {
  var point = pushPoint();
  state.reportBusy = true;
  $('report-choice').hidden = true;
  setReportStatus('reports.sending');
  renderReports();
  var body = { point: point.id, strength: strength };
  var device = reportDevice();
  if (device) body.device = device;
  return pushRequest('/report', body)
    .then(function () {
      try { localStorage.setItem(CACHE.prefix + 'reportAt-' + point.id, String(Date.now())); } catch (e) { /* решит сервер */ }
      setReportStatus('reports.thanks');
      return loadReports(true);
    }, function (err) {
      var code = err && err.code;
      setReportStatus(code === 'too_often' || code === 'too_many' ? 'reports.err.often'
        : code === 'not_dark' ? 'reports.not_dark'
        : 'reports.err.send');
    })
    .then(function () {
      state.reportBusy = false;
      renderReports();
    });
}

function initReports() {
  if (!$('reports-card')) return;
  $('report-btn').addEventListener('click', function () {
    var choice = $('report-choice');
    choice.hidden = !choice.hidden;
    setReportStatus(null);
  });
  $('report-choice').addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-strength]') : null;
    if (btn) sendReport(btn.getAttribute('data-strength'));
  });
  renderReports();
}
