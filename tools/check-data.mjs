// Prüft Quelldaten und data/buildings.js, bevor sie online gehen.
//   node tools/check-data.mjs            nur lokale Prüfungen (schnell, ohne Netz)
//   node tools/check-data.mjs --online   vergleicht zusätzlich Land und Koordinaten mit Wikidata
// Fehler beenden das Programm mit Exit-Code 1, Warnungen sind Hinweise zur Durchsicht.
// tools/build-data.mjs ruft die Prüfung am Ende jedes Laufs mit --online auf.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const PHOTOS = 3;
const CITY_RADIUS_KM = 80; // weiter vom Stadtmittel entfernt: Koordinate oder Stadt prüfen
const WIKIDATA_OFFSET_M = 1000; // weiter von der Wikidata-Koordinate entfernt: Grundriss prüfen
const UA = { 'User-Agent': 'FormatlasBuild/1.0 (architecture map; data check)' };

// Länder in der Schreibweise der Quelldaten → mögliche Wikidata-Bezeichnungen (P17, deutsch)
const COUNTRY_ALIASES = {
  USA: ['Vereinigte Staaten'],
  Großbritannien: ['Vereinigtes Königreich'],
  VAE: ['Vereinigte Arabische Emirate'],
  China: ['Hongkong', 'Macau'],
  Neukaledonien: ['Frankreich'],
};

const km = ([lat1, lng1], [lat2, lng2]) => {
  const k = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * k) / 2) ** 2 + Math.cos(lat1 * k) * Math.cos(lat2 * k) * Math.sin(((lng2 - lng1) * k) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(a));
};
const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const fold = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/* ---------------- Prüfungen ---------------- */

// data: Inhalt von buildings.js; source: data/source.mjs; facts: Wikidata-Angaben je QID (optional)
export function checkData({ data, source, facts }) {
  const errors = [];
  const warnings = [];
  const err = (id, msg) => errors.push(`${id}: ${msg}`);
  const warn = (id, msg) => warnings.push(`${id}: ${msg}`);
  const year = new Date().getFullYear();

  // Architekten
  const archIds = new Set();
  for (const a of data.architects) {
    if (archIds.has(a.id)) err(a.id, 'Architekten-ID doppelt');
    if (data.en && !a.en?.meta) err(a.id, 'englische Kurzangabe (meta) fehlt in data/i18n-en.mjs');
    archIds.add(a.id);
    for (const f of ['id', 'name', 'short', 'meta', 'color']) if (!a[f]) err(a.id || '?', `Architekt ohne „${f}“`);
    if (a.color && !/^#[0-9a-f]{6}$/i.test(a.color)) err(a.id, `Farbe „${a.color}“ ist kein sechsstelliger Hex-Wert`);
  }
  const archById = new Map(data.architects.map((a) => [a.id, a]));

  // Stilrichtungen
  const knownStyles = new Set((data.styles || []).map((st) => st.id));
  for (const st of data.styles || []) if (!st.label || !st.en) err(st.id, 'Stilrichtung ohne deutschen oder englischen Namen');
  for (const a of data.architects) if (data.styles && !knownStyles.has(a.style)) err(a.id, `unbekannter Grundstil „${a.style}“`);

  // Gebäudetypen
  const knownTypes = new Map();
  for (const g of data.groups) for (const t of g.types) {
    if (knownTypes.has(t)) err(g.id, `Typ „${t}“ steht in zwei Gruppen`);
    knownTypes.set(t, g.id);
  }

  // Bauten
  const ids = new Set();
  const photoUse = new Map();
  const fewPhotos = [];
  for (const b of data.buildings) {
    const id = b.id || '(ohne ID)';
    for (const f of ['id', 'architect', 'name', 'city', 'country', 'type', 'text']) {
      if (typeof b[f] !== 'string' || !b[f].trim()) err(id, `Feld „${f}“ fehlt oder ist leer`);
      else if (b[f] !== b[f].trim() || /\s{2}/.test(b[f])) warn(id, `überzählige Leerzeichen in „${f}“`);
    }
    if (b.id && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(b.id)) err(id, 'ID nur aus Kleinbuchstaben, Ziffern und Bindestrichen bilden (steht in Links)');
    if (ids.has(b.id)) err(id, 'ID doppelt');
    ids.add(b.id);
    if (b.architect && !archById.has(b.architect)) err(id, `unbekannter Architekt „${b.architect}“`);
    if (b.type && !knownTypes.has(b.type)) err(id, `unbekannter Typ „${b.type}“, in data/source.mjs unter typeGroups ergänzen`);
    if (data.styles && !knownStyles.has(b.style)) err(id, `unbekannte Stilrichtung „${b.style}“, in data/source.mjs unter styles ergänzen`);

    // Englische Fassung
    if (data.en) {
      if (!b.en?.text) err(id, 'englischer Text fehlt (data/i18n-en.mjs)');
      if (b.country && !data.en.countries[b.country]) err(id, `Land „${b.country}“ fehlt in data/i18n-en.mjs (countries)`);
      if (b.type && !data.en.types[b.type]) err(id, `Typ „${b.type}“ fehlt in data/i18n-en.mjs (types)`);
    }

    if (!Number.isInteger(b.year) || b.year < 1850 || b.year > year + 10) err(id, `Baujahr „${b.year}“ unplausibel`);
    else {
      // Bau vor dem 18. Geburtstag des Architekten bzw. vor der Gründung des Büros
      const meta = archById.get(b.architect)?.meta || '';
      const born = meta.match(/(\d{4})–/), founded = meta.match(/gegründet (\d{4})/);
      if (born && b.year < +born[1] + 18) warn(id, `Baujahr ${b.year} liegt vor dem 18. Geburtstag des Architekten (${born[1]})`);
      if (founded && b.year < +founded[1]) warn(id, `Baujahr ${b.year} liegt vor der Gründung des Büros (${founded[1]})`);
    }

    if (!(Math.abs(b.lat) <= 90 && Math.abs(b.lng) <= 180) || (b.lat === 0 && b.lng === 0)) err(id, `ungültige Koordinaten ${b.lat}, ${b.lng}`);
    if (b.wiki != null && !/^https:\/\/\S+$/.test(b.wiki)) err(id, `Link „${b.wiki}“ ist keine https-Adresse`);

    if (typeof b.text === 'string') {
      if (b.text.length < 50) warn(id, `Kurztext sehr kurz (${b.text.length} Zeichen)`);
      if (b.text.length > 220) warn(id, `Kurztext lang (${b.text.length} Zeichen), passt nicht mehr gut auf die Infokarte`);
      if (!/[.!?“”")]$/.test(b.text.trim())) warn(id, 'Kurztext endet ohne Satzzeichen');
    }

    // Fotos: [Commons-Pfad, Urheber, Lizenz]
    const ph = Array.isArray(b.ph) ? b.ph : [];
    if (ph.length < PHOTOS) fewPhotos.push(`${id} (${ph.length})`);
    const own = new Set();
    for (const p of ph) {
      const [path, author, license] = Array.isArray(p) ? p : [];
      if (!path) { err(id, 'Foto ohne Pfad'); continue; }
      if (!/^https:\/\//.test(path) && !/^[0-9a-f]\/[0-9a-f]{2}\/[^/]+$/.test(path)) err(id, `Fotopfad „${path}“ hat ein unbekanntes Format`);
      if (own.has(path)) err(id, `Foto doppelt: ${path}`);
      own.add(path);
      if (!author) warn(id, `Foto ohne Urheber: ${path}`);
      if (!license) warn(id, `Foto ohne Lizenzangabe: ${path}`);
      if (!photoUse.has(path)) photoUse.set(path, []);
      photoUse.get(path).push(id);
    }
  }
  for (const [path, users] of photoUse) if (users.length > 1) warn(users.join(' + '), `nutzen dasselbe Foto ${path}`);
  if (fewPhotos.length) warn(`${fewPhotos.length} Bauten`, `weniger als ${PHOTOS} Fotos: ${fewPhotos.join(', ')}`);

  // Gleicher Name in derselben Stadt
  const seen = new Map();
  for (const b of data.buildings) {
    const key = fold(`${b.name}|${b.city}`);
    if (seen.has(key)) warn(b.id, `gleicher Name und Ort wie ${seen.get(key)}`);
    else seen.set(key, b.id);
  }

  // Bauten einer Stadt sollten beieinander liegen
  const cities = new Map();
  for (const b of data.buildings) {
    const key = `${b.city}|${b.country}`;
    if (!cities.has(key)) cities.set(key, []);
    cities.get(key).push(b);
  }
  for (const list of cities.values()) {
    if (list.length < 2) continue;
    const mid = [median(list.map((b) => b.lat)), median(list.map((b) => b.lng))];
    for (const b of list) {
      const d = km([b.lat, b.lng], mid);
      if (d > CITY_RADIUS_KM) warn(b.id, `liegt ${Math.round(d)} km von den übrigen Bauten in ${b.city} entfernt`);
    }
  }

  // Quelldaten und erzeugte Datei müssen zusammenpassen
  if (source) {
    const out = new Map(data.buildings.map((b) => [b.id, b]));
    const qids = new Map();
    for (const s of source.buildings) {
      if (s.qid && !/^Q\d+$/.test(s.qid)) err(s.id, `Wikidata-ID „${s.qid}“ hat ein falsches Format`);
      if (s.qid && qids.has(s.qid)) err(s.id, `gleiche Wikidata-ID ${s.qid} wie ${qids.get(s.qid)}, steht der Bau doppelt drin?`);
      if (s.qid) qids.set(s.qid, s.id);
      const b = out.get(s.id);
      if (!b) { err(s.id, 'fehlt in data/buildings.js, node tools/build-data.mjs ausführen'); continue; }
      const changed = ['architect', 'name', 'city', 'country', 'year', 'type', 'text'].filter((f) => s[f] !== b[f]);
      if (s.style && s.style !== b.style) changed.push('style');
      if (changed.length) err(s.id, `data/buildings.js ist veraltet (${changed.join(', ')}), node tools/build-data.mjs ausführen`);
    }
    const inSource = new Set(source.buildings.map((s) => s.id));
    for (const b of data.buildings) if (!inSource.has(b.id)) err(b.id, 'steht nicht mehr in data/source.mjs, node tools/build-data.mjs ausführen');
  }

  // Abgleich mit Wikidata
  if (facts && source) {
    const out = new Map(data.buildings.map((b) => [b.id, b]));
    for (const s of source.buildings) {
      const f = s.qid && facts[s.qid];
      const b = out.get(s.id);
      if (!s.qid || !b) continue;
      if (!f) { warn(s.id, `Wikidata-Eintrag ${s.qid} nicht gefunden`); continue; }
      if (f.redirect) warn(s.id, `Wikidata-ID ${s.qid} ist eine Weiterleitung auf ${f.redirect}`);
      if (f.countries.length) {
        const names = [s.country, ...(COUNTRY_ALIASES[s.country] || [])].map(fold);
        const ok = f.countries.some((label) => names.some((n) => fold(label).includes(n)));
        if (!ok) warn(s.id, `Land „${s.country}“, Wikidata sagt „${f.countries.join(' / ')}“`);
      }
      if (f.coord && !s.coord) {
        const m = km([b.lat, b.lng], f.coord) * 1000;
        if (m > WIKIDATA_OFFSET_M) warn(s.id, `Koordinate liegt ${Math.round(m)} m neben der von Wikidata, Grundriss (osm) prüfen`);
      }
    }
  }

  return { errors, warnings };
}

/* ---------------- Wikidata ---------------- */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { headers: UA });
    if (res.ok) return res.json();
    // Wikidata drosselt schnelle Folgeanfragen (429) und nennt die Wartezeit
    const retry = Number(res.headers.get('retry-after'));
    await wait(retry > 0 ? retry * 1000 : 3000 * (attempt + 1));
  }
  throw new Error('Wikidata nicht erreichbar: ' + url);
}
const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const WD = 'https://www.wikidata.org/w/api.php?action=wbgetentities&format=json';

// Land (P17, deutsche Bezeichnung) und Koordinate (P625) je Wikidata-ID
export async function wikidataFacts(qids) {
  const facts = {};
  const countryIds = new Set();
  for (const group of chunks(qids, 50)) {
    const j = await api(`${WD}&props=claims&ids=${group.join('|')}`);
    for (const [id, e] of Object.entries(j.entities)) {
      if (e.missing !== undefined) continue;
      const claims = (p) => (e.claims?.[p] || []).map((c) => c.mainsnak?.datavalue?.value).filter(Boolean);
      const c = claims('P625')[0];
      const countries = claims('P17').map((v) => v.id);
      countries.forEach((q) => countryIds.add(q));
      facts[id] = { coord: c && [c.latitude, c.longitude], countries, redirect: e.id !== id ? e.id : null };
    }
    await wait(300);
  }
  const labels = {};
  for (const group of chunks([...countryIds], 50)) {
    const j = await api(`${WD}&props=labels&languages=de|en&ids=${group.join('|')}`);
    for (const [id, e] of Object.entries(j.entities)) labels[id] = e.labels?.de?.value || e.labels?.en?.value || id;
  }
  for (const f of Object.values(facts)) f.countries = f.countries.map((q) => labels[q] || q);
  return facts;
}

/* ---------------- Ausführen ---------------- */

export async function loadBuilt() {
  const code = await readFile(new URL('../data/buildings.js', import.meta.url), 'utf8');
  const sandbox = { window: {} };
  vm.runInNewContext(code, sandbox);
  return sandbox.window.FORMATLAS_DATA;
}

// Gibt den Bericht aus und liefert den Exit-Code (1 bei Fehlern)
export async function runChecks({ online = false } = {}) {
  const source = await import('../data/source.mjs');
  const data = await loadBuilt();
  if (!data.groups) data.groups = source.typeGroups; // ältere buildings.js ohne Typliste
  let facts = null;
  if (online) {
    try {
      facts = await wikidataFacts(source.buildings.map((b) => b.qid).filter(Boolean));
    } catch (e) {
      console.warn(`Wikidata-Abgleich übersprungen: ${e.message}`);
    }
  }
  const { errors, warnings } = checkData({ data, source, facts });
  const n = data.buildings.length;
  console.log(
    `\nDatenprüfung${facts ? ' mit Wikidata-Abgleich' : ''}: ${n} Bauten, ${data.architects.length} Architekten, ` +
      `${new Set(data.buildings.map((b) => `${b.city}|${b.country}`)).size} Städte, ${new Set(data.buildings.map((b) => b.country)).size} Länder`
  );
  for (const e of errors) console.log(`  FEHLER   ${e}`);
  for (const w of warnings) console.log(`  Warnung  ${w}`);
  console.log(`${errors.length} Fehler, ${warnings.length} Warnungen\n`);
  return errors.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runChecks({ online: process.argv.includes('--online') });
}
