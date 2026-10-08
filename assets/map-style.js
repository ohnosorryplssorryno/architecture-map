// Eigener Dunkel-Stil für die OpenMapTiles-Vektordaten von OpenFreeMap.
// Bewusst schlank: nur die Ebenen, die zur Orientierung nötig sind.
// Beschriftung in der Sprache der Oberfläche, sonst lateinische Umschrift, sonst Ortsname
window.formatlasLabel = (lang) => ['coalesce', ['get', `name:${lang === 'en' ? 'en' : 'de'}`], ['get', 'name:latin'], ['get', 'name']];

window.formatlasStyle = function formatlasStyle(lang = 'de') {
  const c = {
    land: '#0d1119',
    water: '#05070b',
    park: '#0f1719',
    residential: '#10151e',
    building: '#141a24',
    buildingTop: '#1b2331',
    minor: '#161c27',
    major: '#1e2633',
    motorway: '#283244',
    rail: '#1c2330',
    border: '#344055',
    label: '#6e7889',
    labelStrong: '#a2abba',
    waterLabel: '#34445c',
    halo: '#090c12',
  };

  const name = window.formatlasLabel(lang);
  const src = { source: 'omt' };
  const poly = ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false];
  const zoomWidth = (pairs) => ['interpolate', ['exponential', 1.5], ['zoom'], ...pairs];
  const labelPaint = (color) => ({
    'text-color': color,
    'text-halo-color': c.halo,
    'text-halo-width': 1.2,
    'text-halo-blur': 0.5,
  });

  return {
    version: 8,
    projection: { type: 'globe' },
    sky: {
      'sky-color': '#0b1322',
      'horizon-color': '#1c2a42',
      'fog-color': '#0d1119',
      'sky-horizon-blend': 0.7,
      'horizon-fog-blend': 0.6,
      'fog-ground-blend': 0.85,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.85, 5, 0.6, 8, 0],
    },
    sources: {
      omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
    },
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': c.land } },
      {
        id: 'landcover', type: 'fill', ...src, 'source-layer': 'landcover', minzoom: 6,
        filter: ['all', poly, ['match', ['get', 'class'], ['wood', 'grass'], true, false]],
        paint: { 'fill-color': c.park, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0, 9, 0.8] },
      },
      {
        id: 'residential', type: 'fill', ...src, 'source-layer': 'landuse', minzoom: 8, maxzoom: 13,
        filter: ['all', poly, ['==', ['get', 'class'], 'residential']],
        paint: { 'fill-color': c.residential, 'fill-opacity': 0.7 },
      },
      {
        id: 'park', type: 'fill', ...src, 'source-layer': 'park', minzoom: 8,
        filter: poly,
        paint: { 'fill-color': c.park },
      },
      {
        id: 'water', type: 'fill', ...src, 'source-layer': 'water',
        filter: ['all', poly, ['!=', ['get', 'brunnel'], 'tunnel']],
        paint: { 'fill-color': c.water, 'fill-antialias': false },
      },
      {
        id: 'waterway', type: 'line', ...src, 'source-layer': 'waterway', minzoom: 8,
        paint: { 'line-color': c.water, 'line-width': zoomWidth([8, 0.5, 18, 6]) },
      },
      {
        id: 'aeroway', type: 'line', ...src, 'source-layer': 'aeroway', minzoom: 11,
        filter: ['match', ['get', 'class'], ['runway', 'taxiway'], true, false],
        paint: { 'line-color': c.major, 'line-width': zoomWidth([11, 1, 17, 40]) },
      },
      {
        id: 'building', type: 'fill', ...src, 'source-layer': 'building', minzoom: 13, maxzoom: 15.5,
        paint: { 'fill-color': c.building, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0, 14, 1] },
      },
      {
        id: 'road-path', type: 'line', ...src, 'source-layer': 'transportation', minzoom: 15,
        filter: ['==', ['get', 'class'], 'path'],
        paint: { 'line-color': c.minor, 'line-width': 1, 'line-dasharray': [2, 2] },
      },
      {
        id: 'road-minor', type: 'line', ...src, 'source-layer': 'transportation', minzoom: 12,
        filter: ['match', ['get', 'class'], ['minor', 'service', 'track'], true, false],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': c.minor, 'line-width': zoomWidth([12, 0.4, 18, 9]) },
      },
      {
        id: 'rail', type: 'line', ...src, 'source-layer': 'transportation', minzoom: 11,
        filter: ['match', ['get', 'class'], ['rail', 'transit'], true, false],
        paint: { 'line-color': c.rail, 'line-width': zoomWidth([11, 0.5, 18, 2.5]) },
      },
      {
        id: 'road-major', type: 'line', ...src, 'source-layer': 'transportation', minzoom: 7,
        filter: ['match', ['get', 'class'], ['primary', 'secondary', 'tertiary', 'trunk'], true, false],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': c.major, 'line-width': zoomWidth([7, 0.3, 18, 14]) },
      },
      {
        id: 'road-motorway', type: 'line', ...src, 'source-layer': 'transportation', minzoom: 5,
        filter: ['==', ['get', 'class'], 'motorway'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': c.motorway, 'line-width': zoomWidth([5, 0.4, 18, 16]) },
      },
      {
        id: 'building-3d', type: 'fill-extrusion', ...src, 'source-layer': 'building', minzoom: 15,
        // Umrisse mit eigenen Gebäudeteilen (building:part) nicht doppelt extrudieren
        filter: ['!=', ['get', 'hide_3d'], true],
        paint: {
          'fill-extrusion-color': c.buildingTop,
          'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 6],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'], 15, 0, 15.6, 0.92],
          'fill-extrusion-vertical-gradient': true,
        },
      },
      {
        id: 'border-state', type: 'line', ...src, 'source-layer': 'boundary', minzoom: 4,
        filter: ['all', ['==', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]],
        paint: { 'line-color': c.border, 'line-opacity': 0.45, 'line-width': 0.6, 'line-dasharray': [3, 2] },
      },
      {
        id: 'border-country', type: 'line', ...src, 'source-layer': 'boundary',
        filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1], ['!', ['has', 'claimed_by']]],
        layout: { 'line-join': 'round' },
        paint: { 'line-color': c.border, 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.5, 6, 1.1, 12, 1.6] },
      },
      {
        id: 'label-water', type: 'symbol', ...src, 'source-layer': 'water_name', maxzoom: 9,
        filter: ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false],
        layout: {
          'text-field': name, 'text-font': ['Noto Sans Italic'], 'text-size': 11,
          'text-letter-spacing': 0.25, 'text-max-width': 6,
        },
        paint: labelPaint(c.waterLabel),
      },
      {
        id: 'label-road', type: 'symbol', ...src, 'source-layer': 'transportation_name', minzoom: 14,
        layout: {
          'symbol-placement': 'line', 'text-field': name, 'text-font': ['Noto Sans Regular'],
          'text-size': 10.5, 'symbol-spacing': 400, 'text-max-angle': 30,
        },
        paint: labelPaint(c.label),
      },
      {
        id: 'label-local', type: 'symbol', ...src, 'source-layer': 'place', minzoom: 11, maxzoom: 16,
        filter: ['match', ['get', 'class'], ['suburb', 'quarter', 'neighbourhood'], true, false],
        layout: {
          'text-field': name, 'text-font': ['Noto Sans Regular'], 'text-size': 10.5,
          'text-transform': 'uppercase', 'text-letter-spacing': 0.15, 'text-max-width': 8,
        },
        paint: labelPaint(c.label),
      },
      {
        id: 'label-town', type: 'symbol', ...src, 'source-layer': 'place', minzoom: 8, maxzoom: 15,
        filter: ['match', ['get', 'class'], ['town', 'village'], true, false],
        layout: { 'text-field': name, 'text-font': ['Noto Sans Regular'], 'text-size': 11.5, 'text-max-width': 8 },
        paint: labelPaint(c.label),
      },
      {
        id: 'label-city', type: 'symbol', ...src, 'source-layer': 'place', minzoom: 3, maxzoom: 14,
        filter: ['==', ['get', 'class'], 'city'],
        layout: {
          'text-field': name, 'text-font': ['Noto Sans Regular'], 'text-max-width': 8,
          'text-size': ['interpolate', ['linear'], ['zoom'], 3, 11, 8, 13.5, 12, 16],
          'symbol-sort-key': ['get', 'rank'],
        },
        paint: labelPaint(c.labelStrong),
      },
      {
        id: 'label-country', type: 'symbol', ...src, 'source-layer': 'place', minzoom: 1.5, maxzoom: 7,
        filter: ['==', ['get', 'class'], 'country'],
        layout: {
          'text-field': name, 'text-font': ['Noto Sans Regular'], 'text-transform': 'uppercase',
          'text-letter-spacing': 0.22, 'text-max-width': 7,
          'text-size': ['interpolate', ['linear'], ['zoom'], 2, 9.5, 6, 12.5],
          'symbol-sort-key': ['get', 'rank'],
        },
        paint: labelPaint(c.label),
      },
    ],
  };
};
