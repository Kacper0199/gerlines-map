const TOKENS = {
  dark: {
    cat: { hsr: '#F2F4F7', ld: '#BFC7D2', night: '#BFC7D2', rfast: '#F0B04A', reg: '#C98524', sbahn: '#34B98A', foreign: '#6F7A90' },
    delay: ['#4FB98E', '#E8A33D', '#E5733F', '#F3906F', '#6F7A90'],
    sel: '#6EC8FF',
    halo: '#FFFFFF',
    edge: '#0F1318',
    ink: '#E7EBF0',
    surface: '#0F1318',
    map: {
      land: '#12171D', water: '#0B0F14', wood: '#141B20', residential: '#151B22', park: '#141C21', building: '#171E26',
      roadMinor: '#1E252D', roadMajor: '#252D36', roadMotorway: '#2A323C', rail: '#2E3846',
      label: '#7D8794', labelStrong: '#9AA4B1', halo: '#12171D',
      boundaryCountry: '#3A4656', boundaryState: '#262E39', outline: '#4A586B',
      mask: '#0B0F14', maskOpacity: 0.72
    }
  },
  light: {
    cat: { hsr: '#1B2430', ld: '#566273', night: '#566273', rfast: '#BD7000', reg: '#8A5507', sbahn: '#0E8F66', foreign: '#7B879C' },
    delay: ['#0E8F66', '#BD7000', '#C4521F', '#A33A12', '#7B879C'],
    sel: '#0971B3',
    halo: '#FFFFFF',
    edge: '#FFFFFF',
    ink: '#131A22',
    surface: '#F6F7F9',
    map: {
      land: '#EDEFF2', water: '#C7D6E3', wood: '#E3E8E6', residential: '#E7E9ED', park: '#E1E8E4', building: '#E1E4E9',
      roadMinor: '#FAFBFC', roadMajor: '#FFFFFF', roadMotorway: '#CBD2DB', rail: '#A9B3C0',
      label: '#566170', labelStrong: '#3E4856', halo: '#EDEFF2',
      boundaryCountry: '#8C97A6', boundaryState: '#C2C9D2', outline: '#7E8A9B',
      mask: '#AEB6C0', maskOpacity: 0.5
    }
  }
};

const LINE = ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false];
const NAME = ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name']];
const FONT = ['Noto Sans Regular'];
const FONT_BOLD = ['Noto Sans Bold'];

function buildStyle(theme) {
  const m = TOKENS[theme].map;
  const abs = (p) => new URL(p, location.href).href;
  const road = (id, classes, minzoom, color, widths) => ({
    id, type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom,
    filter: ['all', LINE, ['match', ['get', 'class'], classes, true, false], ['!=', ['get', 'brunnel'], 'tunnel']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': color, 'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], ...widths] }
  });
  const place = (id, cls, extra, size, color, font, filter) => ({
    id, type: 'symbol', source: 'omt', 'source-layer': 'place',
    filter: filter || ['==', ['get', 'class'], cls],
    ...extra,
    layout: {
      'text-field': NAME, 'text-font': font || FONT, 'text-size': size, 'text-max-width': 7,
      'symbol-sort-key': ['coalesce', ['get', 'rank'], 99], ...(extra.layout || {})
    },
    paint: { 'text-color': color, 'text-halo-color': m.halo, 'text-halo-width': 1.4 }
  });

  const layers = [
    { id: 'background', type: 'background', paint: { 'background-color': m.land } },
    { id: 'wood', type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: ['==', ['get', 'class'], 'wood'], paint: { 'fill-color': m.wood } },
    { id: 'residential', type: 'fill', source: 'omt', 'source-layer': 'landuse', filter: ['==', ['get', 'class'], 'residential'], paint: { 'fill-color': m.residential } },
    { id: 'park', type: 'fill', source: 'omt', 'source-layer': 'landuse', minzoom: 9, filter: ['match', ['get', 'class'], ['park', 'cemetery', 'pitch'], true, false], paint: { 'fill-color': m.park } },
    { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', filter: ['!=', ['get', 'brunnel'], 'tunnel'], paint: { 'fill-color': m.water } },
    { id: 'waterway', type: 'line', source: 'omt', 'source-layer': 'waterway', minzoom: 7, filter: ['match', ['get', 'class'], ['river', 'canal'], true, false], paint: { 'line-color': m.water, 'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.6, 12, 2, 16, 5] } },
    { id: 'building', type: 'fill', source: 'omt', 'source-layer': 'building', minzoom: 13, paint: { 'fill-color': m.building } },
    road('road-minor', ['minor', 'service', 'track'], 12, m.roadMinor, [12, 0.5, 16, 3, 20, 14]),
    road('road-major', ['primary', 'secondary', 'tertiary', 'trunk'], 7, m.roadMajor, [7, 0.4, 10, 0.9, 12, 1.6, 16, 5, 20, 20]),
    road('road-motorway', ['motorway'], 5, m.roadMotorway, [5, 0.5, 8, 1, 12, 2.2, 16, 7, 20, 26]),
    { id: 'germany-mask', type: 'fill', source: 'mask', paint: { 'fill-color': m.mask, 'fill-opacity': m.maskOpacity } },
    {
      id: 'rail', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 6,
      filter: ['all', LINE, ['==', ['get', 'class'], 'rail'], ['!', ['has', 'service']], ['!=', ['get', 'brunnel'], 'tunnel']],
      layout: { 'line-join': 'round' },
      paint: { 'line-color': m.rail, 'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 6, 0.5, 10, 0.9, 13, 1.4, 16, 3, 20, 8] }
    },
    {
      id: 'rail-service', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 14,
      filter: ['all', LINE, ['match', ['get', 'class'], ['rail', 'transit'], true, false], ['has', 'service']],
      paint: { 'line-color': m.rail, 'line-width': ['interpolate', ['linear'], ['zoom'], 14, 0.6, 18, 2] }
    },
    {
      id: 'boundary-state', type: 'line', source: 'omt', 'source-layer': 'boundary', minzoom: 4,
      filter: ['==', ['get', 'admin_level'], 4],
      layout: { 'line-join': 'round' },
      paint: { 'line-color': m.boundaryState, 'line-dasharray': [3, 3], 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.6, 12, 1.4] }
    },
    {
      id: 'boundary-country', type: 'line', source: 'omt', 'source-layer': 'boundary',
      filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['coalesce', ['get', 'maritime'], 0], 1]],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': m.boundaryCountry, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.8, 12, 2] }
    },
    { id: 'germany-outline', type: 'line', source: 'outline', paint: { 'line-color': m.outline, 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.8, 12, 1.6] } },
    {
      id: 'road-name', type: 'symbol', source: 'omt', 'source-layer': 'transportation_name', minzoom: 14,
      filter: LINE,
      layout: { 'symbol-placement': 'line', 'text-field': NAME, 'text-font': FONT, 'text-size': 11, 'symbol-spacing': 320 },
      paint: { 'text-color': m.label, 'text-halo-color': m.halo, 'text-halo-width': 1.2 }
    },
    place('place-suburb', 'suburb', { minzoom: 11.5 }, 11, m.label),
    place('place-village', 'village', { minzoom: 9, maxzoom: 14 }, 11, m.label),
    place('place-town', 'town', { minzoom: 7, maxzoom: 15 }, ['interpolate', ['linear'], ['zoom'], 7, 11, 12, 13], m.label),
    place('place-city', 'city', { maxzoom: 14 }, ['interpolate', ['linear'], ['zoom'], 4, 11, 10, 14], m.labelStrong, FONT_BOLD, ['all', ['==', ['get', 'class'], 'city'], ['>', ['get', 'rank'], 3]]),
    place('place-city-large', 'city', { maxzoom: 14 }, ['interpolate', ['linear'], ['zoom'], 4, 12, 10, 16], m.labelStrong, FONT_BOLD, ['all', ['==', ['get', 'class'], 'city'], ['<=', ['get', 'rank'], 3]]),
    place('place-country', 'country', { maxzoom: 7 }, ['interpolate', ['linear'], ['zoom'], 2, 11, 6, 14], m.label, FONT_BOLD, ['==', ['get', 'class'], 'country'])
  ];

  return {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
      mask: { type: 'geojson', data: abs('data/germany-mask.geojson') },
      outline: { type: 'geojson', data: abs('data/germany-outline.geojson') }
    },
    layers
  };
}
