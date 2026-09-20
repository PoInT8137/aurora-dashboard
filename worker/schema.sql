-- Подписки на уведомления. Хранится только адрес подписки и выбранная точка.
CREATE TABLE IF NOT EXISTS subs (
  id        TEXT PRIMARY KEY,           -- SHA-256 адреса подписки, hex
  endpoint  TEXT NOT NULL,              -- адрес push-сервиса браузера (секретный: по нему можно слать push)
  point     TEXT NOT NULL,              -- id точки наблюдения
  created   INTEGER NOT NULL,           -- мс; обновляется при смене точки
  last_sent INTEGER NOT NULL DEFAULT 0, -- мс последнего уведомления о сиянии
  last_test INTEGER NOT NULL DEFAULT 0, -- мс последнего пробного уведомления
  fails     INTEGER NOT NULL DEFAULT 0, -- подряд неудачных отправок
  msg       TEXT                        -- последнее сообщение (JSON), его забирает service worker
);

CREATE INDEX IF NOT EXISTS subs_point ON subs(point);

-- Прошлый уровень вердикта по точке: по нему находится переход в «высокий».
CREATE TABLE IF NOT EXISTS point_state (
  point      TEXT PRIMARY KEY,
  level      TEXT NOT NULL,             -- high | mid | low
  high_since INTEGER NOT NULL DEFAULT 0,-- мс начала текущего «высокого»; 0 — точка отсчёта
  updated    INTEGER NOT NULL
);
