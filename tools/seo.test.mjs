// Теги для поисковиков и превью ссылок: описание, canonical и hreflang, Open Graph, JSON-LD,
// robots.txt и sitemap.xml — согласованы между собой и с переводами.
// Запуск: node --test tools/seo.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const html = read('index.html');
const head = html.slice(0, html.indexOf('</head>'));
const SITE = 'https://auroramurmansk.ru/';

const meta = (attr, name) => {
  const m = new RegExp(`<meta ${attr}="${name.replace(/[.:]/g, '\\$&')}" content="([^"]*)">`).exec(head);
  return m && m[1];
};
const hreflang = Object.fromEntries([...head.matchAll(/<link rel="alternate" hreflang="([\w-]+)" href="([^"]+)">/g)].map(m => [m[1], m[2]]));

test('адрес сайта в теге и в CNAME один и тот же', () => {
  assert.equal(SITE, 'https://' + read('CNAME').trim() + '/');
});

test('заголовок и описание: есть, про прогноз сияния и Мурманск, нужной длины', () => {
  const title = /<title>([^<]+)<\/title>/.exec(head)[1];
  assert.match(title, /северного сияния/i);
  assert.match(title, /Мурманск/);
  assert.ok(title.length <= 70, 'заголовок ' + title.length + ' символов — длиннее обрежется в выдаче');
  const description = meta('name', 'description');
  assert.ok(description.length >= 70 && description.length <= 180, 'описание ' + description.length);
  assert.match(meta('name', 'robots'), /^index, follow/);
});

test('canonical и hreflang: все три языка и x-default, адреса абсолютные и на этом сайте', () => {
  assert.match(head, new RegExp(`<link rel="canonical" href="${SITE}">`));
  assert.deepEqual(Object.keys(hreflang).sort(), ['en', 'ru', 'x-default', 'zh']);
  for (const code of ['ru', 'en', 'zh']) assert.equal(hreflang[code], SITE + '?lang=' + code);
  assert.equal(hreflang['x-default'], SITE);
});

test('Open Graph и Twitter: заголовок, описание, картинка 1200×630, которая лежит в репозитории', () => {
  for (const key of ['og:type', 'og:site_name', 'og:title', 'og:description', 'og:url', 'og:locale', 'og:image', 'og:image:alt']) {
    assert.ok(meta('property', key), key);
  }
  assert.equal(meta('property', 'og:url'), SITE);
  assert.equal(meta('property', 'og:description'), meta('name', 'description'));
  assert.equal(meta('name', 'twitter:card'), 'summary_large_image');
  assert.equal(meta('name', 'twitter:image'), meta('property', 'og:image'));

  const image = meta('property', 'og:image');
  assert.ok(image.startsWith(SITE), 'мессенджерам нужен абсолютный адрес');
  const png = fs.readFileSync(new URL('../' + image.slice(SITE.length), import.meta.url));
  assert.equal(png.toString('ascii', 1, 4), 'PNG');
  const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
  assert.deepEqual([w, h], [1200, 630]);
  assert.equal(meta('property', 'og:image:width'), String(w));
  assert.equal(meta('property', 'og:image:height'), String(h));
  assert.ok(png.length < 300 * 1024, 'превью должно грузиться быстро: ' + png.length);
});

test('JSON-LD разбирается, адреса и описание совпадают с тегами', () => {
  const blocks = [...head.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.equal(blocks.length, 1);
  const ld = JSON.parse(blocks[0][1]);
  assert.equal(ld['@context'], 'https://schema.org');
  assert.equal(ld['@type'], 'WebApplication');
  assert.equal(ld.url, SITE);
  assert.equal(ld.description, meta('name', 'description'));
  assert.equal(ld.image, meta('property', 'og:image'));
  assert.deepEqual(ld.inLanguage, ['ru', 'en', 'zh']);
  for (const url of [ld.image, ld.screenshot]) assert.ok(fs.existsSync(new URL('../' + url.slice(SITE.length), import.meta.url)), url);
});

test('robots.txt пускает всех и указывает на карту сайта', () => {
  const robots = read('robots.txt');
  assert.match(robots, /^User-agent: \*\nAllow: \/\n/);
  assert.doesNotMatch(robots, /^Disallow: \/\s*$/m, 'сайт целиком закрывать нельзя');
  assert.match(robots, new RegExp(`^Sitemap: ${SITE}sitemap\\.xml$`, 'm'));
});

test('sitemap.xml: те же адреса, что в hreflang, и у каждого — полный набор языковых версий', () => {
  const xml = read('sitemap.xml');
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  const urls = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map(m => m[1]);
  const locs = urls.map(u => /<loc>([^<]+)<\/loc>/.exec(u)[1]);
  assert.deepEqual([...locs].sort(), Object.values(hreflang).sort());
  for (const u of urls) {
    const alts = Object.fromEntries([...u.matchAll(/<xhtml:link rel="alternate" hreflang="([\w-]+)" href="([^"]+)"\/>/g)].map(m => [m[1], m[2]]));
    assert.deepEqual(alts, hreflang);
    assert.match(u, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
  }
  assert.doesNotMatch(xml, /&(?!amp;)/, 'в XML голый & недопустим');
});

test('заголовок вкладки (точка + «прогноз») переведён; до запуска скриптов — такой же для Мурманска', () => {
  const ctx = vm.createContext({});
  vm.runInContext(read('i18n.js'), ctx);
  for (const code of ['ru', 'en', 'zh']) vm.runInContext(read(`lang/${code}.js`), ctx);
  const dicts = JSON.parse(vm.runInContext('JSON.stringify(i18nDicts)', ctx));
  // renderPointMeta() ставит title.point с выбранной точкой; по умолчанию это Мурманск
  assert.equal(dicts.ru['title.point'].replace('{name}', 'Мурманск'), /<title>([^<]+)<\/title>/.exec(head)[1]);
  assert.equal(dicts.ru['meta.description'], meta('name', 'description'));
  assert.match(dicts.ru['title.point'], /прогноз/);
  assert.match(dicts.en['title.point'], /Forecast/);
  assert.match(dicts.zh['title.point'], /预报/);
  for (const code of ['en', 'zh']) assert.doesNotMatch(dicts[code]['title.point'], /[А-Яа-я]/, code);
});

test('canonical при смене языка: с ?lang — версия на языке, без него или с чужим — адрес по умолчанию', () => {
  const code = read('js/settings.js');
  const fn = /var SITE_URL = [^\n]+\n[\s\S]*?\nfunction canonicalUrl[\s\S]*?\n\}/.exec(code)[0];
  const ctx = vm.createContext({});
  vm.runInContext(read('i18n.js') + '\n' + fn, ctx);
  const canon = s => vm.runInContext(`canonicalUrl(${JSON.stringify(s)})`, ctx);
  assert.equal(canon(''), SITE);
  assert.equal(canon('?lang=en'), SITE + '?lang=en');
  assert.equal(canon('?x=1&lang=ZH-cn'), SITE + '?lang=zh');
  assert.equal(canon('?lang=fr'), SITE);
  assert.equal(canon('?point=teriberka'), SITE, 'точка в адресе — та же страница');
  for (const c of ['ru', 'en', 'zh']) assert.equal(canon('?lang=' + c), hreflang[c], 'совпадает с hreflang');
  const apply = /function applyLanguage\(\) \{[\s\S]*?\n\}/.exec(code)[0];
  assert.match(apply, /canonical\.setAttribute\('href', canonicalUrl\(location\.search\)\)/);
});
