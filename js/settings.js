/* Настройки отображения и язык интерфейса.
   Часть приложения: общие переменные и функции — глобальные, порядок подключения задан
   в index.html (см. js/README.md). */
'use strict';

/* ------------------------------------------------------------------ */
/*  Настройки отображения                                              */
/*                                                                     */
/*  Хранятся одной записью в localStorage; любое значение, которого нет */
/*  среди допустимых, заменяется значением по умолчанию — испорченная   */
/*  запись не должна ломать страницу. По умолчанию всё как было раньше. */
/* ------------------------------------------------------------------ */

var SETTINGS_DEFAULTS = { tz: 'murmansk', clock: '24', dist: 'km', temp: 'c', refresh: '5',
                          theme: 'dark', size: 'normal', start: 'last', quiet: 'off' };
var SETTINGS_CHOICES = {
  tz: ['murmansk', 'device'],
  clock: ['24', '12'],
  dist: ['km', 'mi'],
  temp: ['c', 'f'],
  refresh: ['5', '10', '30', '0'],  // минуты; 0 — не обновлять само
  theme: ['dark', 'light', 'auto'],
  size: ['normal', 'large', 'xlarge'],
  start: ['last', 'now', 'tonight', 'map'],  // last — вкладка, на которой закрыли
  quiet: ['off', '22-08', '23-07', '00-06']   // часы, когда уведомления о сиянии не присылаются
};

function loadSettings() {
  var saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(CACHE.prefix + 'settings') || '{}') || {};
  } catch (e) { /* нет хранилища или запись испорчена — работаем со значениями по умолчанию */ }

  var out = {};
  Object.keys(SETTINGS_DEFAULTS).forEach(function (name) {
    out[name] = SETTINGS_CHOICES[name].indexOf(saved[name]) >= 0 ? saved[name] : SETTINGS_DEFAULTS[name];
  });
  return out;
}

function saveSettings() {
  try {
    localStorage.setItem(CACHE.prefix + 'settings', JSON.stringify(state.settings));
  } catch (e) { /* без хранилища выбор просто не переживёт перезагрузку */ }
}

function setting(name) {
  if (!state.settings) state.settings = loadSettings();
  return state.settings[name];
}

/** Возвращает true, если значение допустимо и применено. */
function setSetting(name, value) {
  // hasOwnProperty: имя вроде «__proto__» не должно находить чужие свойства объекта.
  if (!Object.prototype.hasOwnProperty.call(SETTINGS_CHOICES, name) || SETTINGS_CHOICES[name].indexOf(value) < 0) return false;
  setting(name);
  state.settings[name] = value;
  saveSettings();
  return true;
}

function resetSettings() {
  state.settings = {};
  Object.keys(SETTINGS_DEFAULTS).forEach(function (name) { state.settings[name] = SETTINGS_DEFAULTS[name]; });
  try {
    localStorage.removeItem(CACHE.prefix + 'settings');
  } catch (e) { /* см. выше */ }
}

/** Тема с учётом «авто»: по настройке системы. */
function resolvedTheme() {
  var theme = setting('theme');
  if (theme !== 'auto') return theme;
  var light = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  return light ? 'light' : 'dark';
}

var THEME_COLORS = { dark: '#060b14', light: '#eef4f8' };

/** Тема и размер текста — атрибутами страницы; цвет строки состояния браузера — в тон теме. */
function applyAppearance() {
  var root = document.documentElement;
  var theme = resolvedTheme();
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-size', setting('size'));

  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[theme]);
}

/** Окно тихих часов {from, to} или null, если выключено. */
function quietWindow() {
  var value = setting('quiet');
  var match = /^(\d\d)-(\d\d)$/.exec(value);
  return match ? { from: Number(match[1]), to: Number(match[2]) } : null;
}

/** Часовой пояс, по которому считаются тихие часы: тот же, что показан на экране. */
function quietZone() {
  return displayZone() || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Сейчас тихие часы? Уведомления страницы в это время не показываются. */
function inQuietNow() {
  var quiet = quietWindow();
  return !!quiet && inQuietHours(new Date(), quietZone(), quiet.from, quiet.to);
}

/**
 * Что страница сообщает серверу уведомлений сверх точки: язык, тихие часы и пояс, по которому
 * они считаются. Вызывается из push.js при подписке и синхронизации.
 */
function pushPreferences() {
  var quiet = quietWindow();
  return { lang: getLang(), quiet: quiet, tz: quietZone() };
}

/** Вкладка при открытии: адрес важнее всего, затем настройка, затем последняя открытая. */
function startTab(fromHash, saved) {
  if (TAB_IDS.indexOf(fromHash) >= 0) return fromHash;
  var choice = setting('start');
  if (choice !== 'last') return choice;
  return TAB_IDS.indexOf(saved) >= 0 ? saved : 'now';
}

/** Период автообновления в мс; 0 — выключено. */
function refreshMs() {
  return Number(setting('refresh')) * 60 * 1000;
}

/**
 * Пора ли обновить данные при возврате на вкладку: только если автообновление включено
 * и с последнего удачного обновления прошло больше его периода. Выключено — только по кнопке.
 */
function refreshDue() {
  var every = refreshMs();
  return every > 0 && (!state.lastOk || Date.now() - state.lastOk.getTime() > every);
}

/** (Пере)запускает автообновление по текущей настройке. */
function armRefresh() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  var every = refreshMs();
  if (every) state.timer = setInterval(refreshAll, every);
}

/** Кнопки настроек: выбранное значение отмечено для скринридеров и для глаз. */
function renderSettings() {
  var groups = document.querySelectorAll('[data-pref]');
  Array.prototype.forEach.call(groups, function (group) {
    var name = group.getAttribute('data-pref');
    Array.prototype.forEach.call(group.querySelectorAll('[data-value]'), function (btn) {
      btn.setAttribute('aria-pressed', String(btn.getAttribute('data-value') === setting(name)));
    });
  });

  // Подписи, которые зависят от настроек: в каком поясе время и как часто идёт обновление.
  var note = $('forecast-note');
  if (note) note.textContent = t('forecast.note', { zone: t('tz.' + setting('tz')) });

  var foot = $('foot-refresh');
  if (foot) {
    var every = refreshMs();
    foot.textContent = every ? t('foot.refresh', { every: t('unit.minutes', { n: every / 60000 }) }) : t('foot.refresh_off');
  }
}

/** Всё, что показано, перерисовывается: единицы и время меняются повсюду. */
/** changed — имя изменённой настройки (или 'reset'): на сервер нужно сообщать только пояс и тихие часы. */
function afterSettingsChange(changed) {
  armRefresh();
  applyAppearance();
  renderLocalized();
  if (changed === 'tz' || changed === 'quiet' || changed === 'reset') {
    pushSync(currentPoint().id).then(renderNotifyDiagnostics);
  }
}

function initSettings() {
  // Тема «авто» следует за системой: переключили — перекрашиваемся.
  try {
    var scheme = window.matchMedia('(prefers-color-scheme: light)');
    if (scheme.addEventListener) scheme.addEventListener('change', applyAppearance);
  } catch (e) { /* без matchMedia остаётся выбор при загрузке */ }

  $('tab-settings').addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-value]') : null;
    var group = btn && btn.closest ? btn.closest('[data-pref]') : null;
    if (!btn || !group) return;
    var name = group.getAttribute('data-pref');
    if (setSetting(name, btn.getAttribute('data-value'))) afterSettingsChange(name);
  });

  $('prefs-reset').addEventListener('click', function () {
    resetSettings();
    afterSettingsChange('reset');
  });
}

/* ------------------------------------------------------------------ */
/*  Язык                                                               */
/* ------------------------------------------------------------------ */

function savedLang() {
  try {
    return localStorage.getItem(CACHE.prefix + 'lang');
  } catch (e) {
    return null;
  }
}

function saveLang(code) {
  try {
    localStorage.setItem(CACHE.prefix + 'lang', code);
  } catch (e) { /* выбор просто не переживёт перезагрузку */ }
}

/** Язык из адреса: ?lang=en. Ссылкой с таким параметром можно поделиться. */
function langFromUrl() {
  var match = /[?&]lang=([a-zA-Z-]+)/.exec(location.search || '');
  return match ? langFromTag(match[1]) : null;
}

/** Кнопки переключателя: выбранный язык отмечен для скринридеров и для глаз. */
function renderLangSwitch() {
  var buttons = document.querySelectorAll('[data-lang]');
  Array.prototype.forEach.call(buttons, function (btn) {
    btn.setAttribute('aria-pressed', String(btn.getAttribute('data-lang') === getLang()));
  });
}

var SITE_URL = 'https://auroramurmansk.ru/';

/**
 * Основной адрес страницы для поисковиков. С ?lang= в адресе — версия на этом языке,
 * без него язык выбирается сам (x-default). Другие параметры адреса на выбор не влияют.
 */
function canonicalUrl(search) {
  var match = /[?&]lang=([a-zA-Z-]+)/.exec(search || '');
  var code = match ? langFromTag(match[1]) : null;
  return code ? SITE_URL + '?lang=' + code : SITE_URL;
}

/**
 * Перерисовывает всё, что зависит от языка: разметку, названия точек, подписи и
 * уже посчитанные карточки. Данные заново не запрашиваются.
 */
function applyLanguage() {
  document.documentElement.setAttribute('lang', langInfo().html);
  i18nApply(document);

  var description = document.querySelector('meta[name="description"]');
  if (description) description.setAttribute('content', t('meta.description'));
  var appTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]');
  if (appTitle) appTitle.setAttribute('content', t('meta.app_title'));
  var canonical = document.querySelector('link[rel="canonical"]');
  if (canonical) canonical.setAttribute('href', canonicalUrl(location.search));

  renderLangSwitch();

  // Сообщения о ходе операции остались бы на прежнем языке — убираем.
  $('ntest-status').textContent = '';
  $('push-status').textContent = '';

  renderLocalized();
}

/** Всё, что зависит от языка и настроек и берётся из уже загруженных данных. */
function renderLocalized() {
  renderSettings();

  // Названия городов в выпадающем списке.
  var select = $('point');
  Array.prototype.forEach.call(select.options || [], function (option) {
    option.textContent = pointName(findPoint(option.value));
  });
  renderPointMeta();
  $('cloud-model').textContent = t('cloud.model', { model: weatherModelLabel() });

  if (state.kp) renderKp(state.kp);
  if (state.cloud) renderCloud(state.cloud);
  if (state.sw) renderSolarWind(state.sw);
  renderOvation();
  renderOutlook();
  renderMap();
  if (state.forecast) renderForecast(state.forecast, state.forecastAge, false);
  renderDerived();

  refreshErrors();
  renderStatus();
  renderNotifyControl();
  renderNotifyDiagnostics();
  renderPushHeartbeat();
}

function initLanguage() {
  var explicit = langFromUrl();
  if (explicit) saveLang(explicit);

  setLang(detectLang(explicit, savedLang(), navigator.languages || [navigator.language]));

  $('lang').addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-lang]') : null;
    if (!btn || btn.getAttribute('data-lang') === getLang()) return;

    setLang(btn.getAttribute('data-lang'));
    saveLang(getLang());
    // ?lang= в адресе перебивал бы сделанный выбор при каждой перезагрузке.
    if (langFromUrl()) history.replaceState(null, '', location.pathname + location.hash);
    applyLanguage();
    // Уведомления с сервера приходят на выбранном языке — сообщаем серверу о смене.
    pushSync(currentPoint().id).then(renderNotifyDiagnostics);
  });
}
