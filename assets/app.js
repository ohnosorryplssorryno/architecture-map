(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // Einstellungen im Browser; ohne Speicherzugriff gelten die Vorgaben
  const prefs = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(`formatlas:${key}`);
        return v == null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try { localStorage.setItem(`formatlas:${key}`, JSON.stringify(value)); } catch {}
    },
  };

  /* ---------------- Sprache ----------------
     Reihenfolge: ?lang= im Link, sonst die zuletzt gewählte Sprache, sonst die des Browsers */

  const I18N = window.FORMATLAS_I18N || { de: {}, en: {} };
  const LANGS = ['de', 'en'];
  const browserLang = (navigator.languages || [navigator.language || '']).some((l) => /^de\b/i.test(l)) ? 'de' : 'en';
  let lang = (() => {
    const q = new URLSearchParams(location.search).get('lang');
    if (LANGS.includes(q)) return q;
    const saved = prefs.get('lang', null);
    return LANGS.includes(saved) ? saved : browserLang;
  })();

  function t(key, ...args) {
    const v = I18N[lang]?.[key] ?? I18N.de?.[key];
    return typeof v === 'function' ? v(...args) : (v ?? key);
  }

  // Feste Texte im HTML: data-i18n (Text), -title, -placeholder, -aria
  function applyStatic() {
    document.documentElement.lang = lang;
    for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
    for (const el of document.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
    for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
    $('lang').lang = lang === 'de' ? 'en' : 'de';
    $('card-media').dataset.empty = t('noPhoto');
  }

  /* ---------------- Hinweise bei Ladeproblemen ---------------- */

  const noticeEl = $('notice');
  const notice = {
    kind: null,
    action: null,
    dismissed: new Set(), // weggeklickte Hinweise bleiben zu, bis sich die Lage ändert
    // fatal: Die Karte fehlt ganz, der Hinweis steht groß in der Kartenfläche und bleibt
    show(kind, { title, text, fatal = false, action = null }) {
      if (!fatal && (notice.dismissed.has(kind) || (!noticeEl.hidden && noticeEl.classList.contains('is-fatal')))) return;
      notice.kind = kind;
      notice.action = action;
      $('notice-title').textContent = title;
      $('notice-text').textContent = text;
      $('notice-action').hidden = !action;
      if (action) $('notice-action').textContent = action.label;
      $('notice-close').hidden = fatal;
      noticeEl.classList.toggle('is-fatal', fatal);
      noticeEl.hidden = false;
    },
    hide(kind) {
      if (kind && notice.kind !== kind) return;
      notice.kind = null;
      noticeEl.hidden = true;
    },
  };
  $('notice-action').addEventListener('click', () => notice.action?.run());
  $('notice-close').addEventListener('click', () => {
    if (notice.kind) notice.dismissed.add(notice.kind);
    notice.hide();
  });
  const reloadPage = () => ({ label: t('retry'), run: () => location.reload() });

  const DATA = window.FORMATLAS_DATA;
  if (!DATA) {
    document.body.classList.add('no-map', 'no-data');
    const [title, text] = t('dataFail');
    notice.show('data', { title, text, fatal: true, action: reloadPage() });
    return;
  }

  const { architects, buildings } = DATA;
  const NEUTRAL = '#e6e1d8'; // Cluster mit Bauten verschiedener Architekten
  const FID_OFFSET = 1e6; // Abstand zu den Cluster-IDs von MapLibre
  const EARTH = 40075016.686; // Erdumfang in Metern
  const CLOSE_ZOOM = 14; // ab hier verschwinden die Punkte, der Lichtschein bleibt
  const DOCK_ZOOM = 12.5; // ab hier sitzt die Infokarte am Rand statt über dem Punkt
  const CITY_ZOOM = 13.2; // höchster Zoom beim Städteflug, die Punkte bleiben sichtbar
  const WORLD_CENTER = [20, 30];
  const SLIDE_MS = 2800; // Standzeit eines Fotos in der Vorschau
  const BIN = 5; // Jahre pro Balken im Histogramm
  const ORBIT_SPEED = 4; // Grad pro Sekunde beim Rundflug um ein Gebäude
  const TOUR_DWELL = 9000; // Standzeit je Bau im Rundgang (drei Fotos)
  const THUMBS = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/';
  const ORIGINALS = 'https://upload.wikimedia.org/wikipedia/commons/';

  // Gebäudetypen und Stilrichtungen (gepflegt in data/source.mjs)
  const GROUPS = (DATA.groups || []).map((g) => ({ ...g }));
  const STYLES = DATA.styles || [];
  const EN = DATA.en || { countries: {}, cities: {}, types: {} };

  const mqHover = matchMedia('(hover: hover) and (pointer: fine)');
  const mqNarrow = matchMedia('(max-width: 640px)');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const normalize = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  const rad = (d) => (d * Math.PI) / 180;
  const num = (v, digits) => v.toLocaleString(t('locale'), { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const fmtDeg = (v, pos, neg) => `${num(Math.abs(v), 4)}° ${v >= 0 ? pos : neg}`;
  const fmtKm = (km) => (km < 1 ? `${Math.round(km * 1000)} m` : `${num(km, km < 10 ? 1 : 0)} km`);
  // Foto-Pfad aus Wikimedia Commons → Thumbnail-URL in Standardbreite
  const photoUrl = (path, width) => (path.startsWith('http') ? path : `${THUMBS}${path}/${width}px-${path.split('/').pop()}`);
  const originalUrl = (path) => (path.startsWith('http') ? path : ORIGINALS + path);

  let toastTimer = 0;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-visible'), 2000);
  }

  /* ---------------- Daten ---------------- */

  const archById = new Map(architects.map((a) => [a.id, a]));
  const styleById = new Map(STYLES.map((st) => [st.id, st]));
  const groupOfType = new Map(GROUPS.flatMap((g) => g.types.map((ty) => [ty, g.id])));
  const cityKey = (b) => `${b.city}|${b.country}`;

  // Texte in der gewählten Sprache (Englisch fällt auf Deutsch zurück)
  const nameOf = (b) => (lang === 'en' && b.en?.name) || b.name;
  const textOf = (b) => (lang === 'en' && b.en?.text) || b.text;
  const cityOf = (b) => (lang === 'en' && EN.cities[b.city]) || b.city;
  const countryOf = (b) => (lang === 'en' && EN.countries[b.country]) || b.country;
  const typeOf = (b) => (lang === 'en' && EN.types[b.type]) || b.type;
  const metaOf = (a) => (lang === 'en' && a.en?.meta) || a.meta;
  const groupLabel = (g) => (lang === 'en' && g.en) || g.label;
  const styleLabel = (id) => { const st = styleById.get(id); return st ? (lang === 'en' ? st.en : st.label) : ''; };

  buildings.forEach((b, i) => {
    const a = archById.get(b.architect);
    const st = styleById.get(b.style);
    b.fid = FID_OFFSET + i;
    b.ph ||= []; // Bau ohne Fotos
    b.color = a.color;
    b.group = groupOfType.get(b.type) || 'weitere';
    // Suche findet deutsche und englische Namen, Orte, Typen und Stile
    b.search = normalize([b.name, b.en?.name, b.city, EN.cities[b.city], b.country, EN.countries[b.country], b.type, EN.types[b.type],
      st?.label, st?.en, b.year, a.name, a.short].filter(Boolean).join(' '));
    b.words = [...new Set(b.search.split(/[^a-z0-9]+/).filter((w) => w.length >= 3))];
    // Radius des Lichtscheins am Boden in Pixeln bei Zoom 0 (wird mit 2^zoom skaliert)
    b.glow = ((b.r || 45) * 1.8 * 512) / (EARTH * Math.cos(rad(b.lat)));
  });
  if (buildings.some((b) => b.group === 'weitere')) GROUPS.push({ id: 'weitere', label: 'Weitere', en: 'Other', types: [] });

  const byFid = new Map(buildings.map((b) => [b.fid, b]));
  const byId = new Map(buildings.map((b) => [b.id, b]));
  const years = buildings.map((b) => b.year);
  const YEAR_MIN = Math.min(...years);
  const YEAR_MAX = Math.max(...years);
  const allCities = new Map();
  for (const b of buildings) {
    if (!allCities.has(cityKey(b))) allCities.set(cityKey(b), { key: cityKey(b), sample: b, count: 0 });
    allCities.get(cityKey(b)).count++;
  }

  const kmBetween = (a, b) => {
    const s = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
    return 2 * 6371.0088 * Math.asin(Math.sqrt(s));
  };

  // Zielzoom: das Gebäude soll rund 170 px Radius auf dem Bildschirm haben;
  // bei Hochhäusern zählt auch die Höhe, damit die Spitze im Bild bleibt
  const flyZoom = (b) => {
    if (b.zoom) return b.zoom;
    if (!b.r) return 16;
    const size = Math.max(b.r, 25, (b.h || 0) * 0.6);
    return clamp(Math.log2((170 * EARTH * Math.cos(rad(b.lat))) / (512 * size)), 13.4, 17.6);
  };

  const state = {
    architects: new Set(), // leer = alle
    groups: new Set(), // leer = alle Typen
    styles: new Set(), // leer = alle Stile
    query: '',
    terms: [],
    fuzzy: false, // keine genauen Treffer: unscharfe Suche aktiv
    from: YEAR_MIN,
    to: YEAR_MAX,
    visible: buildings,
    view: 'buildings', // Verzeichnis nach Bauten, Städten oder als Galerie
    openCity: null, // aufgeklappte Stadt in der Städteansicht
    hoverCity: null, // Stadtzeile unter dem Mauszeiger
    hoverFid: null, // Punkt unter dem Mauszeiger
    listFid: null, // Zeile unter dem Mauszeiger
    pinnedFid: null, // angeklickter Bau
    flying: false,
  };

  /* ---------------- Unscharfe Suche ---------------- */

  // Editierdistanz höchstens k (Levenshtein mit vorzeitigem Abbruch)
  function within(a, b, k) {
    if (Math.abs(a.length - b.length) > k) return false;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let best = i;
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        best = Math.min(best, cur[j]);
      }
      if (best > k) return false;
      prev = cur;
    }
    return prev[b.length] <= k;
  }
  // Tippfehler: ab 4 Zeichen einer, ab 7 Zeichen zwei; auch als Wortanfang („gugenh“ → Guggenheim)
  const fuzzyWord = (b, term) => {
    const k = term.length >= 7 ? 2 : term.length >= 4 ? 1 : 0;
    return k > 0 && b.words.some((w) => within(w, term, k) || (w.length > term.length && within(w.slice(0, term.length), term, k)));
  };

  /* ---------------- Ansicht im Link ----------------
     ?a=zha,gehry  Architekten     ?t=kultur  Typgruppen    ?st=dekon  Stile    ?y=1990-2010  Baujahre
     ?q=…  Suche    ?b=…  gewählter Bau    ?v=lat,lng,zoom,drehung,neigung  Kartenausschnitt
     ?l=staedte|galerie  Verzeichnisansicht    ?c=Stadt|Land  aufgeklappte Stadt    ?lang=en  Sprache */

  // ready: erst schreiben, wenn der Zustand aus dem Link übernommen ist (Karte eingerichtet)
  const link = { timer: 0, viewSet: false, ready: false };
  const VIEW_PARAM = { cities: 'staedte', gallery: 'galerie' };

  function readLink() {
    const p = new URLSearchParams(location.search);
    const list = (k) => (p.get(k) || '').split(',').filter(Boolean);
    for (const id of list('a')) if (archById.has(id)) state.architects.add(id);
    for (const id of list('t')) if (GROUPS.some((g) => g.id === id)) state.groups.add(id);
    for (const id of list('st')) if (styleById.has(id)) state.styles.add(id);
    const y = (p.get('y') || '').match(/^(\d{4})(?:-(\d{4}))?$/);
    if (y) {
      const a = clamp(+y[1], YEAR_MIN, YEAR_MAX), b = clamp(+(y[2] || y[1]), YEAR_MIN, YEAR_MAX);
      state.from = Math.min(a, b);
      state.to = Math.max(a, b);
    }
    if (p.get('q')) state.query = p.get('q');
    const view = Object.keys(VIEW_PARAM).find((k) => VIEW_PARAM[k] === p.get('l'));
    if (view) state.view = view;
    if (state.view === 'cities' && allCities.has(p.get('c'))) state.openCity = p.get('c');
    const v = (p.get('v') || '').split(',').map(Number);
    const cam =
      v.length >= 3 && v.every(Number.isFinite) && Math.abs(v[0]) <= 90 && Math.abs(v[1]) <= 180
        ? { center: [v[1], v[0]], zoom: clamp(v[2], 0.4, 19), bearing: v[3] || 0, pitch: clamp(v[4] || 0, 0, 70) }
        : null;
    // ältere Links: #gebäude-id
    let legacy = '';
    try { legacy = decodeURIComponent(location.hash.slice(1)); } catch {} // kaputte Kodierung ignorieren
    return { view: cam, building: byId.get(p.get('b') || legacy) || null };
  }

  function writeLink(now = false) {
    clearTimeout(link.timer);
    if (!now) { link.timer = setTimeout(() => writeLink(true), 250); return; }
    if (!link.ready || state.flying) return; // nach der Landung schreibt land() den Link
    const p = new URLSearchParams();
    if (state.query.trim()) p.set('q', state.query.trim());
    if (state.architects.size) p.set('a', architects.filter((a) => state.architects.has(a.id)).map((a) => a.id).join(','));
    if (state.groups.size) p.set('t', GROUPS.filter((g) => state.groups.has(g.id)).map((g) => g.id).join(','));
    if (state.styles.size) p.set('st', STYLES.filter((st) => state.styles.has(st.id)).map((st) => st.id).join(','));
    if (state.from > YEAR_MIN || state.to < YEAR_MAX) p.set('y', state.from === state.to ? state.from : `${state.from}-${state.to}`);
    if (VIEW_PARAM[state.view]) p.set('l', VIEW_PARAM[state.view]);
    // aufgeklappte Stadt nur, wenn sie unter den Filtern sichtbar ist
    if (state.view === 'cities' && state.openCity && state.visible.some((b) => cityKey(b) === state.openCity)) p.set('c', state.openCity);
    const b = state.pinnedFid != null && byFid.get(state.pinnedFid);
    if (b) p.set('b', b.id);
    if (map && link.viewSet) {
      const c = map.getCenter();
      const v = [c.lat.toFixed(5), c.lng.toFixed(5), map.getZoom().toFixed(2), Math.round(map.getBearing()), Math.round(map.getPitch())];
      p.set('v', v.join(',').replace(/(,0)+$/, ''));
    }
    // Sprache nur, wenn sie von der des Browsers abweicht (bewusst umgeschaltet)
    if (lang !== browserLang) p.set('lang', lang);
    const qs = p.toString().replace(/%2C/g, ',').replace(/%7C/g, '|');
    const next = location.pathname + (qs ? `?${qs}` : '');
    if (next !== location.pathname + location.search + location.hash) history.replaceState(null, '', next);
  }

  /* ---------------- Verzeichnis ---------------- */

  const panel = $('panel');
  const panelBody = $('panel-body');
  const panelToggle = $('panel-toggle');
  const indexEl = $('index');
  const searchEl = $('search');
  const fromEl = $('year-from');
  const toEl = $('year-to');
  const filtersEl = $('filters');

  for (const el of [fromEl, toEl]) {
    el.min = YEAR_MIN;
    el.max = YEAR_MAX;
  }

  const termMatch = (b, term) => b.search.includes(term) || (state.fuzzy && fuzzyWord(b, term));

  // Filterprüfung; `skip` lässt Filter weg (für die Zähler dieser Filter)
  function passes(b, ...skip) {
    if (!skip.includes('arch') && state.architects.size && !state.architects.has(b.architect)) return false;
    if (state.terms.length && !state.terms.every((term) => termMatch(b, term))) return false;
    if (!skip.includes('year') && (b.year < state.from || b.year > state.to)) return false;
    if (!skip.includes('group') && state.groups.size && !state.groups.has(b.group)) return false;
    if (!skip.includes('style') && state.styles.size && !state.styles.has(b.style)) return false;
    return true;
  }

  // Bauten je Zeitraum und Architekt unter Suche, Typ- und Stilfilter (ohne Jahr- und Architektenfilter)
  function yearBins() {
    const bins = new Map();
    for (const b of buildings) {
      if (!passes(b, 'year', 'arch')) continue;
      const start = Math.floor(b.year / BIN) * BIN;
      if (!bins.has(start)) bins.set(start, { total: 0, by: new Map() });
      const bin = bins.get(start);
      bin.total++;
      bin.by.set(b.architect, (bin.by.get(b.architect) || 0) + 1);
    }
    return bins;
  }

  const filtersActive = () =>
    state.architects.size > 0 || state.from > YEAR_MIN || state.to < YEAR_MAX || state.groups.size > 0 || state.styles.size > 0;

  const countBy = (skip, key) => {
    const counts = new Map();
    for (const b of buildings) if (passes(b, skip)) counts.set(key(b), (counts.get(key(b)) || 0) + 1);
    return counts;
  };

  function renderArchitects() {
    const counts = countBy('arch', (b) => b.architect);
    $('arch-chips').innerHTML = architects
      .map((a) => {
        const n = counts.get(a.id) || 0;
        const on = state.architects.has(a.id);
        return `<button type="button" class="chip arch-chip" data-arch="${a.id}" aria-pressed="${on}" style="--c:${a.color}"
          title="${esc(t('archTitle', a.name, metaOf(a)))}" ${n || on ? '' : 'disabled'}><i></i>${esc(a.short)}<span>${n}</span></button>`;
      })
      .join('');
    $('arch-chips').classList.toggle('has-selection', state.architects.size > 0);
    $('arch-count').textContent = state.architects.size ? t('ofTotal', state.architects.size, architects.length) : `${architects.length}`;
  }

  const binLabel = (lo, hi, bin, chosen) => {
    const n = bin?.total || 0;
    let label = t('binLabel', `${lo}–${hi}`, n);
    if (chosen.length && n) {
      const own = chosen.filter((a) => bin.by.get(a.id));
      label += own.length ? t('binOwn', own.map((a) => `${a.short} ${bin.by.get(a.id)}`).join(', ')) : t('binNone');
    }
    return label;
  };

  function renderFilters() {
    // Histogramm in 5-Jahres-Schritten. Die Balkenhöhe zählt alle Bauten unter Suche, Typ- und
    // Stilfilter; sind Architekten gewählt, zeigen farbige Abschnitte deren Anteil
    // (Reihenfolge wie bei den Chips, unten beginnend), der Rest bleibt grau.
    const first = Math.floor(YEAR_MIN / BIN) * BIN;
    const bins = Math.floor(YEAR_MAX / BIN) - first / BIN + 1;
    const data = yearBins();
    const max = Math.max(1, ...[...data.values()].map((bin) => bin.total));
    const chosen = architects.filter((a) => state.architects.has(a.id));
    const span = YEAR_MAX - YEAR_MIN || 1;
    let bars = '';
    for (let i = 0; i < bins; i++) {
      const start = first + i * BIN;
      const lo = Math.max(start, YEAR_MIN), hi = Math.min(start + BIN - 1, YEAR_MAX);
      const bin = data.get(start);
      const n = bin?.total || 0;
      const inRange = hi >= state.from && lo <= state.to;
      let parts = '';
      if (chosen.length && n) {
        let own = 0;
        for (const a of chosen) {
          const k = bin.by.get(a.id) || 0;
          own += k;
          if (k) parts += `<i style="--c:${a.color};flex-grow:${k}"></i>`;
        }
        if (n > own) parts += `<i class="rest" style="flex-grow:${n - own}"></i>`;
      }
      bars += `<button type="button" class="bar${inRange ? ' is-in' : ''}" data-lo="${lo}" data-hi="${hi}"
        style="--x:${clamp(((lo + hi) / 2 - YEAR_MIN) / span, 0, 1)};--h:${n / max}" aria-label="${esc(binLabel(lo, hi, bin, chosen))}"
        aria-pressed="${state.from === lo && state.to === hi}">${parts}</button>`;
    }
    const hist = $('histogram');
    hist.innerHTML = bars;
    hist.classList.toggle('is-split', chosen.length > 0);
    hist.style.setProperty('--n', bins);
    $('range').style.setProperty('--a', (state.from - YEAR_MIN) / span);
    $('range').style.setProperty('--b', (state.to - YEAR_MIN) / span);
    fromEl.value = state.from;
    toEl.value = state.to;
    $('year-output').textContent = state.from === state.to ? String(state.from) : `${state.from} – ${state.to}`;
    // Liegen beide Regler übereinander, den greifbar machen, der sich bewegen kann
    fromEl.style.zIndex = state.from === state.to && state.from > (YEAR_MIN + YEAR_MAX) / 2 ? 2 : 1;

    // Typ- und Stil-Chips mit Anzahl unter allen übrigen Filtern
    const groupCounts = countBy('group', (b) => b.group);
    $('type-chips').innerHTML = GROUPS.map((g) => {
      const n = groupCounts.get(g.id) || 0;
      const on = state.groups.has(g.id);
      const types = g.types.map((ty) => (lang === 'en' && EN.types[ty]) || ty).join(', ');
      return `<button type="button" class="chip" data-group="${g.id}" aria-pressed="${on}" title="${esc(types)}"
        ${n || on ? '' : 'disabled'}>${esc(groupLabel(g))}<span>${n}</span></button>`;
    }).join('');
    const styleCounts = countBy('style', (b) => b.style);
    $('style-chips').innerHTML = STYLES.map((st) => {
      const n = styleCounts.get(st.id) || 0;
      const on = state.styles.has(st.id);
      return `<button type="button" class="chip" data-style="${st.id}" aria-pressed="${on}"
        ${n || on ? '' : 'disabled'}>${esc(styleLabel(st.id))}<span>${n}</span></button>`;
    }).join('');

    $('filters-state').textContent = [
      ...GROUPS.filter((g) => state.groups.has(g.id)).map(groupLabel),
      ...STYLES.filter((st) => state.styles.has(st.id)).map((st) => styleLabel(st.id)),
    ].join(', ');
    $('filter-reset').hidden = !filtersActive();
  }

  function renderResult() {
    const n = state.visible.length;
    const cities = new Set(state.visible.map(cityKey)).size;
    const countries = new Set(state.visible.map((b) => b.country)).size;
    $('count-buildings').textContent = n;
    $('label-buildings').textContent = t('buildings', n);
    $('count-cities').textContent = cities;
    $('label-cities').textContent = t('cities', cities);
    $('tab-cities').title = t('citiesIn', cities, countries);
    const note = $('fuzzy-note');
    note.hidden = !state.fuzzy;
    if (state.fuzzy) note.textContent = t('fuzzy', state.query.trim());
    renderTourButton();
  }

  const thumbHtml = (b, size = 44) =>
    b.ph[0]
      ? `<img class="row-thumb" src="${esc(photoUrl(b.ph[0][0], 120))}" alt="" width="${size}" height="${size}" loading="lazy" decoding="async">`
      : '<span class="row-thumb is-empty"></span>';

  const rowHtml = (b) =>
    `<li><button class="row${b.fid === state.pinnedFid ? ' is-active' : ''}" type="button" data-fid="${b.fid}" style="--c:${b.color}">
      ${thumbHtml(b)}
      <span class="row-text"><span class="row-name">${esc(nameOf(b))}</span>
      <span class="row-place"><i></i>${esc(archById.get(b.architect).short)} · ${esc(cityOf(b))}</span></span>
      <span class="row-year">${b.year}</span></button></li>`;

  function buildingsHtml() {
    const decades = new Map();
    for (const b of state.visible) {
      const d = Math.floor(b.year / 10) * 10;
      if (!decades.has(d)) decades.set(d, []);
      decades.get(d).push(b);
    }
    let html = '';
    for (const [d, list] of decades) {
      html += `<section><h3 class="decade"><span>${esc(t('decade', d))}</span><span>${list.length}</span></h3><ul class="rows">`;
      html += list.map(rowHtml).join('');
      html += '</ul></section>';
    }
    return html;
  }

  // Städte nach Anzahl der Bauten unter den aktuellen Filtern
  function cityGroups() {
    const cities = new Map();
    for (const b of state.visible) {
      const key = cityKey(b);
      if (!cities.has(key)) cities.set(key, { key, sample: b, list: [] });
      cities.get(key).list.push(b);
    }
    return [...cities.values()].sort((a, b) => b.list.length - a.list.length || cityOf(a.sample).localeCompare(cityOf(b.sample), lang));
  }

  function citiesHtml() {
    let html = '<ul class="cities">';
    for (const c of cityGroups()) {
      const open = c.key === state.openCity;
      const archs = [...new Set(c.list.map((b) => b.architect))].map((id) => archById.get(id));
      const withPhoto = c.list.find((b) => b.ph[0]);
      html += `<li class="city${open ? ' is-open' : ''}">
        <button class="city-row" type="button" data-city="${esc(c.key)}" aria-expanded="${open}" style="--c:${archs[0].color}">
          ${withPhoto ? thumbHtml(withPhoto) : '<span class="row-thumb is-empty"></span>'}
          <span class="row-text"><span class="row-name">${esc(cityOf(c.sample))}</span>
          <span class="row-place">${archs.map((a) => `<i style="--c:${a.color}"></i>`).join('')}${esc(countryOf(c.sample))} · ${esc(archs.map((a) => a.short).join(', '))}</span></span>
          <span class="city-count">${c.list.length}</span>
          <svg class="city-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 8l5 5 5-5" /></svg>
        </button>`;
      if (open) html += `<ul class="rows">${c.list.map(rowHtml).join('')}</ul>`;
      html += '</li>';
    }
    return `${html}</ul>`;
  }

  // Galerie: Fotoraster aller gefilterten Bauten
  function galleryHtml() {
    return `<ul class="gallery">${state.visible
      .map(
        (b) => `<li><button class="tile${b.fid === state.pinnedFid ? ' is-active' : ''}" type="button" data-fid="${b.fid}" style="--c:${b.color}">
        ${b.ph[0] ? `<img src="${esc(photoUrl(b.ph[0][0], 250))}" alt="" loading="lazy" decoding="async">` : '<span class="tile-empty"></span>'}
        <span class="tile-text"><span class="tile-name">${esc(nameOf(b))}</span><span class="tile-meta"><i></i>${esc(archById.get(b.architect).short)} · ${b.year}</span></span>
      </button></li>`
      )
      .join('')}</ul>`;
  }

  function renderIndex() {
    indexEl.classList.toggle('is-gallery', state.view === 'gallery');
    indexEl.innerHTML = !state.visible.length
      ? `<p class="empty">${esc(t('empty'))}</p>`
      : state.view === 'cities' ? citiesHtml() : state.view === 'gallery' ? galleryHtml() : buildingsHtml();
  }

  function markRow(fid) {
    indexEl.querySelector('[data-fid].is-active')?.classList.remove('is-active');
    if (fid == null) return;
    const row = indexEl.querySelector(`[data-fid="${fid}"]`);
    if (!row) return;
    row.classList.add('is-active');
    if (!panel.classList.contains('is-collapsed')) row.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  function syncTabs() {
    for (const tab of document.querySelectorAll('#view-tabs [data-view]')) tab.setAttribute('aria-pressed', String(tab.dataset.view === state.view));
  }

  function setView(view) {
    if (state.view === view) return;
    state.view = view;
    syncTabs();
    const b = state.pinnedFid != null && byFid.get(state.pinnedFid);
    if (view === 'cities' && b) state.openCity = cityKey(b);
    renderIndex();
    renderTourButton();
    indexEl.scrollTop = 0;
    // scrollt das ganze Verzeichnis und liegt der Listenanfang darüber, zurück zum Anfang der Liste
    const above = indexEl.getBoundingClientRect().top - panelBody.getBoundingClientRect().top;
    if (above < 0) panelBody.scrollTop += above - 56;
    markRow(state.pinnedFid);
    writeLink();
  }

  function applyFilter() {
    state.terms = normalize(state.query.trim()).split(/\s+/).filter(Boolean);
    state.fuzzy = false;
    state.visible = buildings.filter((b) => passes(b));
    // keine genauen Treffer: unscharf suchen (Tippfehler, fehlende Buchstaben)
    if (!state.visible.length && state.terms.some((term) => term.length >= 4)) {
      state.fuzzy = true;
      state.visible = buildings.filter((b) => passes(b));
      if (!state.visible.length) state.fuzzy = false;
    }
    map?.getSource('b')?.setData(toGeoJSON(state.visible));
    renderArchitects();
    renderFilters();
    renderResult();
    renderIndex();
    if (state.pinnedFid != null && !state.visible.some((b) => b.fid === state.pinnedFid)) deselect();
    writeLink();
  }

  // animate = false: Kartenabstand nicht sofort anpassen (der folgende Flug übernimmt das)
  function setPanelOpen(open, animate = true) {
    panel.classList.toggle('is-collapsed', !open);
    panelBody.hidden = !open;
    panelToggle.setAttribute('aria-expanded', String(open));
    // während eines Flugs nicht: das würde die Flugetappe abbrechen (land() zieht den Abstand nach)
    if (map && animate && !state.flying) map.easeTo({ padding: panelPadding(), duration: 350 });
  }

  const panelPadding = () =>
    mqNarrow.matches || panel.classList.contains('is-collapsed')
      ? { top: mqNarrow.matches ? 70 : 0, right: 0, bottom: 0, left: 0 }
      : { top: 0, right: 0, bottom: 0, left: panel.offsetWidth + 16 };

  // Zoomstufe, bei der der Globus rund 80 % der freien Fläche füllt
  // (Globusdurchmesser in px = 512 · 2^zoom / π).
  const worldZoom = () => {
    const pad = panelPadding();
    const free = Math.min(innerWidth - pad.left - pad.right, innerHeight - pad.top - pad.bottom);
    return clamp(Math.log2((Math.max(free, 200) * 0.8 * Math.PI) / 512), 0.5, 2.6);
  };

  /* ---------------- Suchvorschläge ---------------- */

  const suggestEl = $('suggest');
  const sug = { items: [], active: -1 };

  function renderSuggest() {
    const q = normalize(searchEl.value.trim());
    if (q.length < 2 || document.activeElement !== searchEl) { hideSuggest(); return; }
    const items = [];
    for (const a of architects) if (normalize(`${a.name} ${a.short}`).includes(q)) items.push({ kind: 'arch', a });
    for (const c of allCities.values()) {
      if (normalize(`${c.sample.city} ${EN.cities[c.sample.city] || ''}`).includes(q)) items.push({ kind: 'city', c });
    }
    let named = buildings.filter((b) => normalize(`${b.name} ${b.en?.name || ''}`).includes(q));
    if (!named.length && q.length >= 4) named = buildings.filter((b) => fuzzyWord(b, q));
    items.push(...named.slice(0, 6).map((b) => ({ kind: 'building', b })));
    sug.items = items.slice(0, 7);
    sug.active = -1;
    if (!sug.items.length) { hideSuggest(); return; }
    suggestEl.innerHTML = sug.items
      .map((it, i) => {
        if (it.kind === 'arch')
          return `<li role="option" id="sug-${i}" data-i="${i}" style="--c:${it.a.color}"><i class="sug-dot"></i><span class="sug-name">${esc(it.a.name)}</span><small>${esc(t('suggestArch'))}</small></li>`;
        if (it.kind === 'city')
          return `<li role="option" id="sug-${i}" data-i="${i}"><svg class="sug-pin" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 17s-5-4.6-5-8.5a5 5 0 0 1 10 0C15 12.4 10 17 10 17z" /><circle cx="10" cy="8.5" r="1.8" /></svg><span class="sug-name">${esc(cityOf(it.c.sample))}</span><small>${esc(t('suggestCity', it.c.count))}</small></li>`;
        const b = it.b;
        return `<li role="option" id="sug-${i}" data-i="${i}" style="--c:${b.color}">${thumbHtml(b, 28)}<span class="sug-name">${esc(nameOf(b))}</span><small>${esc(archById.get(b.architect).short)} · ${b.year}</small></li>`;
      })
      .join('');
    suggestEl.hidden = false;
    searchEl.setAttribute('aria-expanded', 'true');
  }

  function hideSuggest() {
    suggestEl.hidden = true;
    sug.active = -1;
    searchEl.setAttribute('aria-expanded', 'false');
    searchEl.removeAttribute('aria-activedescendant');
  }

  function moveSuggest(dir) {
    if (suggestEl.hidden || !sug.items.length) return false;
    // -1 = Suchfeld selbst; nach dem letzten Vorschlag geht es zurück ins Feld
    let next = sug.active + dir;
    if (next < -1) next = sug.items.length - 1;
    if (next >= sug.items.length) next = -1;
    sug.active = next;
    [...suggestEl.children].forEach((li, i) => li.classList.toggle('is-active', i === sug.active));
    if (sug.active >= 0) searchEl.setAttribute('aria-activedescendant', `sug-${sug.active}`);
    else searchEl.removeAttribute('aria-activedescendant');
    return true;
  }

  // Auswahl: Suche leeren; liegt das Ziel außerhalb der Filter, die Filter zurücksetzen
  function pickSuggest(i) {
    const it = sug.items[i];
    if (!it) return;
    hideSuggest();
    searchEl.value = '';
    state.query = '';
    const resetIfHidden = (test) => {
      applyFilter();
      if (!state.visible.some(test)) {
        state.architects.clear();
        state.groups.clear();
        state.styles.clear();
        state.from = YEAR_MIN;
        state.to = YEAR_MAX;
        applyFilter();
      }
    };
    if (it.kind === 'arch') {
      state.architects = new Set([it.a.id]);
      applyFilter();
    } else if (it.kind === 'city') {
      resetIfHidden((b) => cityKey(b) === it.c.key);
      setView('cities');
      if (state.openCity !== it.c.key) toggleCity(it.c.key);
    } else {
      resetIfHidden((b) => b === it.b);
      select(it.b);
    }
    searchEl.blur();
  }

  suggestEl.addEventListener('pointerdown', (e) => e.preventDefault()); // Fokus im Suchfeld lassen
  suggestEl.addEventListener('click', (e) => {
    const li = e.target.closest('[data-i]');
    if (li) pickSuggest(Number(li.dataset.i));
  });
  searchEl.addEventListener('focus', renderSuggest);
  searchEl.addEventListener('blur', () => setTimeout(hideSuggest, 120));

  /* ---------------- Karte ---------------- */

  let map = null;
  let initial = { view: null, building: null };

  const toGeoJSON = (list) => ({
    type: 'FeatureCollection',
    features: list.map((b) => ({
      type: 'Feature',
      id: b.fid,
      geometry: { type: 'Point', coordinates: [b.lng, b.lat] },
      properties: { c: b.color, k: b.glow },
    })),
  });

  const ACTIVE = ['boolean', ['feature-state', 'active'], false];
  const notCluster = ['!', ['has', 'point_count']];
  const fadeOutAt = (from, to) => ['interpolate', ['linear'], ['zoom'], CLOSE_ZOOM - 0.6, from, CLOSE_ZOOM + 0.2, to];

  // Ortsnamen der Grundkarte in der gewählten Sprache
  function relabelMap() {
    if (!map?.isStyleLoaded()) return;
    for (const layer of map.getStyle().layers) {
      if (layer.source === 'omt' && layer.layout?.['text-field']) map.setLayoutProperty(layer.id, 'text-field', window.formatlasLabel(lang));
    }
  }

  function initMap() {
    if (typeof maplibregl === 'undefined') { mapFailed('library'); return; }
    const startZoom = worldZoom();
    const view = initial.view;
    try {
      map = new maplibregl.Map({
        container: 'map',
        style: window.formatlasStyle(lang),
        center: view ? view.center : WORLD_CENTER,
        zoom: view ? view.zoom : reduceMotion ? startZoom : startZoom - 0.45,
        bearing: view ? view.bearing : reduceMotion ? 0 : -12,
        pitch: view ? view.pitch : 0,
        minZoom: 0.4,
        maxZoom: 19,
        maxPitch: 70,
        attributionControl: { compact: true },
        fadeDuration: 180,
        // Drehen mit rechter Maustaste: 70 % langsamer als der Standard (0,8 °/px)
        rotateDegreesPerPixelMoved: 0.24,
        aroundCenter: false,
      });
    } catch (err) {
      mapFailed(/webgl/i.test(err?.message) ? 'webgl' : 'library', err);
      return;
    }
    map.setPadding(panelPadding());
    link.viewSet = !!view;

    // style.load statt load: load wartet auf alle Kacheln, bei Zoom 16 in einer Großstadt dauert das
    map.once('style.load', () => {
      map.addSource('b', {
        type: 'geojson',
        data: toGeoJSON(state.visible),
        cluster: cluster.on,
        clusterRadius: 40,
        clusterMaxZoom: 11,
      });

      // Lichtschein am Boden in der Farbe des Architekten, unter den 3D-Gebäuden
      map.addLayer(
        {
          id: 'ground-glow', type: 'circle', source: 'b', filter: notCluster, minzoom: 11.5,
          paint: {
            'circle-color': ['get', 'c'],
            'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 0, ['get', 'k'], 24, ['*', ['get', 'k'], 16777216]],
            'circle-blur': 1,
            'circle-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0, 14.5, ['case', ACTIVE, 0.85, 0.55]],
            'circle-pitch-alignment': 'map',
            'circle-pitch-scale': 'map',
          },
        },
        'building-3d'
      );

      map.addLayer({
        id: 'cluster-glow', type: 'circle', source: 'b', filter: ['has', 'point_count'],
        paint: {
          'circle-color': NEUTRAL,
          'circle-opacity': 0.08,
          'circle-blur': 0.6,
          'circle-radius': ['interpolate', ['linear'], ['get', 'point_count'], 2, 24, 10, 32, 40, 42],
        },
      });
      map.addLayer({
        id: 'clusters', type: 'circle', source: 'b', filter: ['has', 'point_count'],
        paint: {
          'circle-color': '#0f131b',
          'circle-radius': ['interpolate', ['linear'], ['get', 'point_count'], 2, 13, 10, 17, 40, 23],
          'circle-stroke-color': NEUTRAL,
          'circle-stroke-opacity': 0.75,
          'circle-stroke-width': 1.2,
        },
      });
      map.addLayer({
        id: 'cluster-count', type: 'symbol', source: 'b', filter: ['has', 'point_count'],
        layout: {
          'text-field': ['get', 'point_count_abbreviated'],
          'text-font': ['Noto Sans Bold'],
          'text-size': 12,
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: { 'text-color': NEUTRAL },
      });
      // Punkte blenden ab Zoom 14 aus, dann bleibt nur der Lichtschein am Gebäude
      map.addLayer({
        id: 'point-glow', type: 'circle', source: 'b', filter: notCluster,
        paint: {
          'circle-color': ['get', 'c'],
          'circle-blur': 0.85,
          'circle-radius': ['case', ACTIVE, 28, 15],
          'circle-opacity': fadeOutAt(['case', ACTIVE, 0.5, 0.24], 0),
          'circle-radius-transition': { duration: 220 },
        },
      });
      map.addLayer({
        id: 'points', type: 'circle', source: 'b', filter: notCluster,
        paint: {
          'circle-color': ['case', ACTIVE, '#ffffff', ['get', 'c']],
          'circle-radius': ['case', ACTIVE, 7.5, 5],
          'circle-stroke-color': '#06080c',
          'circle-stroke-width': 2,
          'circle-opacity': fadeOutAt(1, 0),
          'circle-stroke-opacity': fadeOutAt(1, 0),
          'circle-radius-transition': { duration: 220 },
        },
      });
      syncActive();

      if (!view && !reduceMotion) map.easeTo({ zoom: startZoom, bearing: 0, duration: 2200, easing: easeOut });

      // Bau aus dem Link: mit Kartenausschnitt direkt zeigen, sonst hinfliegen
      link.ready = true;
      writeLink();
      const b = initial.building;
      if (b && state.visible.includes(b)) {
        if (view) pin(b);
        else select(b);
      }
      renderTourButton();
    });

    watchBasemap();
    bindMapEvents();
  }

  // Ohne Karte bleiben Verzeichnis, Suche, Filter und Infokarten nutzbar
  function mapFailed(kind, err) {
    if (err) console.error(err);
    map = null;
    link.ready = true;
    writeLink();
    document.body.classList.add('no-map');
    const where = mqNarrow.matches ? t('above') : t('left');
    const [title, text] = kind === 'webgl' ? t('webglFail', where) : t('mapFail', where);
    notice.show(kind, { title, text, fatal: true, action: reloadPage() });
    if (mqNarrow.matches) setPanelOpen(true, false);
  }

  // Kartenhintergrund (OpenFreeMap) beobachten: Fällt er aus, bleiben die Bauten sichtbar
  function watchBasemap() {
    let errors = 0;
    const retry = () => {
      errors = 0;
      notice.hide('tiles');
      const src = map.getSource('omt');
      src?.setUrl?.(src.url); // lädt TileJSON und alle Kacheln neu
    };
    map.on('error', (e) => {
      if (e.sourceId === 'b') { console.error(e.error); return; }
      errors++;
      // Fehlt die Kachelbeschreibung (TileJSON, ohne e.tile), sofort melden; einzelne Kacheln erst ab dem dritten Fehler
      const fatal = e.sourceId === 'omt' && !e.tile;
      if ((!fatal && errors < 3) || notice.kind === 'tiles') return;
      notice.show('tiles', {
        title: t('tilesFail'),
        text: navigator.onLine ? t('tilesKeep') : t('tilesOffline'),
        action: { label: t('retry'), run: retry },
      });
    });
    map.on('data', (e) => {
      if (e.sourceId === 'omt' && e.tile && errors) {
        errors = 0;
        notice.dismissed.delete('tiles');
        notice.hide('tiles');
      }
    });
    map.on('webglcontextlost', () => {
      const [title, text] = t('contextLost');
      notice.show('context', { title, text, action: reloadPage() });
    });
    map.on('webglcontextrestored', () => notice.hide('context'));
    addEventListener('online', () => {
      notice.dismissed.clear();
      notice.hide('offline');
      retry();
    });
  }

  addEventListener('offline', () => {
    const [title, text] = t('offline');
    notice.show('offline', { title, text });
  });

  /* Hervorhebung über Feature-State, ohne Neuberechnung der Quelle */
  const activeFids = new Set();
  function syncActive() {
    if (!map?.getSource('b')) return;
    const next = new Set([state.hoverFid, state.listFid, state.pinnedFid].filter((v) => v != null));
    if (state.hoverCity) for (const b of state.visible) if (cityKey(b) === state.hoverCity) next.add(b.fid);
    for (const fid of activeFids) if (!next.has(fid)) map.setFeatureState({ source: 'b', id: fid }, { active: false });
    for (const fid of next) if (!activeFids.has(fid)) map.setFeatureState({ source: 'b', id: fid }, { active: true });
    activeFids.clear();
    next.forEach((fid) => activeFids.add(fid));
  }

  /* ---------------- Infokarte ---------------- */

  const card = $('card');
  const tether = $('tether');
  const photoEls = [...card.querySelectorAll('.card-photo')];
  const progressEl = $('card-progress');
  const cardState = { fid: null, anchor: null, w: 0, h: 0, hideTimer: 0 };
  const slides = { list: [], index: 0, timer: 0, running: false };

  photoEls.forEach((img) => {
    img.addEventListener('load', () => img.classList.add('is-loaded'));
    img.addEventListener('error', () => { img.classList.remove('is-loaded'); img.dataset.broken = '1'; });
  });

  // Grundriss (Meter, Norden oben) mit Maßstab in einer runden Länge
  function planHtml(b) {
    const [d, [x, y, w, h]] = b.pl;
    const size = Math.max(w, h, 8);
    const pad = size * 0.1;
    const extent = size + pad * 2;
    const bar = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].reduce((best, s) => (s <= extent * 0.45 ? s : best), 5);
    const vb = [x + w / 2 - extent / 2, y + h / 2 - extent / 2, extent, extent].map((v) => Math.round(v * 10) / 10);
    return `<svg viewBox="${vb.join(' ')}" aria-hidden="true"><path d="${d}" /></svg>
      <span class="plan-north" aria-hidden="true">${esc(t('north'))}</span>
      <figcaption><span class="plan-bar" style="width:${((bar / extent) * 100).toFixed(1)}%"></span>${bar} m</figcaption>`;
  }

  // Drei Vorschläge aus der aktuellen Auswahl: gleiche Zeit, in der Nähe, gleicher Typ
  function relatedFor(b) {
    const pool = state.visible.filter((o) => o !== b);
    const used = new Set();
    const pick = (list) => {
      const o = list.find((x) => !used.has(x));
      if (o) used.add(o);
      return o;
    };
    const dy = (o) => Math.abs(o.year - b.year);
    const km = (o) => kmBetween(b, o);
    const rows = [];
    const same = pick(pool.filter((o) => o.architect !== b.architect && dy(o) <= 5).sort((p, q) => dy(p) - dy(q) || km(p) - km(q)));
    if (same) rows.push([t('samePeriod'), same, String(same.year)]);
    const near = pick(pool.filter((o) => km(o) < 50).sort((p, q) => km(p) - km(q)));
    if (near) rows.push([t('nearby'), near, fmtKm(km(near))]);
    const kind =
      pick(pool.filter((o) => o.architect !== b.architect && o.type === b.type).sort((p, q) => dy(p) - dy(q))) ||
      pick(pool.filter((o) => o.architect !== b.architect && o.group === b.group).sort((p, q) => dy(p) - dy(q)));
    if (kind) rows.push([t('sameType'), kind, typeOf(kind)]);
    return rows
      .map(([label, o, meta]) => `<button class="rel" type="button" data-fid="${o.fid}" style="--c:${o.color}">
        <span class="rel-label">${esc(label)}</span><span class="rel-name"><i></i>${esc(nameOf(o))}</span><span class="rel-meta">${esc(meta)}</span></button>`)
      .join('');
  }

  function fillCard(b) {
    if (cardState.fid === b.fid) return;
    cardState.fid = b.fid;
    const a = archById.get(b.architect);
    card.style.setProperty('--c', b.color);
    tether.style.setProperty('--c', b.color);
    $('card-year').textContent = b.year;
    $('card-kicker').textContent = `${typeOf(b)} · ${a.short}`;
    $('card-title').textContent = nameOf(b);
    // Ort, Koordinaten und Stilrichtung; daneben der Grundriss
    $('card-place').innerHTML =
      `<b>${esc(cityOf(b))}</b>, ${esc(countryOf(b))}<br>${fmtDeg(b.lat, 'N', 'S')} · ${fmtDeg(b.lng, lang === 'en' ? 'E' : 'O', 'W')}` +
      (b.style ? `<span class="card-style">${esc(styleLabel(b.style))}</span>` : '');
    const plan = $('card-plan');
    plan.hidden = !b.pl;
    plan.innerHTML = b.pl ? planHtml(b) : '';
    plan.title = t('plan');
    $('card-text').textContent = textOf(b);
    $('card-related').innerHTML = relatedFor(b);
    // „Mehr lesen“: Wikipedia in der gewählten Sprache, sonst der vorhandene Artikel
    const wiki = $('card-wiki');
    const article = (lang === 'en' && b.wikiEn) || b.wiki;
    wiki.hidden = !article;
    if (article) wiki.href = article;
    $('card-route').href = `https://www.google.com/maps/search/?api=1&query=${b.lat},${b.lng}`;
    $('card-street').href = `https://www.mapillary.com/app/?lat=${b.lat}&lng=${b.lng}&z=17`;
    $('card-zoom').hidden = !b.ph.length;
    setSlides(b);
  }

  // Bildnachweis: Urheber mit Link zur Datei auf Commons, Lizenz
  const creditHtml = (p, i, n) =>
    `${esc(t('photo'))}${n > 1 ? ` ${i + 1}/${n}` : ''}: ` +
    `<a href="https://commons.wikimedia.org/wiki/File:${esc(p[0].split('/').pop())}" target="_blank" rel="noopener">${esc(p[1] || 'Wikimedia Commons')}</a>` +
    (p[2] ? ` · ${esc(p[2])}` : '');

  /* Fotokarussell: Überblenden mit leichtem Zoom, Fortschrittsbalken oben */

  function setSlides(b) {
    clearTimeout(slides.timer);
    slides.list = b.ph;
    photoEls.forEach((img, i) => {
      const p = b.ph[i];
      img.classList.remove('is-on', 'is-loaded');
      delete img.dataset.broken;
      img.hidden = !p;
      if (!p) { img.removeAttribute('src'); return; }
      img.alt = i === 0 ? `${nameOf(b)}, ${cityOf(b)}` : t('view', nameOf(b), i + 1);
      img.src = photoUrl(p[0], 500);
      if (img.complete && img.naturalWidth) img.classList.add('is-loaded');
    });
    $('card-media').classList.toggle('is-empty', !b.ph.length);
    progressEl.innerHTML =
      b.ph.length > 1
        ? b.ph.map((_, i) => `<button type="button" data-i="${i}" aria-label="${esc(t('photoOf', i + 1, b.ph.length))}"><span></span></button>`).join('')
        : '';
    showSlide(0);
  }

  function showSlide(i) {
    slides.index = i;
    photoEls.forEach((img, k) => {
      if (k !== i) { img.classList.remove('is-on'); return; }
      img.classList.remove('is-on');
      void img.offsetWidth; // Zoom-Animation neu starten
      img.classList.add('is-on');
    });
    [...progressEl.children].forEach((el, k) => {
      el.className = '';
      void el.offsetWidth;
      el.className = k < i ? 'is-done' : k === i ? 'is-active' : '';
    });
    const p = slides.list[i];
    $('card-credit').innerHTML = p ? creditHtml(p, i, slides.list.length) : esc(t('noPhotoCredit'));
    scheduleSlide();
  }

  function scheduleSlide() {
    clearTimeout(slides.timer);
    slides.running = !reduceMotion && slides.list.length > 1 && !!cardState.anchor && !lightbox.open;
    if (!slides.running) return;
    slides.timer = setTimeout(() => {
      // nächstes ladbares Foto; wartet, bis es geladen ist
      let next = slides.index;
      for (let step = 1; step < slides.list.length; step++) {
        const k = (slides.index + step) % slides.list.length;
        if (!photoEls[k].dataset.broken) { next = k; break; }
      }
      if (next === slides.index) return;
      const img = photoEls[next];
      if (img.complete && img.naturalWidth) showSlide(next);
      else img.addEventListener('load', () => { if (cardState.anchor && slides.list[next] && !lightbox.open) showSlide(next); }, { once: true });
    }, SLIDE_MS);
  }

  progressEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn) showSlide(Number(btn.dataset.i));
  });
  // Klick aufs Foto der angehefteten Karte öffnet die große Ansicht
  $('card-media').addEventListener('click', (e) => {
    if (e.target.closest('#card-progress') || !card.classList.contains('is-pinned')) return;
    const b = byFid.get(cardState.fid);
    if (b?.ph.length) openLightbox(b, slides.index);
  });
  // Verwandte Bauten anfliegen
  $('card-related').addEventListener('click', (e) => {
    const rel = e.target.closest('[data-fid]');
    if (rel) select(byFid.get(Number(rel.dataset.fid)));
  });

  // anchor: { row } neben der Listenzeile, { near } über dem Punkt, { dock } am Kartenrand mit Linie
  function openCard(b, anchor, pinned) {
    clearTimeout(cardState.hideTimer);
    const wasVisible = card.classList.contains('is-visible');
    const sameBuilding = cardState.fid === b.fid;
    cardState.anchor = anchor;
    fillCard(b);
    if (sameBuilding && !slides.running) scheduleSlide();
    card.hidden = false;
    card.classList.toggle('is-pinned', pinned);
    document.body.classList.add('has-card');
    cardState.w = card.offsetWidth;
    cardState.h = card.offsetHeight;
    positionCard();
    if (!wasVisible) {
      void card.offsetWidth; // Startzustand festschreiben, damit die Einblendung animiert
      card.classList.add('is-visible');
      positionCard(); // Linie erst zeigen, wenn die Karte sichtbar ist
    }
  }

  function closeCard() {
    card.classList.remove('is-visible', 'is-pinned');
    tether.classList.remove('is-visible');
    document.body.classList.remove('has-card');
    cardState.anchor = null;
    clearTimeout(slides.timer);
    slides.running = false;
    clearTimeout(cardState.hideTimer);
    cardState.hideTimer = setTimeout(() => {
      if (!cardState.anchor) { card.hidden = true; cardState.fid = null; }
    }, 220);
  }

  const cardAnchorFor = () => (map && map.getZoom() >= DOCK_ZOOM ? { dock: true } : { near: true });

  function positionCard() {
    const anchor = cardState.anchor;
    if (!anchor || mqNarrow.matches) { tether.classList.remove('is-visible'); return; }
    const W = cardState.w, H = cardState.h, m = 12;
    const vw = innerWidth, vh = innerHeight;
    const left = panel.classList.contains('is-collapsed') ? 0 : panel.getBoundingClientRect().right;
    let x, y, mode;

    if (anchor.row) {
      // Neben der Listenzeile, Pfeil zeigt nach links
      const r = anchor.row.getBoundingClientRect();
      const mid = r.top + r.height / 2;
      x = left + 14;
      y = clamp(mid - H / 2, m, vh - H - m);
      mode = 'side';
      card.style.setProperty('--caret-y', `${clamp(mid - y, 18, H - 18)}px`);
      tether.classList.remove('is-visible');
    } else {
      const b = byFid.get(cardState.fid);
      const p = map.project([b.lng, b.lat]);
      if (anchor.dock) {
        // Am Rand, gegenüber vom Gebäude, damit das Gebäude frei bleibt
        const gap = 28;
        const controls = $('controls').getBoundingClientRect(); // rechts nicht über die Kartenknöpfe legen
        mode = p.x < (left + vw) / 2 + 120 ? 'dock' : 'dock-left';
        x = mode === 'dock' ? Math.min(vw - W - gap, controls.width ? controls.left - W - 16 : Infinity) : left + gap;
        y = clamp(p.y - H / 2, m + 8, vh - H - m - 8);
      } else {
        const off = 18;
        mode = p.y - H - off >= m ? 'above' : 'below';
        y = clamp(mode === 'above' ? p.y - H - off : p.y + off, m, vh - H - m);
        x = clamp(p.x - W / 2, left + m, Math.max(left + m, vw - W - m));
        card.style.setProperty('--caret-x', `${clamp(p.x - x, 18, W - 18)}px`);
      }
      drawTether(mode, p, x, y, W, H);
    }
    for (const c of ['below', 'side', 'dock', 'dock-left']) card.classList.toggle(`is-${c}`, mode === c);
    card.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  }

  // Dünne Linie vom Gebäude zur angedockten Karte
  function drawTether(mode, p, x, y, W, H) {
    const docked = mode === 'dock' || mode === 'dock-left';
    const onScreen = p.x > -20 && p.y > -20 && p.x < innerWidth + 20 && p.y < innerHeight + 20;
    tether.classList.toggle('is-visible', docked && onScreen && card.classList.contains('is-visible'));
    if (!docked) return;
    const ex = mode === 'dock' ? x : x + W;
    const ey = clamp(p.y, y + 28, y + H - 28);
    const len = Math.hypot(ex - p.x, ey - p.y) || 1;
    const ring = 9;
    const line = $('tether-line');
    line.setAttribute('x1', p.x + ((ex - p.x) / len) * ring);
    line.setAttribute('y1', p.y + ((ey - p.y) / len) * ring);
    line.setAttribute('x2', ex);
    line.setAttribute('y2', ey);
    $('tether-ring').setAttribute('cx', p.x);
    $('tether-ring').setAttribute('cy', p.y);
    $('tether-end').setAttribute('cx', ex);
    $('tether-end').setAttribute('cy', ey);
  }

  /* ---------------- Große Fotoansicht ---------------- */

  const lightbox = $('lightbox');
  const lbImg = $('lb-photo');
  const lbStage = $('lb-stage');
  const lb = { b: null, index: 0, token: 0, drag: null, swiped: false, resumeTour: false };
  // Breite passend zum Bildschirm; ist das Original kleiner, liefert Commons einen Fehler → Original
  const bigUrl = (path) => photoUrl(path, innerWidth * (devicePixelRatio || 1) > 1400 ? 1920 : 1280);

  function openLightbox(b, index) {
    lb.b = b;
    clearTimeout(slides.timer);
    slides.running = false;
    // ein laufender Rundgang wartet, bis die Fotoansicht wieder zu ist
    lb.resumeTour = tour.running && !tour.paused;
    if (lb.resumeTour) pauseTour();
    $('lb-kicker').textContent = `${b.year} · ${archById.get(b.architect).short} · ${cityOf(b)}`;
    $('lb-title').textContent = nameOf(b);
    lightbox.classList.toggle('is-single', b.ph.length < 2);
    showPhoto(index, 0);
    lightbox.showModal();
  }

  function showPhoto(index, dir) {
    const b = lb.b, n = b.ph.length;
    lb.index = (index + n) % n;
    const p = b.ph[lb.index];
    const token = ++lb.token;
    // erst die kleine Vorschau (meist schon geladen), dann die große Fassung
    lbImg.src = photoUrl(p[0], 500);
    lbImg.alt = `${nameOf(b)}, ${t('photoOf', lb.index + 1, n)}`;
    lbImg.classList.add('is-preview');
    if (dir && !reduceMotion) {
      lbImg.animate(
        [{ opacity: 0, transform: `translateX(${dir * 48}px)` }, { opacity: 1, transform: 'none' }],
        { duration: 340, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
      );
    }
    const hi = new Image();
    hi.decoding = 'async';
    hi.onload = () => { if (token === lb.token) { lbImg.src = hi.src; lbImg.classList.remove('is-preview'); } };
    hi.onerror = () => { if (token === lb.token && hi.src !== originalUrl(p[0])) hi.src = originalUrl(p[0]); };
    hi.src = bigUrl(p[0]);
    if (n > 1) preload(bigUrl(b.ph[(lb.index + 1) % n][0])); // nächstes Foto schon laden
    $('lb-count').textContent = n > 1 ? `${lb.index + 1} / ${n}` : '';
    $('lb-credit').innerHTML = creditHtml(p, lb.index, n) + ` · <a href="${esc(originalUrl(p[0]))}" target="_blank" rel="noopener">${esc(t('original'))}</a>`;
  }

  const stepPhoto = (dir) => { if (lb.b && lb.b.ph.length > 1) showPhoto(lb.index + dir, dir); };
  $('lb-prev').addEventListener('click', () => stepPhoto(-1));
  $('lb-next').addEventListener('click', () => stepPhoto(1));
  $('lb-close').addEventListener('click', () => lightbox.close());
  lightbox.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); stepPhoto(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); stepPhoto(1); }
  });
  lightbox.addEventListener('close', () => {
    lb.token++;
    // Vorschau in der Infokarte zeigt danach das zuletzt gesehene Foto
    if (lb.b && cardState.fid === lb.b.fid && cardState.anchor) showSlide(lb.index);
    lb.b = null;
    if (lb.resumeTour && tour.running) resumeTour();
    lb.resumeTour = false;
  });

  // Klick neben das Foto schließt; liegt der Klick im Bildrahmen, zählt die sichtbare Bildfläche
  function onPhoto(e) {
    if (e.target !== lbImg || !lbImg.naturalWidth) return false;
    const r = lbImg.getBoundingClientRect();
    const scale = Math.min(r.width / lbImg.naturalWidth, r.height / lbImg.naturalHeight);
    const w = lbImg.naturalWidth * scale, h = lbImg.naturalHeight * scale;
    return Math.abs(e.clientX - (r.left + r.width / 2)) <= w / 2 && Math.abs(e.clientY - (r.top + r.height / 2)) <= h / 2;
  }
  lightbox.addEventListener('click', (e) => {
    if (lb.swiped) { lb.swiped = false; return; }
    if (e.target === lightbox || e.target === lbStage || (e.target === lbImg && !onPhoto(e))) lightbox.close();
  });

  // Wischen zum nächsten Foto (Touch, Stift und Maus)
  lbStage.addEventListener('pointerdown', (e) => {
    if (lb.b?.ph.length > 1 && e.button === 0) lb.drag = { id: e.pointerId, x: e.clientX, dx: 0 };
  });
  lbStage.addEventListener('pointermove', (e) => {
    const d = lb.drag;
    if (!d || e.pointerId !== d.id) return;
    d.dx = e.clientX - d.x;
    if (Math.abs(d.dx) < 8) return;
    lbImg.style.transform = `translateX(${d.dx}px)`;
    lbImg.style.opacity = String(1 - Math.min(Math.abs(d.dx) / 500, 0.5));
  });
  const endDrag = (e) => {
    const d = lb.drag;
    if (!d || e.pointerId !== d.id) return;
    lb.drag = null;
    lbImg.style.transform = '';
    lbImg.style.opacity = '';
    lb.swiped = Math.abs(d.dx) >= 8;
    if (e.type === 'pointerup' && Math.abs(d.dx) > 60) stepPhoto(d.dx < 0 ? 1 : -1);
  };
  lbStage.addEventListener('pointerup', endDrag);
  lbStage.addEventListener('pointercancel', endDrag);

  /* ---------------- Auswahl und Flug ---------------- */

  const easeOut = (x) => 1 - Math.pow(1 - x, 3);
  const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  let flightToken = 0;

  function cameraStep(options) {
    return new Promise((resolve) => {
      map.easeTo({ ...options, essential: true });
      // erst danach lauschen: easeTo beendet eine laufende Animation mit einem eigenen moveend
      map.once('moveend', resolve);
    });
  }

  // Wie bei Kartendiensten: herauszoomen, hinüberfliegen, hineinzoomen.
  // onLand(token) läuft am Ende; ein Eingriff erhöht flightToken und bricht ab.
  async function fly(end, onLand) {
    const token = ++flightToken;
    state.flying = true;
    stopOrbit();
    if (reduceMotion) {
      map.jumpTo(end);
      onLand(token);
      return;
    }

    const from = map.getCenter();
    const to = maplibregl.LngLat.convert(end.center);
    const km = from.distanceTo(to) / 1000;
    const fit = map.cameraForBounds(new maplibregl.LngLatBounds(from, from).extend(to), { padding: 140 });
    const overview = Math.max(Math.min(fit?.zoom ?? 2, end.zoom - 3, 11), worldZoom() - 0.3);

    // 1. Herauszoomen und Neigung zurücknehmen (entfällt, wenn das Ziel schon im Bild ist)
    if (km > 0.3 && (map.getZoom() > overview + 0.4 || map.getPitch() > 5)) {
      const dz = Math.max(0, map.getZoom() - overview);
      await cameraStep({ zoom: Math.min(map.getZoom(), overview), pitch: 0, bearing: 0, duration: clamp(dz * 220, 600, 1500), easing: easeInOut });
      if (token !== flightToken) return;
    }
    // 2. Hinüberfliegen auf Übersichtshöhe
    if (km > 0.5) {
      await cameraStep({ center: to, zoom: overview, pitch: 0, bearing: 0, duration: clamp(700 + Math.log10(km + 1) * 380, 900, 2300), easing: easeInOut });
      if (token !== flightToken) return;
    }
    // 3. Hineinzoomen und in die Endlage kippen
    await cameraStep({ ...end, duration: clamp(Math.abs(end.zoom - map.getZoom()) * 280, 1200, 3200), easing: easeOut });
    onLand(token);
  }

  function flyToBuilding(b) {
    // Gebäude landet in der Mitte der freien Fläche zwischen Verzeichnis und Infokarte
    // (rechts liegen außerdem die Kartenknöpfe, daher etwas weiter nach links)
    const desktopOffset = [-(cardState.w || 304) / 2 - 54, 40];
    fly(
      {
        center: [b.lng, b.lat],
        zoom: flyZoom(b),
        pitch: 60,
        bearing: -20,
        padding: panelPadding(),
        offset: mqNarrow.matches ? [0, -innerHeight * 0.18] : desktopOffset,
      },
      land
    );
  }

  function cancelFlight() {
    if (!state.flying) return;
    flightToken++;
    state.flying = false;
    map?.stop();
  }

  // Wurde das Verzeichnis während des Flugs auf- oder zugeklappt, Kartenabstand nachziehen
  function syncPadding() {
    const want = panelPadding(), has = map.getPadding();
    if (['top', 'right', 'bottom', 'left'].some((k) => Math.abs(want[k] - has[k]) > 1)) map.easeTo({ padding: want, duration: 350 });
  }

  function land(token) {
    if (token !== flightToken) return;
    state.flying = false;
    link.viewSet = true;
    syncPadding();
    writeLink();
    const b = state.pinnedFid != null && byFid.get(state.pinnedFid);
    if (!b) return;
    openCard(b, cardAnchorFor(), true);
    startOrbit(b);
    tourLanded(b);
  }

  // Bau anheften, ohne die Kamera zu bewegen (Link mit Kartenausschnitt)
  function pin(b) {
    state.pinnedFid = b.fid;
    syncActive();
    markRow(b.fid);
    preloadPhotos(b);
    openCard(b, cardAnchorFor(), true);
    writeLink();
  }

  // fromTour: Aufruf aus dem Rundgang, der dabei weiterläuft
  function select(b, { fromTour = false } = {}) {
    if (!b) return;
    if (!fromTour) stopTour();
    hideSuggest();
    state.pinnedFid = b.fid;
    state.listFid = null;
    state.hoverCity = null;
    syncActive();
    if (state.view === 'cities' && state.openCity !== cityKey(b)) {
      state.openCity = cityKey(b);
      renderIndex();
    }
    markRow(b.fid);
    preloadPhotos(b);
    writeLink();
    if (!map) {
      // ohne Karte: Infokarte neben der Listenzeile
      const row = indexEl.querySelector(`[data-fid="${b.fid}"]`);
      openCard(b, { row: row || panel }, true);
      tourLanded(b);
      return;
    }
    stopOrbit(false);
    map.stop(); // laufende Animation beenden, bevor sich die Auswahl ändert
    closeCard();
    // Auf schmalen Bildschirmen das Verzeichnis einklappen, damit neben der
    // angedockten Infokarte genug Platz für das Gebäude bleibt
    const open = !panel.classList.contains('is-collapsed');
    if (open && (mqNarrow.matches || innerWidth - panel.offsetWidth - (cardState.w || 304) < 460)) setPanelOpen(false, false);
    flyToBuilding(b);
  }

  function deselect() {
    if (state.pinnedFid == null) return;
    stopTour();
    cancelFlight(); // sonst fliegt die Kamera ohne Auswahl weiter zum Bau
    stopOrbit();
    state.pinnedFid = null;
    syncActive();
    markRow(null);
    closeCard();
    writeLink();
  }

  function flyToCity(c) {
    deselect();
    if (!map) return;
    if (mqNarrow.matches) setPanelOpen(false, false);
    const bounds = new maplibregl.LngLatBounds();
    c.list.forEach((b) => bounds.extend([b.lng, b.lat]));
    const cam = map.cameraForBounds(bounds, { padding: 90, maxZoom: CITY_ZOOM }) || {};
    fly(
      { center: cam.center || bounds.getCenter(), zoom: cam.zoom ?? CITY_ZOOM, pitch: 0, bearing: 0, padding: panelPadding() },
      (token) => {
        if (token !== flightToken) return;
        state.flying = false;
        link.viewSet = true;
        syncPadding();
        writeLink();
      }
    );
  }

  function toggleCity(key) {
    state.openCity = state.openCity === key ? null : key;
    renderIndex();
    renderTourButton();
    markRow(state.pinnedFid);
    writeLink();
    if (!state.openCity) return;
    indexEl.querySelector(`.city-row[data-city="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
    const c = cityGroups().find((g) => g.key === key);
    if (c) flyToCity(c);
  }

  /* ---------------- Rundflug nach der Landung ---------------- */

  // moving: Token des Abschnitts, der gerade dreht (0 = Kamera steht)
  const orbit = { on: prefs.get('orbit', !reduceMotion), token: 0, timer: 0, active: false, moving: 0 };

  function renderOrbitButton() {
    const btn = $('orbit');
    btn.setAttribute('aria-pressed', String(orbit.on));
    btn.title = orbit.on ? t('orbitOn') : t('orbitOff');
  }

  // Kreist langsam um das Gebäude; endet bei jeder Bedienung der Karte
  function startOrbit(b, delay = 900) {
    stopOrbit(false);
    if (!orbit.on || !map) return;
    const token = orbit.token;
    orbit.timer = setTimeout(async () => {
      if (token !== orbit.token || state.pinnedFid !== b.fid || state.flying) return;
      orbit.active = true;
      // in Abschnitten, denn easeTo dreht immer auf dem kürzesten Weg
      const ms = (30 / ORBIT_SPEED) * 1000;
      while (token === orbit.token) {
        orbit.moving = token;
        const t0 = performance.now();
        await cameraStep({ bearing: map.getBearing() - 30, around: [b.lng, b.lat], duration: ms, easing: (x) => x });
        if (orbit.moving === token) orbit.moving = 0;
        // vorzeitig zu Ende: eine andere Kamerabewegung (Zoomknopf, Verzeichnis, Suche) hat übernommen
        if (performance.now() - t0 < ms - 200) {
          if (token === orbit.token) stopOrbit(false);
          break;
        }
      }
    }, delay);
  }

  // halt = false: die Kamera nicht anhalten, z. B. bei mousedown, weil map.stop()
  // sonst auch das beginnende Ziehen abbrechen würde
  function stopOrbit(halt = true) {
    clearTimeout(orbit.timer);
    orbit.token++;
    orbit.active = false;
    if (halt && orbit.moving && map) map.stop();
  }

  $('orbit').addEventListener('click', () => {
    orbit.on = !orbit.on;
    prefs.set('orbit', orbit.on);
    renderOrbitButton();
    toast(orbit.on ? t('orbitOnToast') : t('orbitOffToast'));
    const b = state.pinnedFid != null && byFid.get(state.pinnedFid);
    if (orbit.on && b && !state.flying) startOrbit(b, 0);
    else if (!orbit.on) stopOrbit();
  });

  /* ---------------- Punkte zusammenfassen ----------------
     Nahe Punkte werden zu Zahlen-Kreisen gebündelt; ausgeschaltet zeigt die Karte jeden Bau einzeln. */

  const cluster = { on: prefs.get('cluster', true) };

  function renderClusterButton() {
    const btn = $('cluster');
    btn.setAttribute('aria-pressed', String(cluster.on));
    btn.title = cluster.on ? t('clusterOn') : t('clusterOff');
  }

  $('cluster').addEventListener('click', () => {
    cluster.on = !cluster.on;
    prefs.set('cluster', cluster.on);
    renderClusterButton();
    hideClusterTip();
    map?.getSource('b')?.setClusterOptions({ cluster: cluster.on, clusterRadius: 40, clusterMaxZoom: 11 });
    toast(cluster.on ? t('clusterOnToast') : t('clusterOffToast'));
  });

  /* ---------------- Rundgang (Kino-Modus) ----------------
     Fliegt die Bauten der Auswahl nacheinander an: die aufgeklappte Stadt,
     sonst alle gefilterten Bauten, chronologisch. */

  const tour = { running: false, paused: false, list: [], i: 0, timer: 0 };

  function tourScope() {
    if (state.view === 'cities' && state.openCity) {
      const c = cityGroups().find((g) => g.key === state.openCity);
      if (c) return c.list;
    }
    return state.visible;
  }

  function renderTourButton() {
    const n = tourScope().length;
    const btn = $('tour');
    btn.title = t('tour', n);
    btn.disabled = !n;
  }

  function renderTour() {
    const bar = $('tour-bar');
    bar.hidden = !tour.running;
    document.body.classList.toggle('has-tour', tour.running);
    if (!tour.running) return;
    const b = tour.list[tour.i];
    $('tour-pos').textContent = `${tour.i + 1} / ${tour.list.length}`;
    $('tour-name').textContent = b ? nameOf(b) : '';
    bar.classList.toggle('is-paused', tour.paused);
    $('tour-toggle').title = tour.paused ? t('tourResume') : t('tourPause');
    $('tour-prev').disabled = tour.i === 0;
  }

  function startTour() {
    const list = tourScope();
    if (!list.length || !map) return;
    tour.list = [...list];
    tour.running = true;
    const current = tour.list.findIndex((b) => b.fid === state.pinnedFid);
    tourGo(current >= 0 ? current : 0);
  }

  function tourGo(i) {
    clearTimeout(tour.timer);
    if (i >= tour.list.length) { stopTour(t('tourEnd')); return; }
    tour.i = Math.max(0, i);
    tour.paused = false;
    renderTour();
    restartTourProgress(0);
    select(tour.list[tour.i], { fromTour: true });
  }

  // Standzeit am Bau, dann weiter; der Balken im Rundgang zeigt die verbleibende Zeit
  function tourDwell(ms) {
    clearTimeout(tour.timer);
    restartTourProgress(ms);
    tour.timer = setTimeout(() => tourGo(tour.i + 1), ms);
  }

  function restartTourProgress(ms) {
    const bar = $('tour-progress');
    bar.classList.remove('is-running');
    void bar.offsetWidth;
    if (!ms) return;
    bar.style.setProperty('--dwell', `${ms}ms`);
    bar.classList.add('is-running');
  }

  function tourLanded(b) {
    if (!tour.running || tour.paused || tour.list[tour.i] !== b) return;
    tourDwell(TOUR_DWELL);
  }

  function pauseTour() {
    if (!tour.running || tour.paused) return;
    tour.paused = true;
    clearTimeout(tour.timer);
    restartTourProgress(0);
    renderTour();
  }

  function resumeTour() {
    if (!tour.running) return;
    tour.paused = false;
    renderTour();
    if (!state.flying) tourDwell(3000);
  }

  function stopTour(message) {
    if (!tour.running) return;
    tour.running = false;
    tour.paused = false;
    clearTimeout(tour.timer);
    restartTourProgress(0);
    renderTour();
    if (message) toast(message);
  }

  $('tour').addEventListener('click', () => (tour.running ? stopTour() : startTour()));
  $('tour-prev').addEventListener('click', () => tourGo(tour.i - 1));
  $('tour-next').addEventListener('click', () => tourGo(tour.i + 1));
  $('tour-toggle').addEventListener('click', () => (tour.paused ? resumeTour() : pauseTour()));
  $('tour-stop').addEventListener('click', () => stopTour());

  // Überrasch mich: ein zufälliger Bau aus der aktuellen Auswahl
  $('random').addEventListener('click', () => {
    const pool = state.visible.filter((b) => b.fid !== state.pinnedFid);
    if (pool.length) select(pool[Math.floor(Math.random() * pool.length)]);
  });

  /* ---------------- Kartenereignisse ---------------- */

  const tip = $('cluster-tip');
  let tipCluster = null;

  function setHover(fid) {
    if (fid === state.hoverFid) return;
    state.hoverFid = fid;
    syncActive();
    if (state.pinnedFid != null || state.flying) return;
    if (fid != null) openCard(byFid.get(fid), cardAnchorFor(), false);
    else closeCard();
  }

  async function showClusterTip(f, point) {
    const id = f.properties.cluster_id;
    if (tipCluster !== id) {
      tipCluster = id;
      const leaves = await map.getSource('b').getClusterLeaves(id, 6, 0);
      if (tipCluster !== id) return;
      const total = f.properties.point_count;
      const items = leaves.map((l) => {
        const b = byFid.get(l.id);
        return `<li style="--c:${b.color}"><i></i>${esc(nameOf(b))} · ${esc(cityOf(b))}</li>`;
      });
      tip.innerHTML =
        `<strong>${esc(t('clusterCount', total))}</strong><ul>${items.join('')}</ul>` +
        `<p class="more">${total > 6 ? esc(t('clusterMore', total - 6)) : ''}${esc(t('clusterZoom'))}</p>`;
      tip.hidden = false;
    }
    const w = tip.offsetWidth, h = tip.offsetHeight;
    const x = point.x + 18 + w > innerWidth - 12 ? point.x - w - 18 : point.x + 18;
    tip.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(clamp(point.y - h / 2, 12, innerHeight - h - 12))}px, 0)`;
  }

  function hideClusterTip() {
    tipCluster = null;
    tip.hidden = true;
  }

  // Trefferfläche: Punkt, Cluster oder Lichtschein
  const HIT_LAYERS = ['point-glow', 'clusters', 'ground-glow'];

  function bindMapEvents() {
    const canvas = map.getCanvas();

    map.on('mousemove', (e) => {
      if (!mqHover.matches || !map.getLayer('points')) return;
      const f = map.queryRenderedFeatures(e.point, { layers: HIT_LAYERS })[0];
      canvas.style.cursor = f ? 'pointer' : '';
      if (f && f.layer.id === 'clusters') {
        setHover(null);
        showClusterTip(f, e.point);
      } else {
        hideClusterTip();
        setHover(f ? f.id : null);
      }
    });
    canvas.addEventListener('mouseleave', () => { setHover(null); hideClusterTip(); });

    map.on('click', async (e) => {
      stopOrbit(); // ein Klick ohne Ziehen hält auch den laufenden Rundflug an
      if (!map.getLayer('points')) return;
      const { x, y } = e.point;
      const r = mqHover.matches ? 4 : 14; // großzügiger auf Touch-Geräten
      const f = map.queryRenderedFeatures([[x - r, y - r], [x + r, y + r]], { layers: ['points', ...HIT_LAYERS] })[0];
      if (!f) { deselect(); return; }
      if (f.layer.id === 'clusters') {
        hideClusterTip();
        const zoom = await map.getSource('b').getClusterExpansionZoom(f.properties.cluster_id);
        map.easeTo({ center: f.geometry.coordinates, zoom: Math.min(zoom + 0.6, 15), duration: reduceMotion ? 0 : 800 });
        return;
      }
      if (f.id !== state.pinnedFid) select(byFid.get(f.id));
    });

    // Eingriff während Flug oder Rundflug: Animation abbrechen, Karte bleibt, wo sie ist;
    // ein laufender Rundgang hält an und lässt sich fortsetzen
    const interrupt = () => {
      if (state.flying) { flightToken++; state.flying = false; }
      stopOrbit(false);
      pauseTour();
    };
    for (const type of ['mousedown', 'touchstart', 'wheel']) map.on(type, interrupt);
    map.on('movestart', (e) => {
      hideClusterTip();
      // Bewegungen durch Maus, Finger oder Tastatur landen im Link
      if (e.originalEvent) {
        interrupt();
        link.viewSet = true;
      }
    });
    map.on('moveend', () => {
      if (state.pinnedFid != null && !cardState.anchor && !state.flying) {
        openCard(byFid.get(state.pinnedFid), cardAnchorFor(), true);
      }
      if (!state.flying && !orbit.active) writeLink();
    });
    map.on('idle', preloadVisible);

    let frame = 0;
    map.on('move', () => {
      if (!cardState.anchor || cardState.anchor.row || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!cardState.anchor || cardState.anchor.row) return;
        // Beim Zoomen zwischen „über dem Punkt“ und „am Rand“ wechseln
        const want = cardAnchorFor();
        if (!!want.dock !== !!cardState.anchor.dock) cardState.anchor = want;
        positionCard();
      });
    });
  }

  addEventListener('resize', () => { if (cardState.anchor) positionCard(); });

  /* ---------------- Verzeichnis-Ereignisse ---------------- */

  indexEl.addEventListener('click', (e) => {
    const cityRow = e.target.closest('.city-row');
    if (cityRow) { toggleCity(cityRow.dataset.city); return; }
    const row = e.target.closest('[data-fid]');
    if (row) select(byFid.get(Number(row.dataset.fid)));
  });

  function clearListHover() {
    if (state.listFid == null) return;
    state.listFid = null;
    if (state.pinnedFid == null && cardState.anchor?.row) closeCard();
  }

  indexEl.addEventListener('pointerover', (e) => {
    if (!mqHover.matches) return;
    // Stadtzeile: alle Bauten der Stadt auf der Karte hervorheben
    const cityRow = e.target.closest('.city-row');
    const city = cityRow ? cityRow.dataset.city : null;
    if (city !== state.hoverCity) {
      state.hoverCity = city;
      if (city) clearListHover();
      syncActive();
    }
    const row = e.target.closest('[data-fid]');
    if (!row) return;
    const fid = Number(row.dataset.fid);
    if (fid === state.listFid) return;
    state.listFid = fid;
    syncActive();
    if (state.pinnedFid == null && !state.flying) openCard(byFid.get(fid), { row }, false);
  });

  const leaveIndex = () => {
    if (state.listFid == null && state.hoverCity == null) return;
    clearListHover();
    state.hoverCity = null;
    syncActive();
  };
  indexEl.addEventListener('pointerleave', leaveIndex);
  indexEl.addEventListener('scroll', leaveIndex, { passive: true });
  panelBody.addEventListener('scroll', leaveIndex, { passive: true }); // niedrige Fenster: das ganze Verzeichnis scrollt

  $('view-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-view]');
    if (tab) setView(tab.dataset.view);
  });

  // Architekten-Chips: Klick wählt aus oder ab, zweiter Klick kurz danach (Doppelklick)
  // wählt nur diesen, Alt-Klick alle außer diesem. Die Chips werden bei jedem Klick neu
  // gezeichnet, daher zählt der Doppelklick selbst statt über das dblclick-Ereignis.
  let lastChip = { id: null, at: 0 };
  $('arch-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const id = chip.dataset.arch;
    const now = performance.now();
    if (e.altKey) state.architects = new Set(architects.map((a) => a.id).filter((x) => x !== id));
    else if (lastChip.id === id && now - lastChip.at < 400) state.architects = new Set([id]);
    else if (state.architects.has(id)) state.architects.delete(id);
    else state.architects.add(id);
    lastChip = { id, at: e.altKey || lastChip.id === id ? 0 : now };
    applyFilter();
  });

  function setYears(from, to) {
    state.from = clamp(Math.min(from, to), YEAR_MIN, YEAR_MAX);
    state.to = clamp(Math.max(from, to), YEAR_MIN, YEAR_MAX);
    applyFilter();
  }

  fromEl.addEventListener('input', () => {
    if (+fromEl.value > state.to) fromEl.value = state.to;
    setYears(+fromEl.value, state.to);
  });
  toEl.addEventListener('input', () => {
    if (+toEl.value < state.from) toEl.value = state.from;
    setYears(state.from, +toEl.value);
  });

  // Tooltip: Bauten des Zeitraums je Architekt, gewählte Architekten zuerst
  const histTip = $('hist-tip');
  function showHistTip(bar) {
    const lo = Number(bar.dataset.lo), hi = Number(bar.dataset.hi);
    const bin = yearBins().get(Math.floor(lo / BIN) * BIN);
    const n = bin?.total || 0;
    const chosen = architects.filter((a) => state.architects.has(a.id));
    const shown = chosen.length ? chosen : architects;
    const items = shown
      .filter((a) => bin?.by.get(a.id))
      .map((a) => `<li style="--c:${a.color}"><i></i>${esc(a.short)} <b>${bin.by.get(a.id)}</b></li>`);
    const rest = chosen.length ? n - chosen.reduce((sum, a) => sum + (bin?.by.get(a.id) || 0), 0) : 0;
    if (rest) items.push(`<li class="rest"><i></i>${esc(t('others'))} <b>${rest}</b></li>`);
    histTip.innerHTML = `<strong>${lo === hi ? lo : `${lo}–${hi}`} · ${n} ${esc(t('buildings', n))}</strong>${items.length ? `<ul>${items.join('')}</ul>` : ''}`;
    histTip.hidden = false;
    const r = bar.getBoundingClientRect(), top = $('histogram').getBoundingClientRect().top;
    const w = histTip.offsetWidth, h = histTip.offsetHeight;
    const x = clamp(r.left + r.width / 2 - w / 2, 8, innerWidth - w - 8);
    histTip.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(Math.max(8, top - h - 10))}px, 0)`;
  }
  $('histogram').addEventListener('pointerover', (e) => {
    const bar = e.target.closest('.bar');
    if (bar && mqHover.matches) showHistTip(bar);
  });
  $('histogram').addEventListener('pointerleave', () => { histTip.hidden = true; });
  panelBody.addEventListener('scroll', () => { histTip.hidden = true; }, { passive: true });

  $('histogram').addEventListener('click', (e) => {
    const bar = e.target.closest('.bar');
    if (!bar) return;
    const lo = Number(bar.dataset.lo), hi = Number(bar.dataset.hi);
    // Klick wählt diesen Zeitraum, ein zweiter Klick hebt die Auswahl auf
    if (state.from === lo && state.to === hi) setYears(YEAR_MIN, YEAR_MAX);
    else setYears(lo, hi);
  });

  $('type-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const g = chip.dataset.group;
    if (state.groups.has(g)) state.groups.delete(g);
    else state.groups.add(g);
    applyFilter();
  });

  $('style-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const st = chip.dataset.style;
    if (state.styles.has(st)) state.styles.delete(st);
    else state.styles.add(st);
    applyFilter();
  });

  $('filter-reset').addEventListener('click', () => {
    state.groups.clear();
    state.styles.clear();
    state.architects.clear();
    setYears(YEAR_MIN, YEAR_MAX);
  });

  searchEl.addEventListener('input', () => {
    state.query = searchEl.value;
    applyFilter();
    renderSuggest();
  });

  searchEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (moveSuggest(e.key === 'ArrowDown' ? 1 : -1)) e.preventDefault();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!suggestEl.hidden && sug.active >= 0) { pickSuggest(sug.active); return; }
      hideSuggest();
      const list = state.visible;
      if (list.length === 1) select(list[0]);
      else if (list.length > 1 && map) {
        const bounds = new maplibregl.LngLatBounds();
        list.forEach((b) => bounds.extend([b.lng, b.lat]));
        link.viewSet = true;
        map.fitBounds(bounds, { padding: 80, maxZoom: 12, pitch: 0, bearing: 0, duration: reduceMotion ? 0 : 1600 });
      }
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      if (!suggestEl.hidden) { hideSuggest(); return; }
      if (searchEl.value) {
        searchEl.value = '';
        state.query = '';
        applyFilter();
      } else searchEl.blur();
    }
  });

  panelToggle.addEventListener('click', () => setPanelOpen(panel.classList.contains('is-collapsed')));

  /* ---------------- Steuerung & Tastatur ---------------- */

  $('card-close').addEventListener('click', deselect);
  $('zoom-in').addEventListener('click', () => { link.viewSet = true; map?.zoomIn(); });
  $('zoom-out').addEventListener('click', () => { link.viewSet = true; map?.zoomOut(); });
  $('reset-view').addEventListener('click', () => {
    if (!map) return;
    deselect();
    flightToken++;
    state.flying = false;
    link.viewSet = false;
    map.flyTo({ center: WORLD_CENTER, zoom: worldZoom(), pitch: 0, bearing: 0, padding: panelPadding(), duration: reduceMotion ? 0 : 2000, essential: true });
  });

  // Teilen: am Handy das Teilen-Menü, sonst Link kopieren
  $('share').addEventListener('click', async () => {
    writeLink(true);
    const url = location.href;
    if (navigator.share && !mqHover.matches) {
      try { await navigator.share({ title: document.title, url }); } catch {}
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      toast(t('copied'));
    } catch {
      toast(t('copyFailed'));
    }
  });

  addEventListener('keydown', (e) => {
    if (lightbox.open) return; // Pfeile und Esc gehören dort der Fotoansicht
    const typing = e.target instanceof HTMLInputElement && e.target.type !== 'range';
    if (e.key === '/' && !typing) {
      e.preventDefault();
      if (panel.classList.contains('is-collapsed')) setPanelOpen(true);
      searchEl.focus();
    } else if (e.key === 'Escape') {
      if (typing) searchEl.blur();
      stopTour();
      cancelFlight();
      deselect();
    }
  });

  mqNarrow.addEventListener('change', () => {
    setPanelOpen(!mqNarrow.matches);
    if (cardState.anchor) positionCard();
  });

  /* ---------------- Sprache umschalten ---------------- */

  function setLang(next) {
    lang = next;
    prefs.set('lang', next);
    applyStatic();
    relabelMap();
    applyFilter();
    renderOrbitButton();
    renderClusterButton();
    renderTour();
    if (!searchEl.matches(':focus')) hideSuggest();
    // offene Infokarte neu füllen
    if (cardState.anchor && cardState.fid != null) {
      const b = byFid.get(cardState.fid);
      cardState.fid = null;
      openCard(b, cardState.anchor, card.classList.contains('is-pinned'));
    }
    writeLink();
  }
  $('lang').addEventListener('click', () => setLang(lang === 'de' ? 'en' : 'de'));

  /* ---------------- Bilder vorladen ---------------- */

  const preloaded = new Set();
  function preload(url) {
    if (!url || preloaded.has(url)) return;
    preloaded.add(url);
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
  }
  const preloadPhotos = (b) => b.ph.forEach((p) => preload(photoUrl(p[0], 500)));

  // Auf Geräten mit Maus wird das erste Foto der sichtbaren Bauten in
  // Leerlaufphasen geladen, damit die Vorschau beim Hovern sofort ein Bild zeigt.
  const conn = navigator.connection;
  const saveData = !!(conn && (conn.saveData || /2g/.test(conn.effectiveType || '')));
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 120));
  function preloadVisible() {
    if (!mqHover.matches || saveData || !map.getLayer('points')) return;
    const queue = map
      .queryRenderedFeatures({ layers: ['points'] })
      .map((f) => byFid.get(f.id)?.ph[0])
      .filter(Boolean)
      .map((p) => photoUrl(p[0], 500))
      .filter((url) => !preloaded.has(url))
      .slice(0, 40);
    const step = () => {
      for (let i = 0; i < 4 && queue.length; i++) preload(queue.shift());
      if (queue.length) idle(step);
    };
    if (queue.length) idle(step);
  }

  /* ---------------- Start ---------------- */

  initial = readLink();
  applyStatic();
  searchEl.value = state.query;
  syncTabs();
  renderOrbitButton();
  renderClusterButton();
  applyFilter();
  if (mqNarrow.matches) setPanelOpen(false);
  // „Typ & Stil“ ist lang; offen nur, wenn dort schon gefiltert wird
  filtersEl.open = state.groups.size > 0 || state.styles.size > 0;
  if (!navigator.onLine) {
    const [title, text] = t('offline');
    notice.show('offline', { title, text });
  }

  // Karte erst anlegen, wenn der Container eine Größe hat (z. B. nicht in einem
  // ausgeblendeten Tab), sonst kann MapLibre seine Projektion nicht berechnen.
  const mapEl = $('map');
  if (mapEl.clientWidth && mapEl.clientHeight) initMap();
  else {
    const ro = new ResizeObserver(() => {
      if (!mapEl.clientWidth || !mapEl.clientHeight) return;
      ro.disconnect();
      initMap();
    });
    ro.observe(mapEl);
  }
})();
