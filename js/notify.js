/* Уведомления: страницы, проверка работоспособности, уведомления с сервера (интерфейс; подписка — в push.js).
   Часть приложения: общие переменные и функции — глобальные, порядок подключения задан
   в index.html (см. js/README.md). */
'use strict';

/* ------------------------------------------------------------------ */
/*  Уведомления о высоком шансе                                        */
/*                                                                     */
/*  У сайта нет сервера push-уведомлений, поэтому закрытая страница     */
/*  проснуться не может: уведомления работают, пока приложение открыто  */
/*  — во вкладке, в том числе фоновой, или в установленном окне.        */
/*  Проверка идёт на каждом пересчёте вердикта, то есть при             */
/*  автообновлении раз в 5 минут.                                       */
/* ------------------------------------------------------------------ */

/*
 * Суббури идут волнами с интервалом в 2–3 часа. Уведомление на каждую
 * волну было бы шумом, но новый эпизод позже ночью заслуживает сигнала.
 */
var NOTIFY_COOLDOWN_MS = 3 * 60 * 60 * 1000;

function notifySupported() {
  return 'Notification' in window;
}

function notifyEnabled() {
  try {
    return localStorage.getItem(CACHE.prefix + 'notify') === 'on';
  } catch (e) {
    return false;
  }
}

function setNotifyEnabled(on) {
  try {
    localStorage.setItem(CACHE.prefix + 'notify', on ? 'on' : 'off');
  } catch (e) { /* без хранилища включение не переживёт перезагрузку */ }
}

/** Время последнего уведомления по точке — хранится, чтобы пережить перезагрузку. */
function lastNotifiedAt(pointId) {
  try {
    return Number(localStorage.getItem(CACHE.prefix + 'notified.' + pointId)) || 0;
  } catch (e) {
    return 0;
  }
}

function markNotified(pointId) {
  try {
    localStorage.setItem(CACHE.prefix + 'notified.' + pointId, String(Date.now()));
  } catch (e) { /* в худшем случае уведомление повторится после перезагрузки */ }
}

/**
 * Показ через service worker: на Android конструктор new Notification()
 * не работает вовсе. Если воркера нет — обычный конструктор.
 */
function showAppNotification(title, options) {
  options.icon = new URL('icons/icon-192.png', location.href).href;
  options.badge = options.icon;
  options.lang = langInfo().html;
  options.data = { url: location.href.split('#')[0] + '#now' };

  // Результат — каким способом показали; ошибка — если не получилось никак.
  // Вкладке «Уведомления» это нужно, чтобы сказать человеку, что сломалось.
  var direct = function () {
    new Notification(title, options);
    return 'direct';
  };

  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    return navigator.serviceWorker.ready
      .then(function (reg) { return reg.showNotification(title, options); })
      .then(function () { return 'sw'; }, direct);
  }
  return new Promise(function (resolve) { resolve(direct()); });
}

function ignore() { /* результат не нужен, а необработанный отказ шумел бы в консоли */ }

/**
 * Вызывается при каждом пересчёте вердикта. Шлёт уведомление при переходе
 * выбранной точки в «Высокий», соблюдая все ограничения ниже.
 */
function checkHighChance(verdict) {
  // По сохранённым данным не будим: устаревший «высокий» — не повод. Такой
  // расчёт не становится и точкой отсчёта — ею служит первый свежий.
  if (!verdict || verdict.stale) return;

  var point = currentPoint();
  var prev = state.lastLevel;
  state.lastLevel = { pointId: point.id, level: verdict.level };

  if (verdict.level !== 'high') return;
  // Первый свежий расчёт после открытия или смены точки — только точка
  // отсчёта: высокий шанс и так на экране.
  if (!prev || prev.pointId !== point.id) return;
  // Шанс уже был высоким — о нём уже сообщили или он был на экране.
  if (prev.level === 'high') return;

  if (!notifySupported() || !notifyEnabled() || Notification.permission !== 'granted') return;
  // Уведомления с сервера включены — они придут и без страницы; свои не дублируем.
  if (pushIsActive()) return;
  // Вкладка в фокусе — вердикт и так перед глазами.
  if (document.hasFocus()) return;
  // Тихие часы: не беспокоим, этот переход пропускается.
  if (inQuietNow()) return;
  if (Date.now() - lastNotifiedAt(point.id) < NOTIFY_COOLDOWN_MS) return;

  markNotified(point.id);
  showAppNotification(t('notif.high.title', { name: pointName(point) }), {
    body: t('notif.high.body', { factors: verdict.factors.slice(0, 3).join(t('sep.dot')) }),
    tag: 'aurora-high-' + point.id  // новое уведомление по точке заменяет старое
  }).catch(ignore);
}

/** Разрешение: современный вариант с промисом и старый с колбэком (Safari). */
function askNotificationPermission() {
  return new Promise(function (resolve) {
    var result = Notification.requestPermission(resolve);
    if (result && result.then) result.then(resolve);
  });
}

function renderNotifyControl() {
  var btn = $('notify-btn');
  var hint = $('notify-hint');

  if (!notifySupported()) {
    btn.hidden = true;
    hint.textContent = t('notify.unsupported');
    return;
  }

  btn.hidden = false;
  var permission = Notification.permission;
  var on = notifyEnabled() && permission === 'granted';

  btn.disabled = (permission === 'denied');
  btn.setAttribute('aria-pressed', String(on));
  btn.textContent = t(on ? 'notify.btn.on' : 'notify.btn.off');

  if (permission === 'denied') {
    hint.textContent = t('notify.hint.denied');
  } else if (pushIsActive()) {
    hint.textContent = t('notify.hint.server');
  } else if (on) {
    hint.textContent = t('notify.hint.on');
  } else {
    hint.textContent = t('notify.hint.off');
  }
}

function initNotifications() {
  renderNotifyControl();

  $('notify-btn').addEventListener('click', function () {
    if (notifyEnabled() && Notification.permission === 'granted') {
      setNotifyEnabled(false);
      renderNotifyControl();
      renderNotifyDiagnostics();
      return;
    }

    askNotificationPermission().then(function (permission) {
      if (permission === 'granted') {
        setNotifyEnabled(true);
        // Пробное уведомление: сразу видно, что система их пропускает.
        showAppNotification(t('notif.enabled.title'), {
          body: t('notif.enabled.body', { name: pointName(currentPoint()) }),
          tag: 'aurora-test'
        }).catch(ignore);
      }
      renderNotifyControl();
      renderNotifyDiagnostics();
    });
  });
}

/* ------------------------------------------------------------------ */
/*  Вкладка «Уведомления»: проверка работоспособности                  */
/* ------------------------------------------------------------------ */

var CHECK_MARKS = {
  ok:   { mark: '✓', tone: TONE.ok,  label: 'check.ok' },
  warn: { mark: '!', tone: TONE.mid, label: 'check.warn' },
  fail: { mark: '✕', tone: TONE.bad, label: 'check.fail' }
};

function isStandalone() {
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    window.navigator.standalone === true;
}

function isIOS() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** Список проверок: что должно сойтись, чтобы уведомление дошло. */
function notifyChecks() {
  var checks = [];
  var supported = notifySupported();
  var permission = supported ? Notification.permission : null;
  var place = pointName(currentPoint());

  checks.push(supported
    ? { state: 'ok', title: t('chk.support.ok') }
    : { state: 'fail', title: t('chk.support.fail'),
        detail: t(isIOS() ? 'chk.support.fail.ios' : 'chk.support.fail.other') });

  if (supported) {
    if (permission === 'granted') {
      checks.push({ state: 'ok', title: t('chk.perm.granted') });
    } else if (permission === 'denied') {
      checks.push({ state: 'fail', title: t('chk.perm.denied'), detail: t('chk.perm.denied.d') });
    } else {
      checks.push({ state: 'warn', title: t('chk.perm.default'), detail: t('chk.perm.default.d') });
    }
  }

  var sw = 'serviceWorker' in navigator;
  var controlled = sw && !!navigator.serviceWorker.controller;
  checks.push(controlled
    ? { state: 'ok', title: t('chk.sw.ok') }
    : { state: 'warn', title: t(sw ? 'chk.sw.inactive' : 'chk.sw.missing'),
        detail: t(sw ? 'chk.sw.inactive.d' : 'chk.sw.missing.d') });

  var on = notifyEnabled() && permission === 'granted';
  checks.push({
    state: on ? 'ok' : 'warn',
    title: t(on ? 'chk.alerts.on' : 'chk.alerts.off'),
    detail: on ? t('chk.alerts.on.d', { name: place })
         : permission === 'denied' ? t('chk.alerts.off.denied')
         : t('chk.alerts.off.d'),
    toggle: supported && permission !== 'denied' ? t(on ? 'chk.alerts.turn_off' : 'chk.alerts.turn_on') : null
  });

  if (pushConfigured()) {
    var serverOn = pushIsActive();
    checks.push(pushSupported()
      ? { state: 'ok', title: t('chk.push.ok') }
      : { state: 'fail', title: t('chk.push.fail'), detail: t('chk.push.fail.d') });

    checks.push(serverOn
      ? { state: 'ok', title: t('chk.sub.on'), detail: t('chk.sub.on.d', { name: place }) }
      : { state: 'warn', title: t('chk.sub.off'), detail: t('chk.sub.off.d') });

    checks.push(state.pushHealth === true
      ? serverCheck(state.pushServer)
      : state.pushHealth === false
        ? { state: 'fail', title: t('chk.server.fail'), detail: t('chk.server.fail.d') }
        : { state: 'warn', title: t('chk.server.pending') });
  }

  if (isIOS() && !isStandalone()) {
    checks.push({ state: 'fail', title: t('chk.mode.ios'), detail: t('chk.mode.ios.d') });
  } else {
    checks.push(isStandalone()
      ? { state: 'ok', title: t('chk.mode.app') }
      : { state: 'ok', title: t('chk.mode.tab'), detail: t('chk.mode.tab.d') });
  }

  return checks;
}

function renderNotifyDiagnostics() {
  var list = $('ntest-checks');
  if (!list) return;
  list.innerHTML = '';

  notifyChecks().forEach(function (check) {
    var look = CHECK_MARKS[check.state];
    var li = document.createElement('li');
    li.className = 'check';

    var mark = document.createElement('span');
    mark.className = 'check__mark';
    mark.textContent = look.mark;
    mark.setAttribute('aria-label', t(look.label));
    setTone(mark, look.tone);

    var title = document.createElement('span');
    title.className = 'check__title';
    title.textContent = check.title;

    li.appendChild(mark);
    li.appendChild(title);

    if (check.toggle) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn--ghost btn--mini';
      btn.textContent = check.toggle;
      btn.addEventListener('click', function () { $('notify-btn').click(); });
      li.appendChild(btn);
    }

    if (check.detail) {
      var detail = document.createElement('span');
      detail.className = 'check__detail';
      detail.textContent = check.detail;
      li.appendChild(detail);
    }

    list.appendChild(li);
  });

  var denied = notifySupported() && Notification.permission === 'denied';
  $('ntest-now').disabled = !notifySupported() || denied;
  $('ntest-later').disabled = !notifySupported() || denied;

  renderPushCard();
}

function setTestStatus(text, tone) {
  var el = $('ntest-status');
  el.textContent = text;
  setTone(el, tone || null);
}

/** Пробное уведомление: сейчас или с задержкой, чтобы успеть свернуть приложение. */
function sendTestNotification(delayMs) {
  if (!notifySupported()) return;

  var permissionReady = Notification.permission === 'granted'
    ? Promise.resolve('granted')
    : askNotificationPermission();

  permissionReady.then(function (permission) {
    renderNotifyDiagnostics();
    renderNotifyControl();

    if (permission !== 'granted') {
      setTestStatus(t('ntest.denied'), TONE.bad);
      return;
    }

    var send = function () {
      showAppNotification(t('notif.test.title'), {
        body: t('notif.test.body', { name: pointName(currentPoint()) }),
        tag: 'aurora-test'
      }).then(function (how) {
        setTestStatus(t('ntest.sent', {
          time: new Date().toLocaleTimeString(langLocale(), { timeZone: displayZone(), hourCycle: clockCycle() }),
          how: t('how.' + how)
        }), TONE.ok);
      }, function (err) {
        setTestStatus(t('ntest.failed', { reason: (err && err.message) || err }), TONE.bad);
      });
    };

    if (delayMs) {
      var seconds = Math.round(delayMs / 1000);
      setTestStatus(t('ntest.later', { sec: t('unit.seconds', { n: seconds }) }), TONE.mid);
      setTimeout(send, delayMs);
    } else {
      send();
    }
  });
}

function initNotifyTab() {
  $('ntest-now').addEventListener('click', function () { sendTestNotification(0); });
  $('ntest-later').addEventListener('click', function () { sendTestNotification(10000); });

  // Разрешение могли поменять в настройках браузера — следим, где это возможно.
  try {
    navigator.permissions.query({ name: 'notifications' }).then(function (status) {
      status.onchange = function () {
        renderNotifyDiagnostics();
        renderNotifyControl();
      };
    }, ignore);
  } catch (e) { /* API разрешений нет — обновим при возврате на вкладку */ }

  renderNotifyDiagnostics();
}

/* ------------------------------------------------------------------ */
/*  Уведомления с сервера (при закрытом приложении)                    */
/*  Подписка и обращения к серверу — в push.js, здесь только интерфейс. */
/* ------------------------------------------------------------------ */

/** Ошибка подписки или обращения к серверу — человеческим языком. */
function pushErrorText(error) {
  // У DOMException поле code числовое (у AbortError это 20), а наши коды — строки.
  var code = (error && typeof error.code === 'string') ? error.code : '';
  var name = error && error.name;

  if (code.indexOf('permission_') === 0 || name === 'NotAllowedError') return t('push.err.permission');
  if (name === 'AbortError' && !code) {
    // Chrome в режиме инкогнито отклоняет подписку так же, как при сбое сети, и определить
    // приватный режим сайт не может (намеренно), поэтому называем оба возможных объяснения.
    return t('push.err.abort');
  }
  if (code === 'subscribe_timeout') return t('push.err.subscribe_timeout');
  if (code === 'no_service_worker') return t('push.err.no_service_worker');
  if (code === 'limit') return t('push.err.limit');
  if (code === 'too_often') return t('push.err.too_often');
  if (code === 'not_subscribed') return t('push.err.not_subscribed');
  // По имени, а не instanceof: ошибка из другого окружения (iframe, воркер) под instanceof не подойдёт.
  if (name === 'TypeError' || name === 'AbortError') return t('push.err.unreachable');
  return t('push.err.generic', { reason: (error && error.message) || error });
}

function setPushStatus(text, tone) {
  var el = $('push-status');
  el.textContent = text;
  setTone(el, tone || null);
}

function renderPushCard() {
  var card = $('push-card');
  if (!card) return;

  if (!pushConfigured()) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  var supported = pushSupported();
  var permission = notifySupported() ? Notification.permission : 'denied';
  var active = pushIsActive();
  var busy = !!state.pushBusy;

  var toggle = $('push-toggle');
  toggle.textContent = t(active ? 'push.toggle.off' : 'push.toggle.on');
  toggle.setAttribute('aria-pressed', String(active));
  toggle.disabled = busy || !supported || (permission === 'denied' && !active);
  $('push-test').disabled = busy || !active;
  $('push-test-later').disabled = busy || !active;

  var hint = $('push-hint');
  if (!supported) {
    hint.textContent = t((isIOS() && !isStandalone()) ? 'push.hint.ios' : 'push.hint.unsupported');
  } else if (permission === 'denied' && !active) {
    hint.textContent = t('push.hint.denied');
  } else if (active) {
    hint.textContent = t('push.hint.on', { name: pointName(currentPoint()) });
  } else {
    hint.textContent = t('push.hint.off', { name: pointName(currentPoint()) });
  }
}

/** Операция с индикацией: блокирует кнопки, пишет статус, ошибку показывает человеку. */
function runPushAction(label, action, done) {
  state.pushBusy = true;
  renderPushCard();
  setPushStatus(label, TONE.mid);

  return action().then(function (result) {
    state.pushBusy = false;
    done(result);
    renderPushCard();
    renderNotifyControl();
    renderNotifyDiagnostics();
  }, function (error) {
    state.pushBusy = false;
    setPushStatus(pushErrorText(error), TONE.bad);
    renderPushCard();
    renderNotifyDiagnostics();
  }).catch(function (unexpected) {
    // Страховка: ошибка в самом обработчике не должна оставлять кнопки
    // заблокированными, а статус — застрявшим на «Включаем…».
    state.pushBusy = false;
    setPushStatus(t('push.err.generic', { reason: (unexpected && unexpected.message) || unexpected }), TONE.bad);
    renderPushCard();
  });
}

/* Проверка по расписанию идёт раз в 10 минут: три пропуска подряд — уже не случайность. */
var HEARTBEAT_STALE_MS = 30 * 60 * 1000;

/** Строка проверки «сервер отвечает» с пульсом: когда он последний раз проверял условия. */
function serverCheck(server) {
  var last = server && server.lastCheck;
  if (!last) return { state: 'ok', title: t('chk.server.ok') };   // сервер старой версии — пульса нет

  var age = Math.max(0, Date.now() - last);
  if (age > HEARTBEAT_STALE_MS) {
    return { state: 'warn', title: t('chk.server.stale'), detail: t('chk.server.stale.d', { ago: fmtAge(age) }) };
  }
  var detail = t('chk.server.checked', { ago: fmtAge(age) });
  var outcome = server.outcome;
  if (outcome === 'no_kp' || outcome === 'no_cloud' || outcome === 'error') detail += t('sep.sentence') + t('chk.server.outcome.' + outcome);
  return { state: 'ok', title: t('chk.server.ok'), detail: detail };
}

/** Пульс в карточке уведомлений с сервера — одной строкой. */
function renderPushHeartbeat() {
  var el = $('push-heartbeat');
  if (!el) return;
  var last = state.pushServer && state.pushServer.lastCheck;
  el.textContent = last ? t('push.heartbeat', { ago: fmtAge(Math.max(0, Date.now() - last)) }) : '';
}

function refreshPushHealth() {
  if (!pushConfigured()) return;
  state.pushHealth = null;
  renderNotifyDiagnostics();
  pushStatus().then(function (status) {
    state.pushHealth = status.ok;
    state.pushServer = status;
    renderNotifyDiagnostics();
    renderPushHeartbeat();
  });
}

function initPushCard() {
  $('push-toggle').addEventListener('click', function () {
    if (pushIsActive()) {
      runPushAction(t('push.busy.off'), pushUnsubscribe, function () {
        setPushStatus(t('push.done.off'));
      });
    } else {
      runPushAction(t('push.busy.on'), function () { return pushSubscribe(currentPoint().id); }, function () {
        setPushStatus(t('push.done.on'), TONE.ok);
      });
    }
  });

  $('push-test').addEventListener('click', function () {
    runPushAction(t('push.busy.test'), function () { return pushTest(0); }, function (result) {
      if (result && result.ok) setPushStatus(t('push.done.test_ok'), TONE.ok);
      else setPushStatus(t('push.done.test_rejected', { status: result && result.status }), TONE.bad);
    });
  });

  $('push-test-later').addEventListener('click', function () {
    runPushAction(t('push.busy.later'), function () { return pushTest(20); }, function () {
      setPushStatus(t('push.done.later'), TONE.mid);
    });
  });

  renderPushCard();

  // Разрешение или подписку могли поменять вне приложения — сверяемся при открытии.
  pushSync(currentPoint().id).then(function () {
    renderPushCard();
    renderNotifyControl();
    renderNotifyDiagnostics();
  });
}
