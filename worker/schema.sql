-- Подписки на уведомления. Хранится только адрес подписки, выбранная точка, язык уведомлений
-- и тихие часы с поясом, по которому они считаются.
CREATE TABLE IF NOT EXISTS subs (
  id        TEXT PRIMARY KEY,           -- SHA-256 адреса подписки, hex
  endpoint  TEXT NOT NULL,              -- адрес push-сервиса браузера (секретный: по нему можно слать push)
  point     TEXT NOT NULL,              -- id точки наблюдения
  lang      TEXT NOT NULL DEFAULT 'ru', -- язык уведомлений: ru | en | zh (выбор на сайте)
  quiet_from INTEGER,                   -- тихие часы: с какого часа (0–23), NULL — не заданы
  quiet_to   INTEGER,                   -- до какого часа, не включая (окно может переходить через полночь)
  tz         TEXT,                      -- пояс IANA, по которому считаются тихие часы
  created   INTEGER NOT NULL,           -- мс; обновляется при смене точки
  last_sent INTEGER NOT NULL DEFAULT 0, -- мс последнего уведомления о сиянии
  last_test INTEGER NOT NULL DEFAULT 0, -- мс последнего пробного уведомления
  fails     INTEGER NOT NULL DEFAULT 0, -- подряд неудачных отправок
  msg       TEXT,                       -- последнее сообщение (JSON), его забирает service worker
  last_bz   INTEGER NOT NULL DEFAULT 0, -- мс последнего раннего сигнала «Bz повернул на юг»
  min_level TEXT NOT NULL DEFAULT 'high', -- о каком шансе сообщать: high | mid (и о среднем)
  sky       INTEGER NOT NULL DEFAULT 0, -- 1 — сообщать, что небо скоро откроется
  last_sky  INTEGER NOT NULL DEFAULT 0  -- мс последнего сигнала «небо откроется»
);

CREATE INDEX IF NOT EXISTS subs_point ON subs(point);

-- Пульс: когда и чем закончилась последняя проверка по расписанию. Одна строка (id = 1).
-- Страница показывает её на вкладке «Настройки»: так видно, что cron не умер молча.
CREATE TABLE IF NOT EXISTS heartbeat (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  at      INTEGER NOT NULL,                 -- мс окончания проверки
  outcome TEXT NOT NULL                     -- ok | no_subs | no_kp | no_cloud | error
);

-- Солнечный ветер между проходами: последний Bz и с какого момента поле южное (≤ −5 нТл).
-- Одна строка (id = 1). По ней сервер видит, что поле держится южным, а не мигнуло (src/bz.js).
CREATE TABLE IF NOT EXISTS sw_state (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  bz          REAL,                     -- нТл; NULL — в прошлый проход данных не было
  at          INTEGER NOT NULL,         -- мс прохода
  south_since INTEGER NOT NULL DEFAULT 0-- мс начала южного поля; 0 — сейчас не южное
);

-- Отметки «Вижу сияние» (src/reports.js): точка, сила, время и обезличенный отправитель —
-- HMAC от адреса и даты, по нему нельзя восстановить адрес. Хранятся сутки.
CREATE TABLE IF NOT EXISTS reports (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  point    TEXT NOT NULL,              -- id точки области
  strength TEXT NOT NULL,              -- faint | bright
  at       INTEGER NOT NULL,           -- мс
  who      TEXT NOT NULL               -- 16 hex HMAC(адрес|сутки)
);

CREATE INDEX IF NOT EXISTS reports_at ON reports(at);
CREATE INDEX IF NOT EXISTS reports_who ON reports(who, at);

-- Проверка прогноза (src/verify.js): вечером — какой шанс обещан на ночь, утром — каким он был.
CREATE TABLE IF NOT EXISTS verify (
  night    TEXT NOT NULL,              -- дата вечера по Москве, 2026-09-24
  point    TEXT NOT NULL,              -- id точки области
  forecast TEXT NOT NULL,              -- high | mid | low — прогноз, записанный вечером
  actual   TEXT,                       -- то же по измеренным данным; NULL — ещё не сверено
  from_ms  INTEGER NOT NULL,           -- начало тёмного отрезка, который оценивался
  PRIMARY KEY (night, point)
);

-- Мониторинг источников (src/monitor.js): что сейчас не работает, с какого момента и когда
-- владельцу последний раз сообщили. Нет строки — источник в порядке.
CREATE TABLE IF NOT EXISTS monitor (
  source      TEXT PRIMARY KEY,         -- noaa_kp | noaa_sw | open_meteo | site
  down_since  INTEGER NOT NULL,         -- мс первой неудачной проверки
  notified_at INTEGER NOT NULL DEFAULT 0, -- мс последнего сообщения владельцу; 0 — ещё не сообщали
  detail      TEXT                      -- что именно не так
);

-- Прошлый уровень вердикта по точке: по нему находится переход в «высокий».
CREATE TABLE IF NOT EXISTS point_state (
  point      TEXT PRIMARY KEY,
  level      TEXT NOT NULL,             -- high | mid | low
  high_since INTEGER NOT NULL DEFAULT 0,-- мс начала текущего «высокого»; 0 — точка отсчёта
  updated    INTEGER NOT NULL,
  mid_since  INTEGER NOT NULL DEFAULT 0 -- мс начала текущего «среднего или выше» (для min_level = mid)
);
