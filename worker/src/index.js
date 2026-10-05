// Точка входа Cloudflare Worker. Главный модуль может экспортировать только
// обработчики (иначе среда выполнения не запускается), поэтому вся логика —
// в api.js и check.js, а здесь только связка с расписанием и HTTP.
import { handleRequest } from './api.js';
import { runCheck } from './check.js';
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

  scheduled(_event, env, ctx) {
    ctx.waitUntil(runCheck(env).then(
      summary => console.log('проверка: ' + JSON.stringify(summary)),
      error => {
        console.error('проверка не удалась: ' + (error && error.message));
        return recordWorkerError(env, 'проверка по расписанию', error);
      }
    ));
  }
};
