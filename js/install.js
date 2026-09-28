/* Подсказка «Добавьте на экран „Домой“».
   Часть приложения: общие переменные и функции — глобальные, порядок подключения задан
   в index.html (см. js/README.md). */
'use strict';

/* ------------------------------------------------------------------ */
/*  Когда показывать: со второго визита (в первый и так идёт заставка),  */
/*  через несколько секунд после открытия, не в установленном           */
/*  приложении и не чаще раза в 30 дней после «Не сейчас».               */
/*  iPhone: инструкция «Поделиться → На экран „Домой“» — кнопки          */
/*  установки Safari не даёт. Chrome/Android: кнопка «Установить»        */
/*  вызывает системное окно (beforeinstallprompt). Остальные браузеры    */
/*  установить сайт не умеют — подсказки нет.                            */
/* ------------------------------------------------------------------ */

var INSTALL = {
  key: 'aurora.install',          // мс, когда нажали «Не сейчас» или установили
  pauseMs: 30 * 24 * 3600 * 1000,
  delayMs: 3000
};

var installPrompt = null;         // событие beforeinstallprompt, пока браузер разрешает установку

function installDismissedAt() {
  try {
    return Number(localStorage.getItem(INSTALL.key)) || 0;
  } catch (e) {
    return 0;
  }
}

function rememberInstallDismissed() {
  try {
    localStorage.setItem(INSTALL.key, String(Date.now()));
  } catch (e) { /* без хранилища подсказка просто покажется снова */ }
}

/**
 * Как предложить установку: 'ios' — инструкция, 'prompt' — кнопка «Установить», null — не
 * предлагать. firstVisit — сейчас показывается заставка первого визита.
 */
function installMode(env) {
  if (env.standalone || env.firstVisit) return null;
  if (env.dismissedAt && env.now - env.dismissedAt < INSTALL.pauseMs) return null;
  if (env.ios) return 'ios';
  return env.canPrompt ? 'prompt' : null;
}

function installEnv() {
  return {
    standalone: isStandalone(),
    firstVisit: document.documentElement.classList.contains('has-splash'),
    dismissedAt: installDismissedAt(),
    now: Date.now(),
    ios: isIOS(),
    canPrompt: !!installPrompt
  };
}

function showInstallHint() {
  var mode = installMode(installEnv());
  var box = $('install');
  if (!mode || !box || !box.hidden) return;
  box.setAttribute('data-mode', mode);
  $('install-text').textContent = t(mode === 'ios' ? 'install.ios' : 'install.text');
  $('install-go').hidden = mode !== 'prompt';
  box.hidden = false;
}

function hideInstallHint(remember) {
  $('install').hidden = true;
  if (remember) rememberInstallDismissed();
}

// Слушаем сразу при загрузке файла: браузер может прислать событие раньше init().
window.addEventListener('beforeinstallprompt', function (e) {
  // Своя подсказка вместо мини-панели браузера: показываем её, когда решим сами.
  e.preventDefault();
  installPrompt = e;
});
window.addEventListener('appinstalled', function () {
  installPrompt = null;
  if ($('install')) hideInstallHint(true);
});

function initInstallHint() {
  var box = $('install');
  if (!box) return;

  $('install-later').addEventListener('click', function () { hideInstallHint(true); });
  $('install-go').addEventListener('click', function () {
    if (!installPrompt) { hideInstallHint(false); return; }
    var prompt = installPrompt;
    installPrompt = null;   // событие одноразовое
    prompt.prompt();
    hideInstallHint(false);
    if (prompt.userChoice) {
      prompt.userChoice.then(function (choice) {
        // Отказались в системном окне — тоже не надоедаем месяц.
        if (choice && choice.outcome === 'dismissed') rememberInstallDismissed();
      }, function () {});
    }
  });

  setTimeout(showInstallHint, INSTALL.delayMs);
}
