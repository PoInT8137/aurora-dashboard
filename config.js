/* Настройки развёртывания. Файл читают и страница, и service worker.
 *
 * pushApi        — адрес сервера уведомлений (worker/), без завершающего «/».
 * vapidPublicKey — открытый ключ VAPID (base64url), тот же, что VAPID_PUBLIC
 *                  в worker/wrangler.toml.
 *
 * Пока хотя бы одно значение пустое, «уведомления при закрытом приложении»
 * в интерфейсе скрыты, а всё остальное работает как раньше.
 */
var AURORA_CONFIG = {
  pushApi: 'https://aurora-push.aurora-murmansk.workers.dev',
  vapidPublicKey: 'BIf53FBOesY08hzxQbzCYoZhtZMzNlPAiYKbOKBamvifzu-V305wdH74jysaERFMF36bB2DB6mqne8n55y7pmaw'
};
