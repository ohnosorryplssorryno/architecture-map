// Erzeugt data/buildings.js aus data/source.mjs.
//   1. Wikidata: Koordinaten, Standardfoto, Commons-Kategorie, Wikipedia-Link, OSM-IDs
//   2. OpenStreetMap: Grundriss → Gebäudemitte, Radius und Höhe (Cache: data/footprints.json)
//   3. Wikimedia Commons: drei Fotos je Bau mit Urheber und Lizenz (Cache: data/photos.json)
// Aufruf: node tools/build-data.mjs [--refresh-footprints] [--refresh-photos]
import { readFile, writeFile } from 'node:fs/promises';
import { architects, buildings } from '../data/source.mjs';
import { findFootprint } from './footprints.mjs';
import { findPhotos, fileInfo } from './photos.mjs';

const UA = { 'User-Agent': 'FormatlasBuild/1.0 (architecture map; build script)' };
const PHOTOS = 3;
const MAX_OFFSET = 300; // Meter: weiter weg liegende Grundrisse gelten als Fehlgriff

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(url) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers: UA });
    if (res.ok) return res.json();
    await wait(2000 * (attempt + 1));
  }
  throw new Error('Request failed: ' + url);
}
const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const round = (n) => Math.round(n * 1e5) / 1e5;
const meters = ([lat1, lng1], [lat2, lng2]) => {
  const k = Math.PI / 180;
  return Math.hypot((lng2 - lng1) * k * Math.cos(lat1 * k), (lat2 - lat1) * k) * 6371008.8;
};
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

  const { qid, image, coord: _c, osm: _o, photos: _p, skipPhotos: _s, ...rest } = b;
  out.push({
    ...rest,
    lat: round(coord[0]),
    lng: round(coord[1]),
    ...(shape ? { r: shape.r, h: Math.max(...shape.fh.map(([h]) => h)) } : {}),
    // Foto: [Commons-Pfad, Urheber, Lizenz]
    ph: photos.map((p) => [p.path, p.author, p.license]),
    wiki: wd[qid]?.wiki || (qid ? `https://www.wikidata.org/wiki/${qid}` : null),
  });
}
out.sort((a, b) => a.year - b.year || a.name.localeCompare(b.name, 'de'));

const publicArchitects = architects.map(({ match, ...a }) => a);
const js =
  '// Generiert von tools/build-data.mjs – nicht von Hand bearbeiten.\n' +
  'window.FORMATLAS_DATA = ' + JSON.stringify({ architects: publicArchitects, buildings: out }) + ';\n';
await writeFile(new URL('../data/buildings.js', import.meta.url), js);
const few = out.filter((b) => b.ph.length < PHOTOS).map((b) => `${b.id} (${b.ph.length})`);
console.log(`${out.length} Bauten geschrieben, ${out.filter((b) => !b.r).length} ohne Grundriss.`);
if (few.length) console.log('Weniger als drei Fotos:', few.join(', '));
