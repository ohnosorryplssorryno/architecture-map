(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  /* ---------------- Hinweise bei Ladeproblemen ---------------- */

  const noticeEl = $('notice');
  const notice = {
    kind: null,
    action: null,
    // fatal: Die Karte fehlt ganz, der Hinweis steht groß in der Kartenfläche und bleibt
    show(kind, { title, text, fatal = false, action = null }) {
      if (!fatal && !noticeEl.hidden && noticeEl.classList.contains('is-fatal')) return;
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
  $('notice-close').addEventListener('click', () => notice.hide());
  const reloadPage = { label: 'Erneut versuchen', run: () => location.reload() };

  const DATA = window.FORMATLAS_DATA;
  if (!DATA) {
    document.body.classList.add('no-map', 'no-data');
    notice.show('data', {
      title: 'Die Daten konnten nicht geladen werden.',
      text: 'Bitte prüfe die Internetverbindung und lade die Seite neu.',
      fatal: true,
      action: reloadPage,
    });
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
  const PLAY_RATE = 9; // Jahre pro Sekunde beim Abspielen der Zeitleiste
  const ORBIT_SPEED = 4; // Grad pro Sekunde beim Rundflug um ein Gebäude
  const THUMBS = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/';
  const ORIGINALS = 'https://upload.wikimedia.org/wikipedia/commons/';

  // Gebäudetypen für den Typfilter (gepflegt in data/source.mjs)
  const GROUPS = (DATA.groups || []).map((g) => ({ ...g }));

  const mqHover = matchMedia('(hover: hover) and (pointer: fine)');
  const mqNarrow = matchMedia('(max-width: 640px)');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const normalize = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  const rad = (d) => (d * Math.PI) / 180;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmtDeg = (v, pos, neg) =>
    `${Math.abs(v).toLocaleString('de-DE', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}° ${v >= 0 ? pos : neg}`;
  // Foto-Pfad aus Wikimedia Commons → Thumbnail-URL in Standardbreite
  const photoUrl = (path, width) => (path.startsWith('http') ? path : `${THUMBS}${path}/${width}px-${path.split('/').pop()}`);
  const originalUrl = (path) => (path.startsWith('http') ? path : ORIGINALS + path);

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
  const groupOfType = new Map(GROUPS.flatMap((g) => g.types.map((t) => [t, g.id])));
  const cityKey = (b) => `${b.city}|${b.country}`;
  buildings.forEach((b, i) => {
    const a = archById.get(b.architect);
    b.fid = FID_OFFSET + i;
    b.ph ||= []; // Bau ohne Fotos
    b.color = a.color;
    b.group = groupOfType.get(b.type) || 'weitere';
    b.search = normalize([b.name, b.city, b.country, b.type, b.year, a.name, a.short].join(' '));
    // Radius des Lichtscheins am Boden in Pixeln bei Zoom 0 (wird mit 2^zoom skaliert)
    b.glow = ((b.r || 45) * 1.8 * 512) / (EARTH * Math.cos(rad(b.lat)));
  });
  if (buildings.some((b) => b.group === 'weitere')) GROUPS.push({ id: 'weitere', label: 'Weitere', types: [] });

  const byFid = new Map(buildings.map((b) => [b.fid, b]));
  const byId = new Map(buildings.map((b) => [b.id, b]));
  const years = buildings.map((b) => b.year);
  const YEAR_MIN = Math.min(...years);
  const YEAR_MAX = Math.max(...years);

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
    query: '',
    terms: [],
    from: YEAR_MIN,
    to: YEAR_MAX,
    visible: buildings,
    view: 'buildings', // Verzeichnis nach Bauten oder nach Städten
    openCity: null, // aufgeklappte Stadt in der Städteansicht
    hoverCity: null, // Stadtzeile unter dem Mauszeiger
    hoverFid: null, // Punkt unter dem Mauszeiger
    listFid: null, // Zeile unter dem Mauszeiger
    pinnedFid: null, // angeklickter Bau
    flying: false,
  };

  /* ---------------- Ansicht im Link ----------------
     ?a=zha,gehry  Architekten     ?t=kultur  Typgruppen    ?y=1990-2010  Baujahre
     ?q=…  Suche    ?b=…  gewählter Bau    ?v=lat,lng,zoom,drehung,neigung  Kartenausschnitt */

  // ready: erst schreiben, wenn der Zustand aus dem Link übernommen ist (Karte eingerichtet)
  const link = { timer: 0, viewSet: false, ready: false };

  function readLink() {
    const p = new URLSearchParams(location.search);
    const list = (k) => (p.get(k) || '').split(',').filter(Boolean);
    for (const id of list('a')) if (archById.has(id)) state.architects.add(id);
    for (const id of list('t')) if (GROUPS.some((g) => g.id === id)) state.groups.add(id);
    const y = (p.get('y') || '').match(/^(\d{4})(?:-(\d{4}))?$/);
    if (y) {
      const a = clamp(+y[1], YEAR_MIN, YEAR_MAX), b = clamp(+(y[2] || y[1]), YEAR_MIN, YEAR_MAX);
      state.from = Math.min(a, b);
      state.to = Math.max(a, b);
    }
    if (p.get('q')) state.query = p.get('q');
    const v = (p.get('v') || '').split(',').map(Number);
    const view =
      v.length >= 3 && v.every(Number.isFinite) && Math.abs(v[0]) <= 90 && Math.abs(v[1]) <= 180
        ? { center: [v[1], v[0]], zoom: clamp(v[2], 0.4, 19), bearing: v[3] || 0, pitch: clamp(v[4] || 0, 0, 70) }
        : null;
    // ältere Links: #gebäude-id
    const legacy = location.hash.length > 1 ? decodeURIComponent(location.hash.slice(1)) : '';
    return { view, building: byId.get(p.get('b') || legacy) || null };
  }

  function writeLink(now = false) {
    clearTimeout(link.timer);
    if (!now) { link.timer = setTimeout(() => writeLink(true), 250); return; }
    if (!link.ready || play.running) return;
    const p = new URLSearchParams();
    if (state.query.trim()) p.set('q', state.query.trim());
    if (state.architects.size) p.set('a', architects.filter((a) => state.architects.has(a.id)).map((a) => a.id).join(','));
    if (state.groups.size) p.set('t', GROUPS.filter((g) => state.groups.has(g.id)).map((g) => g.id).join(','));
    if (state.from > YEAR_MIN || state.to < YEAR_MAX) p.set('y', state.from === state.to ? state.from : `${state.from}-${state.to}`);
    const b = state.pinnedFid != null && byFid.get(state.pinnedFid);
    if (b) p.set('b', b.id);
    if (map && link.viewSet) {
      const c = map.getCenter();
      const v = [c.lat.toFixed(5), c.lng.toFixed(5), map.getZoom().toFixed(2), Math.round(map.getBearing()), Math.round(map.getPitch())];
      p.set('v', v.join(',').replace(/(,0)+$/, ''));
    }
    const qs = p.toString().replace(/%2C/g, ',');
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

  // Filterprüfung; `skip` lässt einen Filter weg (für die Zähler dieses Filters)
  function passes(b, skip) {
    if (skip !== 'arch' && state.architects.size && !state.architects.has(b.architect)) return false;
    if (state.terms.length && !state.terms.every((t) => b.search.includes(t))) return false;
    if (skip !== 'year' && (b.year < state.from || b.year > state.to)) return false;
    if (skip !== 'group' && state.groups.size && !state.groups.has(b.group)) return false;
    return true;
  }

  const filtersActive = () =>
    state.architects.size > 0 || state.from > YEAR_MIN || state.to < YEAR_MAX || state.groups.size > 0;

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
          title="${esc(a.name)} · ${esc(a.meta)}" ${n || on ? '' : 'disabled'}><i></i>${esc(a.short)}<span>${n}</span></button>`;
      })
      .join('');
    $('arch-chips').classList.toggle('has-selection', state.architects.size > 0);
    $('arch-count').textContent = state.architects.size ? `${state.architects.size} von ${architects.length}` : `${architects.length}`;
  }

  function renderFilters() {
    // Histogramm in 5-Jahres-Schritten unter allen übrigen Filtern
    const first = Math.floor(YEAR_MIN / BIN) * BIN;
    const bins = Math.floor(YEAR_MAX / BIN) - first / BIN + 1;
    const counts = countBy('year', (b) => Math.floor(b.year / BIN) * BIN);
    const max = Math.max(1, ...counts.values());
    const span = YEAR_MAX - YEAR_MIN || 1;
    let bars = '';
    for (let i = 0; i < bins; i++) {
      const start = first + i * BIN;
      const lo = Math.max(start, YEAR_MIN), hi = Math.min(start + BIN - 1, YEAR_MAX);
      const n = counts.get(start) || 0;
      const label = `${lo}–${hi}: ${n} ${n === 1 ? 'Bau' : 'Bauten'}`;
      const inRange = hi >= state.from && lo <= state.to;
      bars += `<button type="button" class="bar${inRange ? ' is-in' : ''}" data-lo="${lo}" data-hi="${hi}"
        style="--x:${clamp(((lo + hi) / 2 - YEAR_MIN) / span, 0, 1)};--h:${n / max}" title="${label}" aria-label="${label}"
        aria-pressed="${state.from === lo && state.to === hi}"></button>`;
    }
    const hist = $('histogram');
    hist.innerHTML = bars;
    hist.style.setProperty('--n', bins);
    $('range').style.setProperty('--a', (state.from - YEAR_MIN) / span);
    $('range').style.setProperty('--b', (state.to - YEAR_MIN) / span);
    fromEl.value = state.from;
    toEl.value = state.to;
    $('year-output').textContent = state.from === state.to ? String(state.from) : `${state.from} – ${state.to}`;
    // Liegen beide Regler übereinander, den greifbar machen, der sich bewegen kann
    fromEl.style.zIndex = state.from === state.to && state.from > (YEAR_MIN + YEAR_MAX) / 2 ? 2 : 1;

    // Typ-Chips mit Anzahl unter allen übrigen Filtern
    const groupCounts = countBy('group', (b) => b.group);
    $('type-chips').innerHTML = GROUPS.map((g) => {
      const n = groupCounts.get(g.id) || 0;
      const on = state.groups.has(g.id);
      return `<button type="button" class="chip" data-group="${g.id}" aria-pressed="${on}" title="${esc(g.types.join(', '))}"
        ${n || on ? '' : 'disabled'}>${esc(g.label)}<span>${n}</span></button>`;
    }).join('');

    const active = [];
    if (state.from > YEAR_MIN || state.to < YEAR_MAX) active.push($('year-output').textContent);
    if (state.groups.size) active.push(GROUPS.filter((g) => state.groups.has(g.id)).map((g) => g.label).join(', '));
    $('filters-state').textContent = active.join(' · ');
    $('filter-reset').hidden = !filtersActive();
  }

  function renderResult() {
    const n = state.visible.length;
    const cities = new Set(state.visible.map(cityKey)).size;
    const countries = new Set(state.visible.map((b) => b.country)).size;
    $('count-buildings').textContent = n;
    $('label-buildings').textContent = n === 1 ? 'Bau' : 'Bauten';
    $('count-cities').textContent = cities;
    $('label-cities').textContent = cities === 1 ? 'Stadt' : 'Städte';
    $('tab-cities').title = `${cities} ${cities === 1 ? 'Stadt' : 'Städte'} in ${countries} ${countries === 1 ? 'Land' : 'Ländern'}`;
  }

  const rowHtml = (b) => {
    const thumb = b.ph[0]
      ? `<img class="row-thumb" src="${esc(photoUrl(b.ph[0][0], 120))}" alt="" width="44" height="44" loading="lazy" decoding="async">`
      : '<span class="row-thumb is-empty"></span>';
    return `<li><button class="row${b.fid === state.pinnedFid ? ' is-active' : ''}" type="button" data-fid="${b.fid}" style="--c:${b.color}">
      ${thumb}
      <span class="row-text"><span class="row-name">${esc(b.name)}</span>
      <span class="row-place"><i></i>${esc(archById.get(b.architect).short)} · ${esc(b.city)}</span></span>
      <span class="row-year">${b.year}</span></button></li>`;
  };

  function buildingsHtml() {
    const decades = new Map();
    for (const b of state.visible) {
      const d = Math.floor(b.year / 10) * 10;
      if (!decades.has(d)) decades.set(d, []);
      decades.get(d).push(b);
    }
    let html = '';
    for (const [d, list] of decades) {
      html += `<section><h3 class="decade"><span>${d}er</span><span>${list.length}</span></h3><ul class="rows">`;
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
      if (!cities.has(key)) cities.set(key, { key, city: b.city, country: b.country, list: [] });
      cities.get(key).list.push(b);
    }
    return [...cities.values()].sort((a, b) => b.list.length - a.list.length || a.city.localeCompare(b.city, 'de'));
  }

  function citiesHtml() {
    let html = '<ul class="cities">';
    for (const c of cityGroups()) {
      const open = c.key === state.openCity;
      const archs = [...new Set(c.list.map((b) => b.architect))].map((id) => archById.get(id));
      const photo = c.list.find((b) => b.ph[0])?.ph[0];
      const thumb = photo
        ? `<img class="row-thumb" src="${esc(photoUrl(photo[0], 120))}" alt="" width="44" height="44" loading="lazy" decoding="async">`
        : '<span class="row-thumb is-empty"></span>';
      html += `<li class="city${open ? ' is-open' : ''}">
        <button class="city-row" type="button" data-city="${esc(c.key)}" aria-expanded="${open}" style="--c:${archs[0].color}">
          ${thumb}
          <span class="row-text"><span class="row-name">${esc(c.city)}</span>
          <span class="row-place">${archs.map((a) => `<i style="--c:${a.color}"></i>`).join('')}${esc(c.country)} · ${esc(archs.map((a) => a.short).join(', '))}</span></span>
          <span class="city-count">${c.list.length}</span>
          <svg class="city-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 8l5 5 5-5" /></svg>
        </button>`;
      if (open) html += `<ul class="rows">${c.list.map(rowHtml).join('')}</ul>`;
      html += '</li>';
    }
    return `${html}</ul>`;
  }

  function renderIndex() {
    indexEl.innerHTML = !state.visible.length
      ? '<p class="empty">Kein Bau passt zu Suche und Filtern.</p>'
      : state.view === 'cities' ? citiesHtml() : buildingsHtml();
  }

  function markRow(fid) {
    indexEl.querySelector('.row.is-active')?.classList.remove('is-active');
    if (fid == null) return;
    const row = indexEl.querySelector(`.row[data-fid="${fid}"]`);
    if (!row) return;
    row.classList.add('is-active');
    if (!panel.classList.contains('is-collapsed')) row.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  function setView(view) {
    if (state.view === view) return;
    state.view = view;
    for (const tab of document.querySelectorAll('#view-tabs [data-view]')) tab.setAttribute('aria-pressed', String(tab.dataset.view === view));
    const b = state.pinnedFid != null && byFid.get(state.pinnedFid);
    if (view === 'cities' && b) state.openCity = cityKey(b);
    renderIndex();
    indexEl.scrollTop = 0;
    markRow(state.pinnedFid);
  }

  function applyFilter() {
    state.terms = normalize(state.query.trim()).split(/\s+/).filter(Boolean);
    state.visible = buildings.filter((b) => passes(b));
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
    if (map && animate) map.easeTo({ padding: panelPadding(), duration: 350 });
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

  function initMap() {
    if (typeof maplibregl === 'undefined') { mapFailed('library'); return; }
    const startZoom = worldZoom();
    const view = initial.view;
    try {
      map = new maplibregl.Map({
        container: 'map',
        style: window.formatlasStyle(),
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
        cluster: true,
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
    const where = mqNarrow.matches ? 'oben' : 'links';
    notice.show(kind, {
      fatal: true,
      action: reloadPage,
      ...(kind === 'webgl'
        ? {
            title: 'Dein Browser kann die 3D-Karte nicht darstellen.',
            text: `WebGL ist nicht verfügbar, meist weil die Hardwarebeschleunigung ausgeschaltet ist. Das Verzeichnis ${where} funktioniert trotzdem.`,
          }
        : {
            title: 'Die Karte konnte nicht geladen werden.',
            text: `Vermutlich hakt die Verbindung. Das Verzeichnis ${where} funktioniert trotzdem.`,
          }),
    });
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
        title: 'Der Kartenhintergrund lädt gerade nicht.',
        text: navigator.onLine ? 'Die Bauten bleiben sichtbar.' : 'Keine Internetverbindung. Die Bauten bleiben sichtbar.',
        action: { label: 'Erneut versuchen', run: retry },
      });
    });
    map.on('data', (e) => {
      if (e.sourceId === 'omt' && e.tile && errors) {
        errors = 0;
        notice.hide('tiles');
      }
    });
    map.on('webglcontextlost', () =>
      notice.show('context', { title: 'Die Kartengrafik wurde zurückgesetzt.', text: 'Bleibt die Karte leer, hilft Neuladen.', action: reloadPage })
    );
    map.on('webglcontextrestored', () => notice.hide('context'));
    addEventListener('online', () => {
      notice.hide('offline');
      retry();
    });
  }

  addEventListener('offline', () =>
    notice.show('offline', { title: 'Keine Internetverbindung.', text: 'Karte und Fotos laden weiter, sobald du wieder online bist.' })
  );

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

  function fillCard(b) {
    if (cardState.fid === b.fid) return;
    cardState.fid = b.fid;
    const a = archById.get(b.architect);
    card.style.setProperty('--c', b.color);
    tether.style.setProperty('--c', b.color);
    $('card-year').textContent = b.year;
    $('card-kicker').textContent = `${b.type} · ${a.short}`;
    $('card-title').textContent = b.name;
    $('card-place').innerHTML =
      `<b>${esc(b.city)}</b>, ${esc(b.country)}<br>${fmtDeg(b.lat, 'N', 'S')} · ${fmtDeg(b.lng, 'O', 'W')}`;
    $('card-text').textContent = b.text;
    const wiki = $('card-wiki');
    wiki.hidden = !b.wiki;
    if (b.wiki) wiki.href = b.wiki;
    $('card-route').href = `https://www.google.com/maps/search/?api=1&query=${b.lat},${b.lng}`;
    $('card-zoom').hidden = !b.ph.length;
    setSlides(b);
  }

  // Bildnachweis: Urheber mit Link zur Datei auf Commons, Lizenz
  const creditHtml = (p, i, n) =>
    `Foto${n > 1 ? ` ${i + 1}/${n}` : ''}: ` +
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
      img.alt = i === 0 ? `${b.name}, ${b.city}` : `${b.name}, Ansicht ${i + 1}`;
      img.src = photoUrl(p[0], 500);
      if (img.complete && img.naturalWidth) img.classList.add('is-loaded');
    });
    $('card-media').classList.toggle('is-empty', !b.ph.length);
    progressEl.innerHTML =
      b.ph.length > 1
        ? b.ph.map((_, i) => `<button type="button" data-i="${i}" aria-label="Foto ${i + 1} von ${b.ph.length}"><span></span></button>`).join('')
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
    $('card-credit').innerHTML = p ? creditHtml(p, i, slides.list.length) : 'Für diesen Bau gibt es kein frei lizenziertes Foto.';
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
        mode = p.x < (left + vw) / 2 + 120 ? 'dock' : 'dock-left';
        x = mode === 'dock' ? vw - W - gap : left + gap;
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
  const lb = { b: null, index: 0, token: 0, drag: null, swiped: false };
  // Breite passend zum Bildschirm; ist das Original kleiner, liefert Commons einen Fehler → Original
  const bigUrl = (path) => photoUrl(path, innerWidth * (devicePixelRatio || 1) > 1400 ? 1920 : 1280);

  function openLightbox(b, index) {
    lb.b = b;
    clearTimeout(slides.timer);
    slides.running = false;
    $('lb-kicker').textContent = `${b.year} · ${archById.get(b.architect).short} · ${b.city}`;
    $('lb-title').textContent = b.name;
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
    lbImg.alt = `${b.name}, Foto ${lb.index + 1} von ${n}`;
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
    $('lb-credit').innerHTML = creditHtml(p, lb.index, n) + ` · <a href="${esc(originalUrl(p[0]))}" target="_blank" rel="noopener">Original</a>`;
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

  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
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

    // 1. Herauszoomen und Neigung zurücknehmen
    if (map.getZoom() > overview + 0.4 || map.getPitch() > 5) {
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
    const desktopOffset = [-(cardState.w || 304) / 2 - 24, 40];
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

  function land(token) {
    if (token !== flightToken) return;
    state.flying = false;
    link.viewSet = true;
    writeLink();
    const b = state.pinnedFid != null && byFid.get(state.pinnedFid);
    if (!b) return;
    openCard(b, cardAnchorFor(), true);
    startOrbit(b);
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

  function select(b) {
    stopPlay();
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
      const row = indexEl.querySelector(`.row[data-fid="${b.fid}"]`);
      openCard(b, { row: row || panel }, true);
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
    stopOrbit();
    state.pinnedFid = null;
    syncActive();
    markRow(null);
    closeCard();
    writeLink();
  }

  function flyToCity(c) {
    deselect();
    stopPlay();
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
        writeLink();
      }
    );
  }

  function toggleCity(key) {
    state.openCity = state.openCity === key ? null : key;
    renderIndex();
    markRow(state.pinnedFid);
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
    btn.title = orbit.on ? 'Rundflug um das Gebäude ausschalten' : 'Rundflug um das Gebäude einschalten';
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
      while (token === orbit.token) {
        orbit.moving = token;
        await cameraStep({ bearing: map.getBearing() - 30, around: [b.lng, b.lat], duration: (30 / ORBIT_SPEED) * 1000, easing: (t) => t });
        if (orbit.moving === token) orbit.moving = 0;
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
    toast(orbit.on ? 'Rundflug an' : 'Rundflug aus');
    const b = state.pinnedFid != null && byFid.get(state.pinnedFid);
    if (orbit.on && b && !state.flying) startOrbit(b, 0);
    else if (!orbit.on) stopOrbit();
  });

  /* ---------------- Zeitleiste abspielen ---------------- */

  const play = { running: false, raf: 0, start: 0 };

  function startPlay() {
    if (play.running) return;
    // Pausiert mitten in der Zeitleiste: dort weitermachen, sonst von vorn
    const resume = state.from === YEAR_MIN && state.to < YEAR_MAX && state.to > YEAR_MIN;
    deselect();
    play.running = true;
    play.start = performance.now() - (resume ? ((state.to - YEAR_MIN) / PLAY_RATE) * 1000 : 0);
    renderPlay();
    if (map && map.getZoom() > worldZoom() + 1.2) {
      stopOrbit();
      flightToken++;
      state.flying = false;
      // Breite wie beim Start: MapLibre zeichnet den Globus in hohen Breiten größer
      map.flyTo({ center: [map.getCenter().lng, WORLD_CENTER[1]], zoom: worldZoom(), pitch: 0, bearing: 0, padding: panelPadding(), duration: reduceMotion ? 0 : 1800, essential: true });
    }
    const tick = (now) => {
      if (!play.running) return;
      const year = Math.min(YEAR_MAX, YEAR_MIN + Math.floor(((now - play.start) / 1000) * PLAY_RATE));
      if (year !== state.to || state.from !== YEAR_MIN) setYears(YEAR_MIN, year, true);
      if (year >= YEAR_MAX) {
        // kurz stehen lassen, dann ausblenden
        play.raf = 0;
        setTimeout(() => { if (play.running) stopPlay(); }, 1400);
        return;
      }
      play.raf = requestAnimationFrame(tick);
    };
    play.raf = requestAnimationFrame(tick);
  }

  function stopPlay() {
    if (!play.running) return;
    play.running = false;
    cancelAnimationFrame(play.raf);
    renderPlay();
    writeLink();
  }

  function renderPlay() {
    const btn = $('play');
    btn.setAttribute('aria-pressed', String(play.running));
    btn.title = play.running ? 'Zeitleiste anhalten' : 'Zeitleiste abspielen: Bauten erscheinen Jahr für Jahr';
    btn.querySelector('span').textContent = play.running ? 'Anhalten' : 'Abspielen';
    $('play-year').classList.toggle('is-visible', play.running);
    if (play.running) renderPlayYear();
  }

  function renderPlayYear() {
    const n = state.visible.length;
    $('play-year-value').textContent = state.to;
    $('play-year-count').textContent = `${n} ${n === 1 ? 'Bau' : 'Bauten'}`;
  }

  $('play').addEventListener('click', () => (play.running ? stopPlay() : startPlay()));

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
        return `<li style="--c:${b.color}"><i></i>${esc(b.name)} · ${esc(b.city)}</li>`;
      });
      tip.innerHTML =
        `<strong>${total} Bauten</strong><ul>${items.join('')}</ul>` +
        `<p class="more">${total > 6 ? `und ${total - 6} weitere · ` : ''}Klicken zum Hineinzoomen</p>`;
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

    // Eingriff während Flug oder Rundflug: Animation abbrechen, Karte bleibt, wo sie ist
    const interrupt = () => {
      if (state.flying) { flightToken++; state.flying = false; }
      stopOrbit(false);
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
    const row = e.target.closest('.row');
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
    const row = e.target.closest('.row');
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

  $('view-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-view]');
    if (tab) setView(tab.dataset.view);
  });

  // Chips: ohne Auswahl ist alles sichtbar, ein Klick wählt aus, weitere Klicks ergänzen
  $('arch-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const id = chip.dataset.arch;
    if (state.architects.has(id)) state.architects.delete(id);
    else state.architects.add(id);
    applyFilter();
  });

  // fromPlay: Aufruf aus der Zeitleiste, die dabei weiterläuft
  function setYears(from, to, fromPlay = false) {
    if (!fromPlay) stopPlay();
    state.from = clamp(Math.min(from, to), YEAR_MIN, YEAR_MAX);
    state.to = clamp(Math.max(from, to), YEAR_MIN, YEAR_MAX);
    applyFilter();
    if (play.running) renderPlayYear();
  }

  fromEl.addEventListener('input', () => {
    if (+fromEl.value > state.to) fromEl.value = state.to;
    setYears(+fromEl.value, state.to);
  });
  toEl.addEventListener('input', () => {
    if (+toEl.value < state.from) toEl.value = state.from;
    setYears(state.from, +toEl.value);
  });

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

  $('filter-reset').addEventListener('click', () => {
    state.groups.clear();
    state.architects.clear();
    setYears(YEAR_MIN, YEAR_MAX);
  });

  searchEl.addEventListener('input', () => {
    state.query = searchEl.value;
    applyFilter();
  });

  searchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const list = state.visible;
      if (list.length === 1) select(list[0]);
      else if (list.length > 1 && map) {
        const bounds = new maplibregl.LngLatBounds();
        list.forEach((b) => bounds.extend([b.lng, b.lat]));
        link.viewSet = true;
        map.fitBounds(bounds, { padding: 80, maxZoom: 12, pitch: 0, bearing: 0, duration: reduceMotion ? 0 : 1600 });
      }
    } else if (e.key === 'Escape' && searchEl.value) {
      e.stopPropagation();
      searchEl.value = '';
      state.query = '';
      applyFilter();
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
      toast('Link zu dieser Ansicht kopiert');
    } catch {
      toast('Der Link steht in der Adresszeile');
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
      stopPlay();
      deselect();
    }
  });

  mqNarrow.addEventListener('change', () => {
    setPanelOpen(!mqNarrow.matches);
    if (cardState.anchor) positionCard();
  });

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
  searchEl.value = state.query;
  renderOrbitButton();
  applyFilter();
  if (mqNarrow.matches) {
    setPanelOpen(false);
    filtersEl.open = false;
  } else {
    // auf niedrigen Bildschirmen braucht die Liste den Platz; aktive Filter bleiben sichtbar
    filtersEl.open = filtersActive() || innerHeight >= 940;
  }
  if (!navigator.onLine) notice.show('offline', { title: 'Keine Internetverbindung.', text: 'Karte und Fotos laden, sobald du wieder online bist.' });

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
