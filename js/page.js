/* Вкладки, вердикт, выбор точки наблюдения, строка статуса и обновление данных.
   Часть приложения: общие переменные и функции — глобальные, порядок подключения задан
   в index.html (см. js/README.md). */
'use strict';

/* ------------------------------------------------------------------ */
/*  Вкладки                                                            */
/* ------------------------------------------------------------------ */

var TAB_IDS = ['now', 'tonight', 'map', 'guide', 'settings'];

/** Вкладка «Уведомления» стала частью «Настроек»: старые ссылки #notify и сохранённый выбор ведут туда. */
function tabFromName(name) {
  return name === 'notify' ? 'settings' : name;
}

function savedTab() {
  try {
    return localStorage.getItem(CACHE.prefix + 'tab');
  } catch (e) {
    return null;
  }
}

function saveTab(id) {
  try {
    localStorage.setItem(CACHE.prefix + 'tab', id);
  } catch (e) { /* выбор просто не переживёт перезагрузку */ }
}

/**
 * На телефоне вкладки листаются вбок: выбранную подвигаем к середине панели.
 * Прокручивается только сама панель — scrollIntoView дёрнул бы и всю страницу.
 */
function revealTab(btn) {
  var bar = $('tabs');
  if (!bar || !bar.scrollTo || bar.scrollWidth <= bar.clientWidth) return;
  var left = btn.offsetLeft - (bar.clientWidth - btn.offsetWidth) / 2;
  bar.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
}

/**
 * historyMode: 'push' — обычное переключение, с записью в историю, чтобы
 * работали «назад/вперёд»; 'replace' — при старте и при исправлении
 * неизвестного хэша, без новой записи.
 */
function showTab(id, historyMode) {
  id = tabFromName(id);
  if (TAB_IDS.indexOf(id) < 0) id = 'now';

  TAB_IDS.forEach(function (tab) {
    $('tab-' + tab).hidden = (tab !== id);
  });

  // Паттерн вкладок WAI-ARIA: в порядке Tab стоит только выбранная вкладка,
  // между вкладками перемещаются стрелками.
  var buttons = $('tabs').querySelectorAll('[role="tab"]');
  Array.prototype.forEach.call(buttons, function (btn) {
    var selected = btn.getAttribute('data-tab') === id;
    btn.setAttribute('aria-selected', String(selected));
    btn.tabIndex = selected ? 0 : -1;
    if (selected) revealTab(btn);
  });

  state.tab = id;
  saveTab(id);
  // Адрес всегда соответствует открытой вкладке — в том числе после #foo.
  if (location.hash !== '#' + id) {
    if (historyMode === 'push') location.hash = '#' + id;
    else history.replaceState(null, '', '#' + id);
  }

  // Данные второй вкладки грузятся при первом открытии, а не при старте.
  // Карта и «Куда ехать» опираются на одни и те же данные по семи точкам.
  if ((id === 'tonight' || id === 'map') && !state.tonight && !state.tonightLoading) loadTonight();
  if (id === 'map') renderMap();
  if (id === 'tonight') loadOutlook(false);
  // Состояние service worker и разрешения могло измениться — показываем актуальное.
  if (id === 'settings') {
    renderNotifyDiagnostics();
    refreshPushHealth();
  }
}

function initTabs() {
  var initial = startTab(tabFromName((location.hash || '').replace('#', '')), tabFromName(savedTab() || 'now'));

  $('tabs').addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-tab]') : null;
    if (btn) showTab(btn.getAttribute('data-tab'), 'push');
  });

  // Стрелки, Home и End переключают вкладки и переводят на них фокус.
  $('tabs').addEventListener('keydown', function (e) {
    var keys = { ArrowRight: 1, ArrowLeft: -1, Home: 'first', End: 'last' };
    if (!(e.key in keys)) return;
    e.preventDefault();

    var index = TAB_IDS.indexOf(state.tab);
    var step = keys[e.key];
    if (step === 'first') index = 0;
    else if (step === 'last') index = TAB_IDS.length - 1;
    else index = (index + step + TAB_IDS.length) % TAB_IDS.length;

    showTab(TAB_IDS[index], 'push');
    $('tab-btn-' + TAB_IDS[index]).focus();
  });

  // Ссылкой с хэшем можно поделиться, работают и кнопки «назад/вперёд».
  window.addEventListener('hashchange', function () {
    showTab((location.hash || '').replace('#', '') || 'now', 'replace');
  });

  showTab(initial, 'replace');
}

/* ------------------------------------------------------------------ */
/*  Вердикт                                                            */
/* ------------------------------------------------------------------ */

function renderVerdict() {
  var v = computeVerdict(state.kp, state.cloud);
  checkHighChance(v);

  if (!v) {
    setState('verdict-card', 'error');
    return;
  }

  setTone($('verdict-card'), v.tone);

  var valueEl = $('verdict-value');
  valueEl.textContent = v.label;
  setTone(valueEl, v.tone);

  $('verdict-hint').textContent = v.hint;

  var list = $('verdict-factors');
  list.innerHTML = '';
  v.factors.forEach(function (text) {
    var li = document.createElement('li');
    li.textContent = text;
    list.appendChild(li);
  });

  // Вердикт устарел настолько, насколько устарел самый старый из его входов.
  var ages = [state.kp, state.cloud]
    .filter(function (item) { return item && item.stale; })
    .map(function (item) { return item.stale; });

  applyFreshness('verdict-card', 'verdict-stale',
    ages.length ? Math.max.apply(null, ages) : null,
    'lead.verdict_saved');
}

/* ------------------------------------------------------------------ */
/*  Оркестрация                                                        */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Селектор точки                                                     */
/* ------------------------------------------------------------------ */

/** «68,97° с. ш.» / «68.97° N» / «北纬68.97°»: слова — в словарях, coord.<сторона>. */
function fmtCoord(value, positive, negative) {
  return t('coord.' + (value >= 0 ? positive : negative), { v: fmtNum(Math.abs(value).toFixed(2)) });
}

/** Подпись под заголовком и название вкладки. */
function renderPointMeta() {
  var point = currentPoint();
  var limits = kpThresholds(point);

  $('point-meta').textContent = t('meta.point', {
    lat: fmtCoord(point.lat, 'n', 's'),
    lon: fmtCoord(point.lon, 'e', 'w'),
    geo: fmtNum(point.geoLat.toFixed(1)),
    kp: fmtKp(limits.low)
  });

  // Название приложения — в <title> и манифесте; во вкладке браузера
  // впереди выбранная точка, чтобы несколько открытых вкладок различались.
  document.title = t('title.point', { name: pointName(point) });
}

function initPointSelect() {
  var select = $('point');

  POINTS.forEach(function (point) {
    var option = document.createElement('option');
    option.value = point.id;
    option.textContent = pointName(point);
    select.appendChild(option);
  });

  state.point = findPoint(savedPointId() || POINTS[0].id);
  select.value = state.point.id;
  renderPointMeta();

  select.addEventListener('change', function () { selectPoint(select.value); });
}

/** Смена точки наблюдения: из выпадающего списка или с карты. */
function selectPoint(id) {
  state.point = findPoint(id);
  savePointId(state.point.id);
  // Серверные уведомления привязаны к точке: подписка переезжает вместе с выбором.
  pushSync(state.point.id).then(function () {
    renderPushCard();
    renderNotifyDiagnostics();
  });
  renderPointMeta();
  renderOvation();
  renderOutlook();

  // Облачность принадлежала прежней точке — её нельзя показывать для новой.
  // Kp и его прогноз планетарные, их при смене города не перезапрашиваем.
  state.cloud = null;
  replaceWithLoading('cloud-card');
  replaceWithLoading('wx-card');
  replaceWithLoading('verdict-card');
  replaceWithLoading('window-card');

  loadCloud().then(function (cloud) {
    if (cloud === null && state.cloudPending) return; // ответ устарел
    renderDerived();
    updateStatus();
  });

  // Если по новой точке есть сохранённые данные, они уже на экране.
  renderDerived();
  renderMap();
}

/** Всё, что считается из уже загруженных данных. */
function renderDerived() {
  // Пока облачность для выбранной точки в пути и показать нечего, вердикт и
  // окно не трогаем: иначе на мгновение показалось бы «облачность: данных нет».
  // Если на экране сохранённые данные этой точки — считаем по ним.
  if (!(state.cloudPending && !state.cloud)) {
    renderVerdict();
    renderWindow();
  }
  // Ночная вкладка опирается на общий прогноз Kp: если он обновился,
  // её оценки надо пересчитать. Но только когда данные уже загружены.
  if (state.tonight) renderTonight();
}

/**
 * Строка статуса в шапке. Запоминаем ключ и момент, а не готовый текст: язык, формат
 * времени и пояс можно сменить, и строка должна пересобраться.
 */
function setStatus(key, at) {
  state.status = { key: key, at: at || null };
  renderStatus();
}

function renderStatus() {
  if (!state.status) return;
  $('updated').textContent = t(state.status.key, state.status.at ? { time: fmtTime(state.status.at) } : undefined);
}

/** Строка статуса в шапке по текущему состоянию данных. */
function updateStatus() {
  // Свежесть определяется флагом stale, а не наличием данных: после отката
  // на кэш в state лежат значения, но «Обновлено» писать про них нельзя.
  var fresh = (state.kp && !state.kp.stale) || (state.cloud && !state.cloud.stale);

  if (fresh) {
    state.lastOk = new Date();
    setStatus('status.updated', state.lastOk);
  } else if (state.kp || state.cloud) {
    setStatus('status.offline_saved');
  } else if (state.lastOk) {
    setStatus('status.offline_last', state.lastOk);
  } else {
    setStatus('status.offline_none');
  }
}

function refreshAll() {
  // Автообновление, кнопка и возврат на вкладку могут совпасть по времени —
  // второе обновление просто присоединяется к идущему.
  if (state.refreshing) return state.refreshing;

  var btn = $('refresh');
  btn.disabled = true;
  setStatus('status.refreshing');
  markLoading('verdict-card');
  markLoading('window-card');

  var tasks = [loadKp(), loadCloud(), loadForecast(), loadSolarWind(), loadOvation(false)];
  if (state.tonight) tasks.push(loadTonight());

  // Загрузчики уже положили на экран сохранённые данные — вердикт и окно
  // считаем по ним сразу, не дожидаясь сети.
  renderDerived();

  state.refreshing = Promise.all(tasks)
    .then(function () {
      renderDerived();
      updateStatus();
    })
    .finally(function () {
      btn.disabled = false;
      state.refreshing = null;
    });

  return state.refreshing;
}
