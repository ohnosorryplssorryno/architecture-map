// Gebäudegrundrisse aus OpenStreetMap (OSM-API), für die goldene 3D-Hervorhebung.
// Reihenfolge der Suche:
//   1. OSM-IDs aus der Quelle (osm: ['w123']) oder aus Wikidata (P10689 Way, P402 Relation).
//      Verweist Wikidata auf ein Gelände (Schule, Campus), gilt das größte Gebäude darauf.
//   2. Gebäude rund um den Punkt mit passendem wikidata-Tag
//   3. Gebäude mit passendem architect-Tag (z. B. „Hadid“) in höchstens 150 m Entfernung
//   4. Das kleinste Gebäude, das den Punkt enthält
// Ergebnis: { osm, fp: [Ringe in lng/lat], fh: [[Höhe, Basis] je Ring], c: [lng, lat], r: Radius in m }
// oder { none: true }

const API = 'https://api.openstreetmap.org/api/0.6';
const UA = { 'User-Agent': 'FormatlasBuild/1.0 (architecture map; build script)' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function osm(path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(API + path, { headers: UA });
    if (res.ok) { await wait(700); return res.json(); }
    if (res.status === 404 || res.status === 410) return { elements: [] };
    await wait(3000 * (attempt + 1));
  }
  throw new Error('OSM-API nicht erreichbar: ' + path);
}

/* ---------- Geometrie ---------- */

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
// lokale Projektion in Metern um einen Bezugspunkt
const toXY = ([lng, lat], [lng0, lat0]) => [rad(lng - lng0) * R * Math.cos(rad(lat0)), rad(lat - lat0) * R];
const dist = (a, b) => Math.hypot(...toXY(a, b));

function insideRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function ringArea(ring, ref) {
  let a = 0;
  const p = ring.map((c) => toXY(c, ref));
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j][0] * p[i][1] - p[i][0] * p[j][1];
  return Math.abs(a / 2);
}

function simplify(ring, tolerance = 0.8) {
  const ref = ring[0];
  const pts = ring.map((c) => toXY(c, ref));
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const segDist = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = dx * dx + dy * dy || 1e-12;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len));
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  };
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let max = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = segDist(pts[i], pts[s], pts[e]);
      if (d > max) { max = d; idx = i; }
    }
    if (max > tolerance) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  const out = ring.filter((_, i) => keep[i]);
  return out.length >= 4 ? out : ring;
}

// Way-Stücke einer Multipolygon-Relation zu geschlossenen Ringen verbinden
function assemble(lines) {
  const pool = lines.map((l) => l.slice());
  const rings = [];
  while (pool.length) {
    let cur = pool.shift();
    for (let guard = 0; guard < 500 && cur[0] !== cur[cur.length - 1]; guard++) {
      const end = cur[cur.length - 1];
      const i = pool.findIndex((l) => l[0] === end || l[l.length - 1] === end);
      if (i < 0) break;
      const next = pool.splice(i, 1)[0];
      cur = cur.concat((next[0] === end ? next : next.reverse()).slice(1));
    }
    if (cur.length > 3 && cur[0] === cur[cur.length - 1]) rings.push(cur);
  }
  return rings;
}

function indexElements(elements) {
  const nodes = new Map(), ways = new Map(), rels = new Map();
  for (const e of elements) {
    if (e.type === 'node') nodes.set(e.id, [e.lon, e.lat]);
    else if (e.type === 'way') ways.set(e.id, e);
    else if (e.type === 'relation') rels.set(e.id, e);
  }
  return { nodes, ways, rels };
}

// Außenringe eines Elements als Koordinatenlisten (oder null bei fehlenden Knoten)
function outerRings(el, idx) {
  const coords = (ids) => {
    const c = ids.map((id) => idx.nodes.get(id));
    return c.every(Boolean) ? c : null;
  };
  if (el.type === 'way') {
    if (el.nodes[0] !== el.nodes[el.nodes.length - 1]) return [];
    const c = coords(el.nodes);
    return c ? [c] : null;
  }
  const lines = [];
  for (const m of el.members || []) {
    if (m.type !== 'way' || (m.role && m.role !== 'outer')) continue;
    const w = idx.ways.get(m.ref);
    if (!w) return null;
    lines.push(w.nodes);
  }
  const rings = assemble(lines).map(coords);
  return rings.some((r) => !r) ? null : rings;
}

// Höhe wie im OpenMapTiles-Schema: height, sonst Geschosse × 3,66 m, sonst 5 m
const num = (v) => {
  const m = /^\s*(-?[\d.]+)\s*(m|meters?|metres?)?\s*$/i.exec(String(v ?? ''));
  return m ? parseFloat(m[1]) : null;
};
function heightOf(t = {}) {
  const levels = num(t['building:levels']);
  const minLevel = num(t['building:min_level']);
  const h = num(t.height) ?? (levels != null ? levels * 3.66 : 5);
  const m = num(t.min_height) ?? (minLevel != null ? minLevel * 3.66 : 0);
  return { h: Math.round(h * 10) / 10, m: Math.round(m * 10) / 10 };
}
const part = (ring, tags) => ({ ring, ...heightOf(tags) });

const isBuilding = (t = {}) => (t.building && t.building !== 'no') || t['building:part'];
const ref = (el) => (el.type === 'way' ? 'w' : 'r') + el.id;

/* ---------- Suche ---------- */

// Liefert die Außenringe der Gebäude unter den Referenzen; Flächen ohne
// building-Tag (Gelände) landen in `sites`.
async function fullGeometry(refs, checkTags = false) {
  const rings = [];
  const sites = [];
  for (const r of refs) {
    const kind = r[0] === 'w' ? 'way' : 'relation';
    if (checkTags) {
      // Wikidata verweist manchmal auf Flughäfen, Bahnstrecken oder Gelände: erst Tags prüfen
      const head = (await osm(`/${kind}/${r.slice(1)}.json`)).elements[0];
      if (!isBuilding(head?.tags)) {
        const area = head && (kind === 'relation' ? head.tags?.type === 'multipolygon' : head.nodes[0] === head.nodes.at(-1));
        if (area && !head.tags?.aeroway && !head.tags?.route) sites.push(r);
        continue;
      }
    }
    const data = await osm(`/${kind}/${r.slice(1)}/full.json`);
    const idx = indexElements(data.elements);
    const el = (kind === 'way' ? idx.ways : idx.rels).get(Number(r.slice(1)));
    if (!el) continue;
    if (!isBuilding(el.tags)) { sites.push(r); continue; }
    rings.push(...(outerRings(el, idx) || []).map((ring) => part(ring, el.tags)));
  }
  return { rings, sites };
}

// Größtes Gebäude (und alle mit mindestens 40 % seiner Fläche) auf einem Gelände
async function buildingsOnSite(ref) {
  const kind = ref[0] === 'w' ? 'way' : 'relation';
  const data = await osm(`/${kind}/${ref.slice(1)}/full.json`);
  const idx = indexElements(data.elements);
  const site = outerRings((kind === 'way' ? idx.ways : idx.rels).get(Number(ref.slice(1))), idx);
  if (!site?.length) return [];
  const pts = site.flat();
  const box = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
  if ((box[2] - box[0]) * (box[3] - box[1]) > 0.0002) return []; // zu groß für eine Abfrage
  const map = indexElements((await osm(`/map.json?bbox=${box.join(',')}`)).elements);
  const found = [];
  for (const el of map.ways.values()) {
    if (!isBuilding(el.tags) || el.tags['building:part']) continue;
    const rings = outerRings(el, map);
    if (!rings?.length) continue;
    const ring = rings[0];
    const c = [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
    if (site.some((sr) => insideRing(c, sr))) found.push({ ref: ref0(el), ring, tags: el.tags, area: ringArea(ring, ring[0]) });
  }
  const max = Math.max(0, ...found.map((f) => f.area));
  return found.filter((f) => f.area >= max * 0.4);
}
const ref0 = (el) => (el.type === 'way' ? 'w' : 'r') + el.id;

export async function findFootprint({ qid, lat, lng, osmRefs = [], match = '' }) {
  const architectRe = match ? new RegExp(match, 'i') : null;
  const P = [lng, lat];
  let refs = osmRefs;
  let { rings, sites } = refs.length ? await fullGeometry(refs, true) : { rings: [], sites: [] };
  if (!rings.length && sites.length) {
    const onSite = await buildingsOnSite(sites[0]);
    refs = onSite.map((f) => f.ref);
    rings = onSite.map((f) => part(f.ring, f.tags));
  }

  if (!rings.length) {
    const d = 0.0012;
    const dl = d / Math.cos(rad(lat));
    const data = await osm(`/map.json?bbox=${lng - dl},${lat - d},${lng + dl},${lat + d}`);
    const idx = indexElements(data.elements);
    const cands = [];
    for (const el of [...idx.ways.values(), ...idx.rels.values()]) {
      if (!el.tags || !(el.tags.building && el.tags.building !== 'no')) continue;
      const r = outerRings(el, idx);
      cands.push({ el, rings: r });
    }
    const contains = (c) => c.rings?.some((ring) => insideRing(P, ring));
    const near = (c) => c.rings?.some((ring) => ring.some((pt) => dist(pt, P) < 150)) || contains(c);
    let pick = cands.filter((c) => qid && c.el.tags.wikidata === qid);
    if (!pick.length && architectRe) pick = cands.filter((c) => architectRe.test(c.el.tags.architect || '') && near(c));
    if (!pick.length) {
      const inside = cands.filter(contains);
      inside.sort((a, b) => ringArea(a.rings[0], P) - ringArea(b.rings[0], P));
      pick = inside.slice(0, 1);
    }
    refs = pick.map((c) => ref(c.el));
    // Relationen und unvollständige Ways vollständig nachladen
    const complete = pick.filter((c) => c.rings && c.el.type === 'way');
    const reload = pick.filter((c) => !c.rings || c.el.type === 'relation').map((c) => ref(c.el));
    rings = complete.flatMap((c) => c.rings.map((ring) => part(ring, c.el.tags))).concat(reload.length ? (await fullGeometry(reload)).rings : []);
  }

  if (!rings.length) return { none: true };

  const simple = rings.map((p) => simplify(p.ring).map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6]));
  // Mittelpunkt: flächengewichtetes Mittel der Ringschwerpunkte (genügt für Gebäude)
  let ax = 0, ay = 0, at = 0;
  for (const ring of simple) {
    const a = ringArea(ring, ring[0]) || 1;
    const n = ring.length - 1;
    const cx = ring.slice(0, n).reduce((s, p) => s + p[0], 0) / n;
    const cy = ring.slice(0, n).reduce((s, p) => s + p[1], 0) / n;
    ax += cx * a; ay += cy * a; at += a;
  }
  const c = [Math.round((ax / at) * 1e6) / 1e6, Math.round((ay / at) * 1e6) / 1e6];
  const r = Math.round(Math.max(...simple.flat().map((pt) => dist(pt, c))));
  return { osm: refs, fp: simple, fh: rings.map((p) => [p.h, p.m]), c, r };
}
