// Erzeugt data/buildings.js aus data/source.mjs.
//   1. Wikidata: Koordinaten, Standardfoto, Commons-Kategorie, Wikipedia-Link, OSM-IDs
//   2. OpenStreetMap: Grundriss → Gebäudemitte, Radius und Höhe (Cache: data/footprints.json)
//   3. Wikimedia Commons: drei Fotos je Bau mit Urheber und Lizenz (Cache: data/photos.json)
//   Dazu: Stilrichtung, englische Fassung (data/i18n-en.mjs) und der Grundriss als kleiner SVG-Pfad
//   4. Datenprüfung (tools/check-data.mjs), bricht bei Fehlern mit Exit-Code 1 ab
// Aufruf: node tools/build-data.mjs [--refresh-footprints] [--refresh-photos]
import { readFile, writeFile } from 'node:fs/promises';
import { architects, buildings, typeGroups, styles } from '../data/source.mjs';
import * as en from '../data/i18n-en.mjs';
import { runChecks } from './check-data.mjs';
import { findFootprint } from './footprints.mjs';
import { findPhotos, fileInfo } from './photos.mjs';

const UA = { 'User-Agent': 'FormatlasBuild/1.0 (architecture map; build script)' };
const PHOTOS = 3;
const MAX_OFFSET = 300; // Meter: weiter weg liegende Grundrisse gelten als Fehlgriff

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { headers: UA });
    if (res.ok) return res.json();
    // Wikidata drosselt schnelle Folgeanfragen (429) und nennt die Wartezeit
    const retry = Number(res.headers.get('retry-after'));
    await wait(retry > 0 ? retry * 1000 : 3000 * (attempt + 1));
  }
  throw new Error('Request failed: ' + url);
}
const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const round = (n) => Math.round(n * 1e5) / 1e5;
const meters = ([lat1, lng1], [lat2, lng2]) => {
  const k = Math.PI / 180;
  return Math.hypot((lng2 - lng1) * k * Math.cos(lat1 * k), (lat2 - lat1) * k) * 6371008.8;
};
// Douglas-Peucker: entfernt Punkte, die weniger als tol von der Verbindungslinie abweichen
function simplify(points, tol) {
  if (points.length < 4) return points;
  const [ax, ay] = points[0], [bx, by] = points[points.length - 1];
  const len = Math.hypot(bx - ax, by - ay) || 1;
  let max = 0, idx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i];
    const d = len > 1e-9 && (bx !== ax || by !== ay)
      ? Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len
      : Math.hypot(px - ax, py - ay);
    if (d > max) { max = d; idx = i; }
  }
  if (max <= tol) return [points[0], points[points.length - 1]];
  return [...simplify(points.slice(0, idx + 1), tol).slice(0, -1), ...simplify(points.slice(idx), tol)];
}

// Grundriss als SVG-Pfad in Metern um die Gebäudemitte, Norden oben: [Pfad, [x, y, Breite, Höhe]]
function planOf(rings, [lng0, lat0]) {
  const k = Math.PI / 180, mx = 111320 * Math.cos(lat0 * k), my = 110540;
  let shapes = rings.map((ring) => ring.map(([lng, lat]) => [(lng - lng0) * mx, -(lat - lat0) * my]));
  const area = (r) => Math.abs(r.reduce((sum, p, i) => { const q = r[(i + 1) % r.length]; return sum + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
  const biggest = Math.max(...shapes.map(area));
  shapes = shapes.filter((r) => area(r) >= biggest * 0.005); // Kleinkram (Treppenhäuser, Kioske) weglassen
  const xs = shapes.flat().map((p) => p[0]), ys = shapes.flat().map((p) => p[1]);
  const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
  const size = Math.max(box[2], box[3]);
  let tol = size / 200, out;
  do {
    // Ringe vereinfachen; geschlossene Ringe an der gegenüberliegenden Ecke teilen, damit beide Hälften erhalten bleiben
    out = shapes.map((r) => {
      const half = r.length >> 1;
      return [...simplify(r.slice(0, half + 1), tol).slice(0, -1), ...simplify(r.slice(half), tol)];
    }).filter((r) => r.length >= 4);
    tol *= 1.4;
  } while (out.reduce((n, r) => n + r.length, 0) > 260);
  const dec = size < 80 ? 10 : 1;
  const f = (v) => Math.round(v * dec) / dec;
  const d = out.map((r) => 'M' + r.slice(0, -1).map(([x, y]) => `${f(x)} ${f(y)}`).join(' ') + 'Z').join('');
  return [d, box.map(f)];
}

async function loadJson(name, refresh) {
  try { if (!refresh) return JSON.parse(await readFile(new URL(`../data/${name}`, import.meta.url), 'utf8')); } catch {}
  return {};
}
const saveJson = (name, data) => writeFile(new URL(`../data/${name}`, import.meta.url), JSON.stringify(data, null, 1));

const ids = new Set();
for (const b of buildings) {
  if (ids.has(b.id)) throw new Error('Doppelte ID: ' + b.id);
  ids.add(b.id);
}
const archById = new Map(architects.map((a) => [a.id, a]));

// 1. Wikidata
const wd = {};
for (const group of chunks(buildings.filter((b) => b.qid).map((b) => b.qid), 50)) {
  const j = await api(
    'https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims|sitelinks/urls' +
      `&sitefilter=dewiki|enwiki&ids=${group.join('|')}`
  );
  for (const [id, e] of Object.entries(j.entities)) {
    const get = (p) => e.claims?.[p]?.[0]?.mainsnak?.datavalue?.value;
    const all = (p) => (e.claims?.[p] || []).map((x) => x.mainsnak?.datavalue?.value).filter(Boolean);
    const c = get('P625');
    wd[id] = {
      coord: c && [c.latitude, c.longitude],
      image: get('P18'),
      category: get('P373'),
      wiki: e.sitelinks?.dewiki?.url || e.sitelinks?.enwiki?.url || null,
      wikiEn: e.sitelinks?.enwiki?.url || null,
      osm: [...all('P10689').map((v) => 'w' + v), ...all('P402').map((v) => 'r' + v)],
    };
  }
  await wait(300);
}

// 2. OpenStreetMap-Grundrisse
const footprints = await loadJson('footprints.json', process.argv.includes('--refresh-footprints'));
for (const b of buildings) {
  const known = footprints[b.id];
  if (known && (!b.osm || String(known.osm) === String(b.osm))) continue;
  const coord = b.coord || wd[b.qid]?.coord;
  if (!coord) continue;
  process.stdout.write(`Grundriss ${b.id} … `);
  footprints[b.id] = await findFootprint({
    qid: b.qid,
    lat: coord[0],
    lng: coord[1],
    osmRefs: b.osm || wd[b.qid]?.osm || [],
    match: archById.get(b.architect)?.match,
  });
  console.log(footprints[b.id].none ? 'keiner gefunden' : footprints[b.id].osm.join(', '));
  await saveJson('footprints.json', footprints);
}

// 3. Fotos: erstes Bild aus der Quelle oder Wikidata, zwei weitere aus Commons
const photoCache = await loadJson('photos.json', process.argv.includes('--refresh-photos'));
const mainOf = (b) => b.image || wd[b.qid]?.image || null;
// Ändert sich Foto 1, eine manuelle Auswahl oder die Ausschlussliste, wird neu gesucht
const photoKey = (b) =>
  JSON.stringify(b.skipPhotos ? [mainOf(b), b.photos || null, b.skipPhotos] : [mainOf(b), b.photos || null]);
const mainInfo = await fileInfo([...new Set(buildings.map(mainOf).filter(Boolean))]);
const todo = buildings.filter((b) => photoCache[b.id]?.key !== photoKey(b));
async function photoWorker() {
  // nacheinander: Commons drosselt parallele Zugriffe
  while (todo.length) {
    const b = todo.shift();
    const main = mainOf(b);
    let extra;
    try {
      extra = b.photos
        ? [...(await fileInfo(b.photos)).values()]
        : await findPhotos({ qid: b.qid, category: wd[b.qid]?.category, name: b.name, city: b.city, exclude: [main, ...(b.skipPhotos || [])].filter(Boolean), count: main ? PHOTOS - 1 : PHOTOS });
    } catch (err) {
      // ohne Cache-Eintrag: der nächste Lauf versucht es erneut
      console.warn(`Fotos ${b.id}: ${err.message}`);
      continue;
    }
    photoCache[b.id] = {
      key: photoKey(b),
      list: extra.map(({ name, path, author, license }) => ({ name, path, author, license })),
    };
    console.log(`Fotos ${b.id}: ${extra.length} gefunden`);
    await saveJson('photos.json', photoCache);
  }
}
await photoWorker();

// 4. Zusammenführen
const out = [];
for (const b of buildings) {
  const fp = footprints[b.id]?.c ? footprints[b.id] : null;
  const wdCoord = b.coord || wd[b.qid]?.coord;
  let coord = wdCoord;
  let shape = null;
  if (fp) {
    const c = [fp.c[1], fp.c[0]];
    // Grundriss nur übernehmen, wenn er nahe am bekannten Standort liegt (oder manuell gesetzt ist)
    if (!wdCoord || b.osm || meters(c, wdCoord) <= MAX_OFFSET) {
      coord = c;
      shape = fp;
    } else console.warn(`Grundriss verworfen (${Math.round(meters(c, wdCoord))} m daneben):`, b.id);
  }
  if (!coord) { console.warn('Übersprungen, keine Koordinaten:', b.id); continue; }

  const main = mainOf(b) && mainInfo.get(mainOf(b));
  const photos = [main, ...(photoCache[b.id]?.list || [])].filter(Boolean).slice(0, PHOTOS);
  if (!photos.length) console.warn('Kein Foto:', b.id);

  const { qid, image, coord: _c, osm: _o, photos: _p, skipPhotos: _s, style, ...rest } = b;
  const english = en.buildings[b.id];
  out.push({
    ...rest,
    style: style || archById.get(b.architect).style,
    lat: round(coord[0]),
    lng: round(coord[1]),
    ...(shape ? { r: shape.r, h: Math.max(...shape.fh.map(([h]) => h)), pl: planOf(shape.fp, shape.c) } : {}),
    ...(english ? { en: english } : {}),
    // Foto: [Commons-Pfad, Urheber, Lizenz]
    ph: photos.map((p) => [p.path, p.author, p.license]),
    wiki: wd[qid]?.wiki || (qid ? `https://www.wikidata.org/wiki/${qid}` : null),
    // englischer Artikel, nur wenn er sich vom deutschen unterscheidet
    ...(wd[qid]?.wikiEn && wd[qid].wikiEn !== wd[qid].wiki ? { wikiEn: wd[qid].wikiEn } : {}),
  });
}
out.sort((a, b) => a.year - b.year || a.name.localeCompare(b.name, 'de'));

const publicArchitects = architects.map(({ match, ...a }) => ({ ...a, en: en.architects[a.id] }));
// Englische Wörterbücher für Länder, Städte und Typen (Bauten tragen ihre Fassung selbst)
const english = { countries: en.countries, cities: en.cities, types: en.types };
const js =
  '// Generiert von tools/build-data.mjs – nicht von Hand bearbeiten.\n' +
  'window.FORMATLAS_DATA = ' + JSON.stringify({ architects: publicArchitects, groups: typeGroups, styles: styles.map(({ note, ...st }) => st), en: english, buildings: out }) + ';\n';
await writeFile(new URL('../data/buildings.js', import.meta.url), js);
console.log(`${out.length} Bauten geschrieben, ${out.filter((b) => !b.r).length} ohne Grundriss.`);

// 5. Prüfen
process.exitCode = await runChecks({ online: true });
