// Точка входа Cloudflare Worker. Главный модуль может экспортировать только
// обработчики (иначе среда выполнения не запускается), поэтому вся логика —
// в api.js и check.js, а здесь только связка с расписанием и HTTP.
import { handleRequest } from './api.js';
import { runCheck } from './check.js';

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },

  scheduled(_event, env, ctx) {
    ctx.waitUntil(runCheck(env).then(
      summary => console.log('проверка: ' + JSON.stringify(summary)),
      error => console.error('проверка не удалась: ' + (error && error.message))
    ));
  }
};
