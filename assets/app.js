(() => {
  'use strict';

  const { architects, buildings } = window.FORMATLAS_DATA;
  const $ = (id) => document.getElementById(id);
  const NEUTRAL = '#e6e1d8'; // Cluster mit Bauten verschiedener Architekten
  const FID_OFFSET = 1e6; // Abstand zu den Cluster-IDs von MapLibre
  const EARTH = 40075016.686; // Erdumfang in Metern
  const CLOSE_ZOOM = 14; // ab hier verschwinden die Punkte, der Lichtschein bleibt
  const DOCK_ZOOM = 12.5; // ab hier sitzt die Infokarte am Rand statt über dem Punkt
  const WORLD_CENTER = [20, 30];
  const SLIDE_MS = 2800; // Standzeit eines Fotos in der Vorschau
  const BIN = 5; // Jahre pro Balken im Histogramm
  const THUMBS = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/';

  // Gebäudetypen für den Typfilter zusammengefasst
  const GROUPS = [
    { id: 'kultur', label: 'Kultur', types: ['Museum', 'Kultur', 'Konzerthaus', 'Galerie', 'Ausstellung', 'Pavillon', 'Wissenschaft', 'Park'] },
    { id: 'sakral', label: 'Sakral', types: ['Kirche', 'Kloster', 'Synagoge'] },
    { id: 'wohnen', label: 'Wohnen', types: ['Wohnen', 'Villa', 'Hotel'] },
    { id: 'buero', label: 'Büro', types: ['Büro', 'Hochhaus', 'Industrie', 'Messe', 'Forschung', 'Handel'] },
    { id: 'staat', label: 'Staat', types: ['Regierung', 'Parlament', 'Gericht', 'Verwaltung'] },
    { id: 'bildung', label: 'Bildung', types: ['Bildung', 'Bibliothek'] },
    { id: 'verkehr', label: 'Verkehr', types: ['Verkehr', 'Brücke', 'Flughafen', 'Bahnhof'] },
    { id: 'sport', label: 'Sport', types: ['Sport', 'Stadion'] },
  ];

  const mqHover = matchMedia('(hover: hover) and (pointer: fine)');
  const mqNarrow = matchMedia('(max-width: 640px)');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const normalize = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  const rad = (d) => (d * Math.PI) / 180;
  const fmtDeg = (v, pos, neg) =>
    `${Math.abs(v).toLocaleString('de-DE', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}° ${v >= 0 ? pos : neg}`;
  // Foto-Pfad aus Wikimedia Commons → Thumbnail-URL in Standardbreite
  const photoUrl = (path, width) => (path.startsWith('http') ? path : `${THUMBS}${path}/${width}px-${path.split('/').pop()}`);

  /* ---------------- Daten ---------------- */

  const archById = new Map(architects.map((a) => [a.id, a]));
  const groupOfType = new Map(GROUPS.flatMap((g) => g.types.map((t) => [t, g.id])));
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
    hoverFid: null, // Punkt unter dem Mauszeiger
    listFid: null, // Zeile unter dem Mauszeiger
    pinnedFid: null, // angeklickter Bau
    flying: false,
  };

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
  fromEl.value = YEAR_MIN;
  toEl.value = YEAR_MAX;

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
    const countries = new Set(state.visible.map((b) => b.country)).size;
    $('result').textContent = n
      ? `${n} ${n === 1 ? 'Bau' : 'Bauten'} · ${countries} ${countries === 1 ? 'Land' : 'Länder'}`
      : 'Keine Treffer';
  }

  function renderIndex() {
    if (!state.visible.length) {
      indexEl.innerHTML = '<p class="empty">Kein Bau passt zu Suche und Filtern.</p>';
      return;
    }
    const decades = new Map();
    for (const b of state.visible) {
      const d = Math.floor(b.year / 10) * 10;
      if (!decades.has(d)) decades.set(d, []);
      decades.get(d).push(b);
    }
    let html = '';
    for (const [d, list] of decades) {
      html += `<section><h3 class="decade"><span>${d}er</span><span>${list.length}</span></h3><ul class="rows">`;
      for (const b of list) {
        const thumb = b.ph[0]
          ? `<img class="row-thumb" src="${esc(photoUrl(b.ph[0][0], 120))}" alt="" width="44" height="44" loading="lazy" decoding="async">`
          : '<span class="row-thumb is-empty"></span>';
        html += `<li><button class="row${b.fid === state.pinnedFid ? ' is-active' : ''}" type="button" data-fid="${b.fid}" style="--c:${b.color}">
          ${thumb}
          <span class="row-text"><span class="row-name">${esc(b.name)}</span>
          <span class="row-place"><i></i>${esc(archById.get(b.architect).short)} · ${esc(b.city)}</span></span>
          <span class="row-year">${b.year}</span></button></li>`;
      }
      html += '</ul></section>';
    }
    indexEl.innerHTML = html;
  }

  function markRow(fid) {
    indexEl.querySelector('.row.is-active')?.classList.remove('is-active');
    if (fid == null) return;
    const row = indexEl.querySelector(`.row[data-fid="${fid}"]`);
    if (!row) return;
    row.classList.add('is-active');
    if (!panel.classList.contains('is-collapsed')) row.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
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
    const startZoom = worldZoom();
    map = new maplibregl.Map({
      container: 'map',
      style: window.formatlasStyle(),
      center: WORLD_CENTER,
      zoom: reduceMotion ? startZoom : startZoom - 0.45,
      bearing: reduceMotion ? 0 : -12,
      minZoom: 0.4,
      maxZoom: 19,
      maxPitch: 70,
      attributionControl: { compact: true },
      fadeDuration: 180,
      // Drehen mit rechter Maustaste: 70 % langsamer als der Standard (0,8 °/px)
      rotateDegreesPerPixelMoved: 0.24,
      aroundCenter: false,
    });
    map.setPadding(panelPadding());

    map.on('load', () => {
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

      if (!reduceMotion) map.easeTo({ zoom: startZoom, bearing: 0, duration: 2200, easing: easeOut });

      const fromHash = byId.get(decodeURIComponent(location.hash.slice(1)));
      if (fromHash) select(fromHash);
    });

    bindMapEvents();
  }

  /* Hervorhebung über Feature-State, ohne Neuberechnung der Quelle */
  const activeFids = new Set();
  function syncActive() {
    if (!map?.getSource('b')) return;
    const next = new Set([state.hoverFid, state.listFid, state.pinnedFid].filter((v) => v != null));
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
    setSlides(b);
  }

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
    $('card-credit').innerHTML = p
      ? `Foto${slides.list.length > 1 ? ` ${i + 1}/${slides.list.length}` : ''}: ` +
        `<a href="https://commons.wikimedia.org/wiki/File:${esc(p[0].split('/').pop())}" target="_blank" rel="noopener">${esc(p[1] || 'Wikimedia Commons')}</a>` +
        (p[2] ? ` · ${esc(p[2])}` : '')
      : 'Für diesen Bau gibt es kein frei lizenziertes Foto.';
    scheduleSlide();
  }

  function scheduleSlide() {
    clearTimeout(slides.timer);
    slides.running = !reduceMotion && slides.list.length > 1 && !!cardState.anchor;
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
      else img.addEventListener('load', () => { if (cardState.anchor && slides.list[next]) showSlide(next); }, { once: true });
    }, SLIDE_MS);
  }

  progressEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn) showSlide(Number(btn.dataset.i));
  });
  $('card-media').addEventListener('click', (e) => {
    if (e.target.closest('#card-progress') || slides.list.length < 2) return;
    showSlide((slides.index + 1) % slides.list.length);
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

  // Wie bei Kartendiensten: herauszoomen, hinüberfliegen, hineinzoomen
  async function flyToBuilding(b) {
    const token = ++flightToken;
    state.flying = true;
    // Gebäude landet in der Mitte der freien Fläche zwischen Verzeichnis und Infokarte
    const desktopOffset = [-(cardState.w || 304) / 2 - 24, 40];
    const end = {
      center: [b.lng, b.lat],
      zoom: flyZoom(b),
      pitch: 60,
      bearing: -20,
      padding: panelPadding(),
      offset: mqNarrow.matches ? [0, -innerHeight * 0.18] : desktopOffset,
    };
    if (reduceMotion) {
      map.jumpTo(end);
      land(token);
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
    // 3. Hineinzoomen und in die Schrägansicht kippen
    await cameraStep({ ...end, duration: clamp((end.zoom - map.getZoom()) * 280, 1200, 3200), easing: easeOut });
    land(token);
  }

  function land(token) {
    if (token !== flightToken) return;
    state.flying = false;
    if (state.pinnedFid != null) openCard(byFid.get(state.pinnedFid), cardAnchorFor(), true);
  }

  function select(b) {
    if (!map) return;
    map.stop(); // laufende Animation beenden, bevor sich die Auswahl ändert
    state.pinnedFid = b.fid;
    state.listFid = null;
    syncActive();
    markRow(b.fid);
    history.replaceState(null, '', `#${b.id}`);
    preloadPhotos(b);
    closeCard();
    // Auf schmalen Bildschirmen das Verzeichnis einklappen, damit neben der
    // angedockten Infokarte genug Platz für das Gebäude bleibt
    const open = !panel.classList.contains('is-collapsed');
    if (open && (mqNarrow.matches || innerWidth - panel.offsetWidth - (cardState.w || 304) < 460)) setPanelOpen(false, false);
    flyToBuilding(b);
  }

  function deselect() {
    if (state.pinnedFid == null) return;
    state.pinnedFid = null;
    syncActive();
    markRow(null);
    closeCard();
    history.replaceState(null, '', location.pathname + location.search);
  }

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

    // Eingriff während des Flugs: Animation abbrechen, Karte bleibt, wo sie ist
    const interrupt = () => { if (state.flying) { flightToken++; state.flying = false; } };
    for (const type of ['mousedown', 'touchstart', 'wheel']) map.on(type, interrupt);

    map.on('movestart', hideClusterTip);
    map.on('moveend', () => {
      if (state.pinnedFid != null && !cardState.anchor && !state.flying) {
        openCard(byFid.get(state.pinnedFid), cardAnchorFor(), true);
      }
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
    const row = e.target.closest('.row');
    if (row) select(byFid.get(Number(row.dataset.fid)));
  });

  indexEl.addEventListener('pointerover', (e) => {
    if (!mqHover.matches) return;
    const row = e.target.closest('.row');
    if (!row) return;
    const fid = Number(row.dataset.fid);
    if (fid === state.listFid) return;
    state.listFid = fid;
    syncActive();
    if (state.pinnedFid == null && !state.flying) openCard(byFid.get(fid), { row }, false);
  });

  const leaveIndex = () => {
    if (state.listFid == null) return;
    state.listFid = null;
    syncActive();
    if (state.pinnedFid == null && cardState.anchor?.row) closeCard();
  };
  indexEl.addEventListener('pointerleave', leaveIndex);
  indexEl.addEventListener('scroll', leaveIndex, { passive: true });

  // Chips: ohne Auswahl ist alles sichtbar, ein Klick wählt aus, weitere Klicks ergänzen
  $('arch-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const id = chip.dataset.arch;
    if (state.architects.has(id)) state.architects.delete(id);
    else state.architects.add(id);
    applyFilter();
  });

  function setYears(from, to) {
    state.from = clamp(Math.min(from, to), YEAR_MIN, YEAR_MAX);
    state.to = clamp(Math.max(from, to), YEAR_MIN, YEAR_MAX);
    fromEl.value = state.from;
    toEl.value = state.to;
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
  $('zoom-in').addEventListener('click', () => map?.zoomIn());
  $('zoom-out').addEventListener('click', () => map?.zoomOut());
  $('reset-view').addEventListener('click', () => {
    if (!map) return;
    deselect();
    flightToken++;
    state.flying = false;
    map.flyTo({ center: WORLD_CENTER, zoom: worldZoom(), pitch: 0, bearing: 0, padding: panelPadding(), duration: reduceMotion ? 0 : 2000, essential: true });
  });

  addEventListener('keydown', (e) => {
    const typing = e.target instanceof HTMLInputElement && e.target.type !== 'range';
    if (e.key === '/' && !typing) {
      e.preventDefault();
      if (panel.classList.contains('is-collapsed')) setPanelOpen(true);
      searchEl.focus();
    } else if (e.key === 'Escape') {
      if (typing) searchEl.blur();
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

  applyFilter();
  if (mqNarrow.matches) {
    setPanelOpen(false);
    filtersEl.open = false;
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
