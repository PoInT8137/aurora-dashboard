// Точка входа Cloudflare Worker. Главный модуль может экспортировать только
// обработчики (иначе среда выполнения не запускается), поэтому вся логика —
// в api.js и check.js, а здесь только связка с расписанием и HTTP.
import { handleRequest } from './api.js';
import { runCheck, refreshOvation, OVATION_CRON } from './check.js';
import { recordWorkerError } from './bugs.js';

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      // Непойманный сбой запроса — в журнал ошибок (владелец узнает в Telegram).
      console.error('запрос не обработан: ' + (error && error.message));
      ctx.waitUntil(recordWorkerError(env, 'запрос ' + new URL(request.url).pathname, error));
      return new Response(JSON.stringify({ error: 'internal' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  },

  scheduled(event, env, ctx) {
    // Своё расписание у OVATION: свежая копия для следующего прохода, без проверки и рассылки.
    if (event && event.cron === OVATION_CRON) {
      ctx.waitUntil(refreshOvation(env).then(
        r => console.log('ovation: ' + r),
        error => console.error('ovation не обновлён: ' + (error && error.message))
      ));
      return;
    }
    ctx.waitUntil(runCheck(env).then(
      summary => console.log('проверка: ' + JSON.stringify(summary)),
      error => {
        console.error('проверка не удалась: ' + (error && error.message));
        return recordWorkerError(env, 'проверка по расписанию', error);
      }
    ));
  }
};
