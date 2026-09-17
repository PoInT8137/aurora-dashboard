// Насколько устойчиво расхождение «всего» и ярусов по часам
const LAT = 68.97, LON = 33.07;
const W = { low: 1.0, mid: 0.8, high: 0.35 };

const eff = (l, m, h) => Math.round(100 * (1 -
  (1 - W.low * l / 100) * (1 - W.mid * m / 100) * (1 - W.high * h / 100)));

const url = model => 'https://api.open-meteo.com/v1/forecast'
  + `?latitude=${LAT}&longitude=${LON}`
  + '&hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high'
  + `&models=${model}&forecast_days=2&timezone=UTC`;

const pad = (s, n) => String(s).padEnd(n);

(async () => {
  for (const model of ['best_match', 'metno_seamless', 'icon_eu', 'ecmwf_ifs025', 'gfs_seamless']) {
    const res = await fetch(url(model));
    if (!res.ok) { console.log(model + ': HTTP ' + res.status); continue; }
    const h = (await res.json()).hourly;

    let n = 0, impossible = 0, over30 = 0, gapSum = 0, maxGap = 0, maxAt = '';
    const samples = [];

    for (let i = 0; i < h.time.length; i++) {
      const total = h.cloud_cover[i];
      const l = h.cloud_cover_low[i], m = h.cloud_cover_mid[i], hi = h.cloud_cover_high[i];
      if ([total, l, m, hi].some(v => v === null || v === undefined)) continue;

      const e = eff(l, m, hi);
      const gap = Math.abs(e - total);
      const sumLayers = Math.min(100, l + m + hi);
      const maxLayer = Math.max(l, m, hi);

      n++;
      gapSum += gap;
      if (total > sumLayers || total < maxLayer) impossible++;
      if (gap > 30) over30++;
      if (gap > maxGap) { maxGap = gap; maxAt = `${h.time[i]} ${l}/${m}/${hi} эфф ${e} всего ${total}`; }
      if (samples.length < 4 && i % 7 === 0) samples.push(`${h.time[i].slice(5, 13)} ${l}/${m}/${hi}→${e} vs ${total}`);
    }

    console.log(pad(model, 17)
      + pad(`часов ${n}`, 11)
      + pad(`физически невозможных ${impossible} (${Math.round(100 * impossible / n)}%)`, 33)
      + pad(`расхождение >30 п.п.: ${over30} (${Math.round(100 * over30 / n)}%)`, 30)
      + `среднее ${Math.round(gapSum / n)} п.п.`);
    console.log('   ' + samples.join(' | '));
    console.log('   максимум: ' + maxAt + '\n');
  }
})();
