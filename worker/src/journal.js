// Журнал проходов: что сервер видел и решил по каждой точке раз в 10 минут, и сколько уведомлений
// ушло. Без него на вопрос «уведомление пришло рано или поздно?» нечем ответить: point_state
// хранит только текущий уровень, а отметки «Вижу сияние» живут сутки.
//
// Строка на точку за проход: признаки активности (Kp, Kp за час, Hp30 и его задержка, OVATION,
// Bz), облачность, высота Солнца, баллы, итоговый уровень, по какому признаку он получен,
// отметки очевидцев за последний час и число отправленных уведомлений по видам. Около тысячи
// строк в сутки; хранятся JOURNAL_KEEP_DAYS дней.
//
// Владелец видит сверку в боте (/timing): по ночам и точкам — когда начался «высокий», когда ушло
// первое уведомление, когда появились первые отметки очевидцев и на сколько уведомление
// опередило их или опоздало.

const DAY_MS = 24 * 60 * 60 * 1000;
const MSK_MS = 3 * 60 * 60 * 1000;     // Мурманск — UTC+3 круглый год
export const JOURNAL_KEEP_DAYS = 90;
export const TIMING_NIGHTS = 14;

const round = (v, digits = 2) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10 ** digits) / 10 ** digits : null);

/** Счётчики отправок по точкам за проход: summary.byPoint[id] = { high, bz, other }. */
export function tally(summary, pointId, kind, n = 1) {
  if (!summary.byPoint) summary.byPoint = {};
  const row = summary.byPoint[pointId] || (summary.byPoint[pointId] = { high: 0, bz: 0, other: 0 });
  row[kind] += n;
}

/** Строка журнала по точке. e — то, что проход знает о точке (см. checkOnce в check.js). */
export function journalStatement(env, nowMs, e, sent) {
  const s = sent || { high: 0, bz: 0, other: 0 };
  return env.DB.prepare(
    'INSERT OR REPLACE INTO alert_log(at, point, level, ks, cs, source, kp, kp_hour, hp30, hp30_age, ovation, ' +
    'bz, bz_level, cloud, alt, seen, sent_high, sent_bz, sent_other) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    nowMs, e.point, e.level, e.ks ?? null, e.cs ?? null, e.by ?? null,
    round(e.kp), round(e.kpHour), round(e.hp30, 3), e.hp30Age ?? null, round(e.ovation, 0),
    round(e.bz, 1), e.bzLevel ?? null, e.cloud ?? null, round(e.alt, 1), e.seen || 0,
    s.high, s.bz, s.other
  );
}

/** Уборка старых строк — в том же пакете, что и запись прохода. */
export function purgeJournalStatement(env, nowMs) {
  return env.DB.prepare('DELETE FROM alert_log WHERE at < ?').bind(nowMs - JOURNAL_KEEP_DAYS * DAY_MS);
}

/** «Ночь» — дата вечера по Москве: всё от полудня до полудня следующего дня. */
export const nightOf = ms => new Date(ms + MSK_MS - 12 * 60 * 60 * 1000).toISOString().slice(0, 10);

const hhmm = ms => new Date(ms + MSK_MS).toISOString().slice(11, 16);
const ddmm = night => night.slice(8, 10) + '.' + night.slice(5, 7);

/**
 * По ночам и точкам: первый «высокий», первое уведомление о высоком шансе, первый ранний сигнал
 * Bz, первые отметки очевидцев. Считается в базе — в боте у запроса те же 10 мс процессора.
 */
export async function timingRows(env, nowMs, nights = TIMING_NIGHTS) {
  const { results } = await env.DB.prepare(
    'SELECT night, point, ' +
    "MIN(CASE WHEN level = 'high' THEN at END) AS first_high, " +
    'MIN(CASE WHEN sent_high > 0 THEN at END) AS first_alert, ' +
    'MIN(CASE WHEN sent_bz > 0 THEN at END) AS first_bz, ' +
    'MIN(CASE WHEN seen > 0 THEN at END) AS first_seen, ' +
    'MAX(CASE WHEN seen > 0 THEN at END) AS last_seen, ' +
    'SUM(sent_high) AS alerts ' +
    "FROM (SELECT *, date(at / 1000 + 3 * 3600 - 12 * 3600, 'unixepoch') AS night FROM alert_log WHERE at > ?) " +
    'GROUP BY night, point ' +
    'HAVING first_high IS NOT NULL OR first_seen IS NOT NULL OR first_bz IS NOT NULL ' +
    'ORDER BY night DESC, point'
  ).bind(nowMs - nights * DAY_MS).all();
  return results;
}

/**
 * Итог сверки по строкам timingRows: сколько ночей с очевидцами, сколько раз уведомление пришло
 * раньше них и позже (медиана в минутах), сколько пропущено, сколько «высоких» без очевидцев.
 */
export function timingSummary(rows) {
  const lead = [], lag = [];
  let seenNights = 0, missed = 0, unconfirmed = 0, lateAfterEnd = 0;
  for (const r of rows) {
    if (r.first_seen) {
      seenNights++;
      if (!r.first_alert) missed++;
      else if (r.first_alert <= r.first_seen) lead.push((r.first_seen - r.first_alert) / 60000);
      else {
        lag.push((r.first_alert - r.first_seen) / 60000);
        // seen — отметки за последний час, так что после last_seen уже час никто не отмечал.
        if (r.last_seen && r.first_alert > r.last_seen) lateAfterEnd++;
      }
    } else if (r.first_high) {
      unconfirmed++;
    }
  }
  const median = list => {
    if (!list.length) return null;
    const s = [...list].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
  };
  return { seenNights, early: lead.length, late: lag.length, missed, unconfirmed, lateAfterEnd,
    medianLead: median(lead), medianLag: median(lag) };
}

/** Текст /timing для владельца. names — id точки → имя. */
export async function timingText(env, nowMs, names = {}) {
  let rows;
  try {
    rows = await timingRows(env, nowMs);
  } catch {
    return 'Журнала проходов ещё нет: нужна миграция базы (таблица alert_log).';
  }
  if (!rows.length) {
    return 'Сверка уведомлений за ' + TIMING_NIGHTS + ' ночей: пока пусто — не было ни «высокого», ни раннего сигнала, ни отметок очевидцев.';
  }
  const s = timingSummary(rows);
  const lines = ['Сверка уведомлений с очевидцами за ' + TIMING_NIGHTS + ' ночей (время московское)', ''];
  if (s.seenNights) {
    lines.push('Ночей с отметками «Вижу сияние»: ' + s.seenNights);
    lines.push('• уведомление раньше очевидцев: ' + s.early + (s.medianLead !== null ? ' (медиана на ' + s.medianLead + ' мин)' : ''));
    lines.push('• позже очевидцев: ' + s.late + (s.medianLag !== null ? ' (медиана на ' + s.medianLag + ' мин)' : '') +
      (s.lateAfterEnd ? ', из них когда отметки уже прекратились (час без отметок): ' + s.lateAfterEnd : ''));
    lines.push('• сияние видели, а уведомления о высоком шансе не было: ' + s.missed);
  } else {
    lines.push('Отметок «Вижу сияние» не было — сравнивать не с чем.');
  }
  lines.push('«Высокий» без отметок очевидцев: ' + s.unconfirmed + ' (это не обязательно ошибка — отмечают немногие)');
  lines.push('');

  for (const r of rows.slice(0, 25)) {
    const parts = [];
    if (r.first_high) parts.push('высокий ' + hhmm(r.first_high));
    if (r.first_alert) parts.push('уведомление ' + hhmm(r.first_alert));
    if (r.first_bz) parts.push('ранний Bz ' + hhmm(r.first_bz));
    if (r.first_seen) parts.push('очевидцы ' + hhmm(r.first_seen) + (r.last_seen && r.last_seen !== r.first_seen ? '–' + hhmm(r.last_seen) : ''));
    let verdict = '';
    if (r.first_seen && r.first_alert) {
      const d = Math.round((r.first_alert - r.first_seen) / 60000);
      verdict = d <= 0 ? ' → раньше на ' + -d + ' мин' : ' → позже на ' + d + ' мин';
    } else if (r.first_seen) {
      verdict = ' → уведомления не было';
    }
    lines.push(ddmm(r.night) + ' ' + (names[r.point] || r.point) + ': ' + parts.join(', ') + verdict);
  }
  if (rows.length > 25) lines.push('… и ещё ' + (rows.length - 25));
  return lines.join('\n');
}
