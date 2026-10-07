// Weitere Fotos eines Baus aus Wikimedia Commons.
// Quellen: die Commons-Kategorie des Baus (Wikidata P373), eine passende
// Unterkategorie („Exterior …“), Dateien, die laut Structured Data den Bau
// zeigen (P180), und ersatzweise eine Textsuche nach Name und Stadt.
// Bewertet werden Qualitätsauszeichnungen, Querformat, Auflösung und Dateiname;
// gewählt werden möglichst verschiedene Ansichten von verschiedenen Fotografen.
//
// Commons drosselt anonyme Zugriffe deutlich. Deshalb holt jede Abfrage Dateiliste
// und Bildinfos zugleich (Generator), und alle Abfragen laufen mit Abstand nacheinander.

const API = 'https://commons.wikimedia.org/w/api.php';
const UA = { 'User-Agent': 'FormatlasBuild/1.0 (architecture map; build script)' };
const WIDTH = 500; // Standardbreite der Wikimedia-Thumbnails
const GAP = 1100; // Millisekunden zwischen zwei Abfragen
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let last = 0;
export async function commons(params) {
  // POST, weil lange Dateilisten sonst die URL-Länge sprengen
  const body = new URLSearchParams({ format: 'json', formatversion: '2', ...params });
  let status = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    const gap = last + GAP - Date.now();
    if (gap > 0) await wait(gap);
    last = Date.now();
    try {
      const res = await fetch(API, { method: 'POST', headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      status = res.status;
      const text = await res.text();
      if (res.ok && text.startsWith('{')) return JSON.parse(text);
      // Drosselung: Retry-After beachten, sonst wachsend warten
      const retry = Number(res.headers.get('retry-after'));
      await wait(retry ? retry * 1000 + 500 : 5000 * (attempt + 1));
    } catch {
      await wait(5000 * (attempt + 1)); // Netzwerkfehler
    }
  }
  throw new Error(`Commons nicht erreichbar (HTTP ${status})`);
}

// Kategorien, deren Bilder selten das Gebäude von außen zeigen
const SKIP_CAT = /interior|inside|innen|construction|under construction|bau(stelle|arbeiten)|plans?\b|drawings?|models?\b|modell|people|persons|events?\b|exhibitions?|ausstellung|furniture|möbel|details?\b|logos?\b|maps?\b|in art|postcards?|history|signs?\b|artworks?|sculptures?|paintings?|collections?|concerts?|videos?|audio|documents?|tickets?|stamps?|coins?|sections?\b|elevations?|by photographer|aircraft|airplanes|vehicles|trains|rolling stock|ships|animals|plants|food|meetings?|visits?|conferences?|ceremon|award|matches|games|football|soccer|seasons?\b|teams?\b|lights? shows?/i;
const GOOD_CAT = /exterior|außen|facade|fassade|façade|views?\b|aerial|luftbild|night|nacht|panoram|skyline/i;
// Dateinamen, die sicher nicht passen
const SKIP_FILE = /\b(plan|grundriss|map|karte|logo|schild|plaque|tafel|model|modell|maquette|crane|kran|scaffold|gerüst|ticket|stamp|briefmarke|coin|medal|medaille|münze|banknote|diagram|drawing|zeichnung|sketch|skizze|poster|flyer|screenshot|selfie|placa)\b|construction|baustelle|\bHABS\b|sheet \d+ of|floor plans?|infotafel|informationstafel|petroglyph|模型|\.(svg|tiff?|pdf|gif|djvu|webm|ogv|ogg|mp3|stl)$/i;
// Dateinamen, die eher Innenräume oder Nebensachen zeigen
const WEAK_FILE = /interior|inside|innen|lobby|foyer|hallway|corridor|stair|treppe|ceiling|decke|detail|door\b|tür|window|fenster|toilet|restaurant|café|cafe\b|shop\b|concert|konzert|people|crowd|exhibition|ausstellung|exponat|furniture|chair|stuhl|lamp\b|lampe|sign\b|entrance hall/i;

const stripHtml = (s = '') => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
// „Haus 01.jpg“ und „Haus 02.jpg“ gelten als dieselbe Serie
const stem = (name) => name.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[\d_()\-–.,]+/g, ' ').replace(/\s+/g, ' ').trim();

const INFO = {
  prop: 'imageinfo|categories',
  iiprop: 'url|size|mime|extmetadata',
  iiurlwidth: String(WIDTH),
  iiextmetadatafilter: 'Artist|LicenseShortName',
  clcategories: 'Category:Quality images|Category:Featured pictures on Wikimedia Commons',
  cllimit: 'max',
};

function toInfo(p, name) {
  const ii = p.imageinfo?.[0];
  if (!ii?.thumburl) return null;
  const m = ii.thumburl.match(/\/commons\/thumb\/(.+?)\/\d+px-/);
  return {
    name,
    path: m ? m[1] : ii.thumburl.split('?')[0],
    width: ii.width,
    height: ii.height,
    mime: ii.mime,
    author: stripHtml(ii.extmetadata?.Artist?.value).slice(0, 60),
    license: stripHtml(ii.extmetadata?.LicenseShortName?.value),
    quality: (p.categories || []).length > 0,
  };
}

// Generator-Abfrage: Dateien samt Bildinfos in einem Schritt
async function generate(params) {
  const j = await commons({ action: 'query', ...params, ...INFO });
  return (j.query?.pages || [])
    .filter((p) => p.ns === 6)
    .map((p) => toInfo(p, p.title.replace(/^File:/, '')))
    .filter(Boolean);
}

// Bildinfos für bekannte Dateinamen
export async function fileInfo(names) {
  const out = new Map();
  for (let i = 0; i < names.length; i += 50) {
    const group = names.slice(i, i + 50);
    // redirects: umbenannte Dateien unter ihrem alten Namen finden
    const j = await commons({ action: 'query', redirects: '1', titles: group.map((n) => 'File:' + n).join('|'), ...INFO });
    const norm = Object.fromEntries((j.query?.normalized || []).map((n) => [n.to, n.from]));
    const redir = Object.fromEntries((j.query?.redirects || []).map((r) => [r.to, r.from]));
    for (const p of j.query?.pages || []) {
      const asked = redir[p.title] || p.title;
      const name = (norm[asked] || asked).replace(/^File:/, '');
      const info = toInfo(p, name);
      if (info) out.set(name, info);
    }
  }
  return out;
}

function score(f, source) {
  if (!/jpe?g|png|webp/.test(f.mime || '') || f.width < 1200 || SKIP_FILE.test(f.name)) return -Infinity;
  let s = 0;
  if (f.quality) s += 4;
  s += source === 'good' ? 1.5 : source === 'main' ? 0.8 : source === 'depicts' ? 0.6 : 0;
  const ratio = f.width / f.height;
  if (ratio >= 1.3 && ratio <= 1.8) s += 1.5;
  else if (ratio >= 1.05 && ratio < 1.3) s += 0.6;
  else if (ratio > 1.8 && ratio <= 2.4) s += 0.4;
  else if (ratio > 2.4) s -= 1;
  else s -= 1.2; // Hochformat wird im Querformat stark beschnitten
  if (f.width >= 3000) s += 0.4;
  if (WEAK_FILE.test(f.name)) s -= 2;
  return s;
}

/**
 * Sucht `count` zusätzliche Fotos zu einem Bau.
 * @param {{ qid?: string, category?: string, name?: string, city?: string, exclude?: string[], count?: number }} opts
 * @returns {Promise<object[]>} Bildinfos
 */
export async function findPhotos({ qid, category, name, city, exclude = [], count = 2 }) {
  const found = new Map(); // Dateiname → Bildinfo mit Herkunft
  const add = (list, source) => list.forEach((f) => { if (!found.has(f.name)) found.set(f.name, { ...f, source }); });

  if (category) {
    // neueste Uploads zuerst: meist aktuelle Kameras, oft bessere Bilder
    add(await generate({ generator: 'categorymembers', gcmtitle: 'Category:' + category, gcmtype: 'file', gcmlimit: '50', gcmsort: 'timestamp', gcmdir: 'desc' }), 'main');
    const sub = await commons({ action: 'query', list: 'categorymembers', cmtitle: 'Category:' + category, cmtype: 'subcat', cmlimit: '100' });
    const good = (sub.query?.categorymembers || []).map((m) => m.title).find((t) => GOOD_CAT.test(t) && !SKIP_CAT.test(t));
    if (good) add(await generate({ generator: 'categorymembers', gcmtitle: good, gcmtype: 'file', gcmlimit: '50' }), 'good');
  }
  if (qid) add(await generate({ generator: 'search', gsrsearch: `haswbstatement:P180=${qid}`, gsrnamespace: '6', gsrlimit: '50' }), 'depicts');
  if (found.size < 6 && name) {
    // Textsuche nur mit Ortsnamen im Dateinamen, sonst landen Namensvettern anderswo im Ergebnis
    const plain = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const hits = await generate({ generator: 'search', gsrsearch: `"${name}" ${city || ''}`.trim(), gsrnamespace: '6', gsrlimit: '30' });
    add(city ? hits.filter((f) => plain(f.name).includes(plain(city))) : hits, 'text');
  }

  const skip = new Set(exclude);
  const ranked = [...found.values()]
    .filter((f) => !skip.has(f.name))
    .map((f) => ({ ...f, score: score(f, f.source) }))
    .filter((f) => f.score > -Infinity)
    .sort((a, b) => b.score - a.score);

  // Gierige Auswahl mit Abwechslung: andere Serie, möglichst andere Fotografen
  const picked = [];
  const stems = new Set(exclude.map(stem));
  const authors = new Set();
  for (const pass of [0, 1]) {
    for (const f of ranked) {
      if (picked.length >= count) break;
      if (picked.includes(f) || stems.has(stem(f.name))) continue;
      if (pass === 0 && f.author && authors.has(f.author)) continue;
      picked.push(f);
      stems.add(stem(f.name));
      if (f.author) authors.add(f.author);
    }
  }
  return picked;
}
