// Сравнение суммарной облачности и ярусов по разным моделям Open-Meteo
const LAT = 68.97, LON = 33.07;

const MODELS = [
  'best_match', 'icon_seamless', 'icon_eu', 'icon_global', 'ecmwf_ifs025',
  'gfs_seamless', 'metno_seamless', 'knmi_seamless', 'dmi_seamless',
  'ukmo_seamless', 'meteofrance_seamless', 'gem_seamless'
];

const url = model => 'https://api.open-meteo.com/v1/forecast'
  + `?latitude=${LAT}&longitude=${LON}`
  + '&current=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high'
  + `&models=${model}&timezone=UTC`;

const pad = (s, n) => String(s).padEnd(n);
const num = v => (v === null || v === undefined) ? null : Number(v);

(async () => {
  console.log(pad('модель', 22) + pad('всего', 8) + pad('low', 6) + pad('mid', 6) + pad('high', 7)
    + pad('max яр.', 9) + pad('сумма', 8) + 'вердикт');
  console.log('-'.repeat(88));

  for (const model of MODELS) {
    try {
      const res = await fetch(url(model));
      if (!res.ok) { console.log(pad(model, 22) + 'HTTP ' + res.status); continue; }

      const d = await res.json();
      const c = d.current || {};
      const total = num(c.cloud_cover);
      const low = num(c.cloud_cover_low), mid = num(c.cloud_cover_mid), high = num(c.cloud_cover_high);

      if ([total, low, mid, high].some(v => v === null)) {
        console.log(pad(model, 22) + 'нет части полей: ' + JSON.stringify(c));
        continue;
      }

      // Физические границы: при любом перекрытии max(ярусы) <= всего <= min(100, сумма)
      const maxLayer = Math.max(low, mid, high);
      const sumLayers = Math.min(100, low + mid + high);
      let verdict = 'согласовано';
      if (total > sumLayers) verdict = `НЕВОЗМОЖНО: всего > суммы на ${total - sumLayers} п.п.`;
      else if (total < maxLayer) verdict = `НЕВОЗМОЖНО: всего < max яруса на ${maxLayer - total} п.п.`;

      console.log(pad(model, 22) + pad(total + '%', 8) + pad(low, 6) + pad(mid, 6) + pad(high, 7)
        + pad(maxLayer, 9) + pad(sumLayers, 8) + verdict);
    } catch (e) {
      console.log(pad(model, 22) + 'ошибка: ' + e.message);
    }
  }
})();
