/* «Небо на веб-камерах»: ссылки на камеры, по которым видно, есть ли сияние прямо сейчас.
   Часть приложения: общие переменные и функции — глобальные, порядок подключения задан
   в index.html (см. js/README.md). */
'use strict';

/* ------------------------------------------------------------------ */
/*  Веб-камеры                                                         */
/*                                                                     */
/*  Прогноз говорит, что сияние возможно, камера — что оно есть. Здесь  */
/*  только ссылки, без встраивания снимков: чужие серверы не            */
/*  нагружаются, их условия не нарушаются, а их сбой не ломает страницу. */
/*  Камеры показывают небо у себя — чем ближе к нам, тем полезнее;      */
/*  список отсортирован по расстоянию от Мурманска.                     */
/*                                                                     */
/*  Адреса проверены 26.09.2026: страницы открываются, снимки           */
/*  обновляются раз в несколько минут.                                  */
/* ------------------------------------------------------------------ */

var WEBCAMS = [
  { id: 'teriberka', url: 'https://video.auroracam.ru/page/mmeWvVgS', lat: 69.1609, lon: 35.1453, kind: 'stream', country: 'ru', by: 'auroracam.ru',
    names: { ru: 'Териберка', en: 'Teriberka', zh: '捷里别尔卡' } },
  { id: 'sodankyla', url: 'https://www.sgo.fi/Data/RealTime/Kuvat/UCL.jpg', lat: 67.367, lon: 26.63, kind: 'allsky', country: 'fi', by: 'SGO',
    names: { ru: 'Соданкюля', en: 'Sodankylä', zh: '索丹屈莱' } },
  { id: 'skibotn', url: 'https://fox.phys.uit.no/ASC/Latest_ASC01.png', lat: 69.35, lon: 20.36, kind: 'allsky', country: 'no', by: 'UiT',
    names: { ru: 'Скибутн', en: 'Skibotn', zh: '希博特恩' } },
  { id: 'kiruna', url: 'https://www.irf.se/alis/allsky/krn/latest_medium.jpeg', lat: 67.84, lon: 20.41, kind: 'allsky', country: 'se', by: 'IRF',
    names: { ru: 'Кируна', en: 'Kiruna', zh: '基律纳' } },
  { id: 'abisko', url: 'https://lightsoverlapland.com/aurora-webcam/', lat: 68.35, lon: 18.82, kind: 'stream', country: 'se', by: 'Lights over Lapland',
    names: { ru: 'Абиску', en: 'Abisko', zh: '阿比斯库' } }
];

/** Камеры с расстоянием от Мурманска (км по прямой), от ближней к дальней. */
function webcamList() {
  var origin = POINTS[0];
  return WEBCAMS.map(function (cam) {
    return { cam: cam, km: Math.round(airKm(origin, cam)) };
  }).sort(function (a, b) { return a.km - b.km; });
}

function renderWebcams() {
  var box = $('webcams-list');
  if (!box) return;
  box.innerHTML = '';
  webcamList().forEach(function (item) {
    var cam = item.cam;
    var li = document.createElement('li');
    li.className = 'webcam';

    var link = document.createElement('a');
    link.className = 'webcam__name';
    link.href = cam.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = cam.names[getLang()] || cam.names.en;

    var meta = document.createElement('span');
    meta.className = 'webcam__meta';
    meta.textContent = [t('cams.kind.' + cam.kind), t('cams.country.' + cam.country),
      t('cams.dist', { dist: distText(item.km) }), cam.by].join(t('sep.dot'));

    li.appendChild(link);
    li.appendChild(meta);
    box.appendChild(li);
  });
}
