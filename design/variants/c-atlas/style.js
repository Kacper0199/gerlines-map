(function () {
  const PAL = {
    dark: {
      land: '#14201E', farm: '#1A251F', grass: '#172722', forest: '#183027', wetland: '#16292A', rock: '#1C2827',
      urban: '#1B2926', water: '#0B1517', river: '#143A41',
      roadMinor: '#1D2A27', roadTertiary: '#22302D', roadMain: '#2A3A36', roadMotorway: '#34463F',
      rail: '#2C3D39', railTick: '#14201E', building: '#1A2825',
      boundary: '#46605A', boundaryState: '#33463F',
      label: '#8FA39B', labelStrong: '#B5C7BF', labelFaint: '#84998F', halo: '#14201E',
      hsShadow: '#050B0B', hsHigh: '#2A3A36', hsExag: 0.8,
      mask: '#070D0D', maskOpacity: 0.58,
      long: '#FFFFFF', fast: '#F0B44C', reg: '#B27C2A', s: '#5BC98A', foreign: '#A5A3C9',
      d0: '#7FD6C2', d1: '#F4E285', d2: '#F2994A', d3: '#E8554E', dn: '#6F7A90',
      sel: '#FF7AA8', selRing: '#FFD3E2', markerEdge: '#0B1517'
    },
    light: {
      land: '#E8EEE7', farm: '#EFF0DF', grass: '#E1EADA', forest: '#CDDFCB', wetland: '#D5E4DC', rock: '#DADFD8',
      urban: '#DFE5DD', water: '#BBD5DB', river: '#8FBCC7',
      roadMinor: '#F6F8F4', roadTertiary: '#FFFFFF', roadMain: '#FFFFFF', roadMotorway: '#F3EBD6',
      rail: '#9AA9A3', railTick: '#E8EEE7', building: '#DAE0D8',
      boundary: '#6B8077', boundaryState: '#A5B4AD',
      label: '#3E524B', labelStrong: '#1B2D27', labelFaint: '#566A63', halo: '#F1F5EF',
      hsShadow: '#5B6B66', hsHigh: '#FFFFFF', hsExag: 0.45,
      mask: '#F3F7F4', maskOpacity: 0.66,
      long: '#101A1B', fast: '#B8700A', reg: '#7C4B05', s: '#1B8A55', foreign: '#7573A8',
      d0: '#17806C', d1: '#8F7A00', d2: '#C2540A', d3: '#B3261E', dn: '#6A7783',
      sel: '#D6246E', selRing: '#FFFFFF', markerEdge: '#F6F8F4'
    }
  };

  const GROUPS = ['long', 'fast', 'reg', 's', 'foreign'];
  const DGROUPS = ['d0', 'd1', 'd2', 'd3', 'dn'];

  function colorExpr(P, mode) {
    if (mode === 'delay') {
      return ['match', ['get', 'd'], 'd0', P.d0, 'd1', P.d1, 'd2', P.d2, 'd3', P.d3, P.dn];
    }
    return ['match', ['get', 'g'], 'long', P.long, 'fast', P.fast, 'reg', P.reg, 's', P.s, 'foreign', P.foreign, P.long];
  }

  function iconExpr(mode) {
    return ['concat', 'm-', ['get', mode === 'delay' ? 'd' : 'g']];
  }

  function visibilityFilter(hiddenGroups, hiddenDelay, mode, foreignOn, selId) {
    const f = ['all', ['!=', ['get', 'id'], selId]];
    if (!foreignOn) f.push(['!', ['get', 'f']]);
    if (mode === 'category' && hiddenGroups.length) f.push(['!', ['in', ['get', 'g'], ['literal', hiddenGroups]]]);
    if (mode === 'delay' && hiddenDelay.length) f.push(['!', ['in', ['get', 'd'], ['literal', hiddenDelay]]]);
    return f;
  }

  const NAME = ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name']];
  const LINE = ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false];

  function buildStyle(theme, D, opts) {
    const P = PAL[theme];
    const o = Object.assign({ mode: 'category', hiddenGroups: [], hiddenDelay: [], foreignOn: true, routeOn: true }, opts || {});
    const zoomW = (a, b, c) => ['interpolate', ['exponential', 1.4], ['zoom'], a[0], a[1], b[0], b[1], c[0], c[1]];
    const road = (id, classes, color, minzoom, widths) => ({
      id, type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom,
      filter: ['all', LINE, ['match', ['get', 'class'], classes, true, false], ['!=', ['get', 'brunnel'], 'tunnel']],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': color, 'line-width': zoomW(...widths) }
    });
    const place = (id, cls, extra, layout, paint, filterExtra) => ({
      id, type: 'symbol', source: 'omt', 'source-layer': 'place',
      filter: filterExtra ? ['all', ['==', ['get', 'class'], cls], filterExtra] : ['==', ['get', 'class'], cls],
      ...extra,
      layout: Object.assign({ 'text-field': NAME, 'text-font': ['Noto Sans Regular'], 'text-max-width': 8 }, layout),
      paint: Object.assign({ 'text-color': P.label, 'text-halo-color': P.halo, 'text-halo-width': 1.4 }, paint)
    });

    const layers = [
      { id: 'background', type: 'background', paint: { 'background-color': P.land } },
      { id: 'lc-farm', type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: ['==', ['get', 'class'], 'farmland'], paint: { 'fill-color': P.farm } },
      { id: 'lc-grass', type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: ['==', ['get', 'class'], 'grass'], paint: { 'fill-color': P.grass } },
      { id: 'lc-wetland', type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: ['==', ['get', 'class'], 'wetland'], paint: { 'fill-color': P.wetland } },
      { id: 'lc-rock', type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: ['match', ['get', 'class'], ['rock', 'sand'], true, false], paint: { 'fill-color': P.rock } },
      { id: 'lc-wood', type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: ['==', ['get', 'class'], 'wood'], paint: { 'fill-color': P.forest } },
      { id: 'park', type: 'fill', source: 'omt', 'source-layer': 'park', paint: { 'fill-color': P.grass, 'fill-opacity': 0.8 } },
      { id: 'lu-urban', type: 'fill', source: 'omt', 'source-layer': 'landuse', filter: ['match', ['get', 'class'], ['residential', 'commercial', 'industrial', 'retail'], true, false], paint: { 'fill-color': P.urban } },
      { id: 'hillshade', type: 'hillshade', source: 'dem', paint: {
        'hillshade-shadow-color': P.hsShadow, 'hillshade-highlight-color': P.hsHigh, 'hillshade-accent-color': P.hsShadow,
        'hillshade-exaggeration': P.hsExag, 'hillshade-illumination-direction': 315, 'hillshade-method': 'multidirectional'
      } },
      { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', filter: ['!=', ['get', 'brunnel'], 'tunnel'], paint: { 'fill-color': P.water, 'fill-antialias': true } },
      { id: 'river', type: 'line', source: 'omt', 'source-layer': 'waterway', minzoom: 6,
        filter: ['all', LINE, ['==', ['get', 'class'], 'river'], ['!=', ['get', 'brunnel'], 'tunnel']],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': P.river, 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 6, 0.8, 10, 1.6, 14, 4.5] } },
      { id: 'stream', type: 'line', source: 'omt', 'source-layer': 'waterway', minzoom: 11,
        filter: ['all', LINE, ['match', ['get', 'class'], ['canal', 'stream', 'ditch'], true, false], ['!=', ['get', 'brunnel'], 'tunnel']],
        paint: { 'line-color': P.river, 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.5, 15, 1.6] } },
      { id: 'building', type: 'fill', source: 'omt', 'source-layer': 'building', minzoom: 13, paint: { 'fill-color': P.building, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0, 14.5, 1] } },
      road('road-minor', ['minor', 'service', 'track'], P.roadMinor, 12.5, [[12.5, 0.4], [15, 1.3], [19, 8]]),
      road('road-tertiary', ['tertiary'], P.roadTertiary, 10.5, [[10.5, 0.4], [13, 1], [18, 10]]),
      road('road-main', ['primary', 'secondary', 'trunk'], P.roadMain, 8, [[8, 0.5], [12, 1.5], [18, 14]]),
      road('road-motorway', ['motorway'], P.roadMotorway, 6, [[6, 0.5], [10, 1.4], [18, 16]]),
      { id: 'mask', type: 'fill', source: 'mask', paint: { 'fill-color': P.mask, 'fill-opacity': P.maskOpacity, 'fill-antialias': true } },
      { id: 'rail', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 8,
        filter: ['all', LINE, ['==', ['get', 'class'], 'rail'], ['!', ['has', 'service']], ['!=', ['get', 'brunnel'], 'tunnel']],
        paint: { 'line-color': P.rail, 'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 8, 0.5, 12, 1.4, 16, 3.2] } },
      { id: 'rail-tick', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 12.5,
        filter: ['all', LINE, ['==', ['get', 'class'], 'rail'], ['!', ['has', 'service']], ['!=', ['get', 'brunnel'], 'tunnel']],
        paint: { 'line-color': P.railTick, 'line-width': ['interpolate', ['linear'], ['zoom'], 12.5, 0.6, 16, 1.6], 'line-dasharray': [3, 3] } },
      { id: 'rail-service', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 13.5,
        filter: ['all', LINE, ['==', ['get', 'class'], 'rail'], ['has', 'service']],
        paint: { 'line-color': P.rail, 'line-opacity': 0.7, 'line-width': ['interpolate', ['linear'], ['zoom'], 13.5, 0.4, 17, 1.4] } },
      { id: 'boundary-state', type: 'line', source: 'omt', 'source-layer': 'boundary', minzoom: 4, filter: ['==', ['get', 'admin_level'], 4],
        layout: { 'line-join': 'round' },
        paint: { 'line-color': P.boundaryState, 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.6, 10, 1.4], 'line-dasharray': [2, 2] } },
      { id: 'boundary-country', type: 'line', source: 'omt', 'source-layer': 'boundary', filter: ['all', ['==', ['get', 'admin_level'], 2], ['!', ['has', 'claimed_by']]],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': P.boundary, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.8, 10, 2] } },
      place('pl-country', 'country', { maxzoom: 7 }, { 'text-font': ['Noto Sans Italic'], 'text-size': ['interpolate', ['linear'], ['zoom'], 3, 11, 6, 14] }, { 'text-color': P.labelFaint }),
      place('pl-state', 'state', { minzoom: 4, maxzoom: 8 }, { 'text-font': ['Noto Sans Italic'], 'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10, 7, 13], 'text-letter-spacing': 0.04 }, { 'text-color': P.labelFaint }),
      place('pl-suburb', 'suburb', { minzoom: 11.5, maxzoom: 15 }, { 'text-font': ['Noto Sans Italic'], 'text-size': 11 }, { 'text-color': P.labelFaint }),
      place('pl-village', 'village', { minzoom: 9.5, maxzoom: 15 }, { 'text-size': ['interpolate', ['linear'], ['zoom'], 9.5, 10.5, 13, 12] }, {}),
      place('pl-town', 'town', { minzoom: 6.5, maxzoom: 15 }, { 'text-size': ['interpolate', ['linear'], ['zoom'], 6.5, 10.5, 11, 13.5] }, {}),
      place('pl-city', 'city', { minzoom: 4, maxzoom: 15 }, { 'text-font': ['Noto Sans Bold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 4, 11, 7, 14, 12, 18], 'symbol-sort-key': ['get', 'rank'] }, { 'text-color': P.labelStrong }),
      { id: 'route-ahead-casing', type: 'line', source: 'route', filter: ['==', ['get', 'part'], 'ahead'],
        layout: { 'line-cap': 'round', 'line-join': 'round', visibility: o.routeOn ? 'visible' : 'none' },
        paint: { 'line-color': P.halo, 'line-opacity': 0.75, 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 4, 12, 7] } },
      { id: 'route-travelled', type: 'line', source: 'route', filter: ['==', ['get', 'part'], 'travelled'],
        layout: { 'line-cap': 'round', 'line-join': 'round', visibility: o.routeOn ? 'visible' : 'none' },
        paint: { 'line-color': P.sel, 'line-opacity': 0.38, 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.6, 12, 3] } },
      { id: 'route-ahead', type: 'line', source: 'route', filter: ['==', ['get', 'part'], 'ahead'],
        layout: { 'line-cap': 'round', 'line-join': 'round', visibility: o.routeOn ? 'visible' : 'none' },
        paint: { 'line-color': P.sel, 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 2, 12, 3.6] } },
      { id: 'stops-dot', type: 'circle', source: 'stops', minzoom: 5,
        layout: { visibility: o.routeOn ? 'visible' : 'none' },
        paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 2, 12, 4.5], 'circle-color': P.land, 'circle-stroke-color': P.sel, 'circle-stroke-width': 1.4, 'circle-stroke-opacity': ['case', ['get', 'passed'], 0.5, 1] } },
      { id: 'stops-label', type: 'symbol', source: 'stops', minzoom: 9.5,
        layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-anchor': 'top', 'text-offset': [0, 0.9], 'text-max-width': 9, visibility: o.routeOn ? 'visible' : 'none' },
        paint: { 'text-color': P.labelStrong, 'text-halo-color': P.halo, 'text-halo-width': 1.6 } },
      { id: 'tr-dot', type: 'circle', source: 'trains', maxzoom: 11.6,
        filter: visibilityFilter(o.hiddenGroups, o.hiddenDelay, o.mode, o.foreignOn, D.selId),
        layout: { 'circle-sort-key': ['get', 'k'] },
        paint: {
          'circle-color': colorExpr(P, o.mode),
          'circle-opacity': ['interpolate', ['linear'], ['zoom'], 10.4, ['case', ['get', 'f'], 0.7, 1], 11.6, 0],
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 1.8, 6, 2.6, 9, 3.6, 11, 5],
          'circle-stroke-color': P.markerEdge,
          'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 10.4, 0.9, 11.6, 0],
          'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 4, 0.5, 8, 0.9]
        } },
      { id: 'tr-sym', type: 'symbol', source: 'trains', minzoom: 10.4,
        filter: visibilityFilter(o.hiddenGroups, o.hiddenDelay, o.mode, o.foreignOn, D.selId),
        layout: {
          'icon-image': iconExpr(o.mode), 'icon-rotate': ['get', 'b'], 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map',
          'icon-allow-overlap': true, 'icon-ignore-placement': true,
          'icon-size': ['interpolate', ['linear'], ['zoom'], 10.4, 0.5, 12.5, 0.72, 15, 1.05],
          'symbol-sort-key': ['get', 'k'],
          'text-field': ['get', 'line'], 'text-font': ['Noto Sans Bold'], 'text-size': 10.5, 'text-anchor': 'left', 'text-offset': [1.1, 0], 'text-optional': true, 'text-padding': 3
        },
        paint: {
          'icon-opacity': ['interpolate', ['linear'], ['zoom'], 10.4, 0, 11.6, ['case', ['get', 'f'], 0.7, 1]],
          'text-color': P.labelStrong, 'text-halo-color': P.halo, 'text-halo-width': 1.4,
          'text-opacity': ['interpolate', ['linear'], ['zoom'], 12.2, 0, 12.6, 1]
        } },
      { id: 'sel-ring', type: 'circle', source: 'sel',
        paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 11, 12, 17], 'circle-color': P.sel, 'circle-opacity': 0, 'circle-stroke-color': P.sel, 'circle-stroke-width': 2 } },
      { id: 'sel-dot', type: 'circle', source: 'sel', maxzoom: 11.2,
        paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 4.4, 10, 6], 'circle-color': P.sel, 'circle-stroke-color': P.selRing, 'circle-stroke-width': 2 } },
      { id: 'sel-sym', type: 'symbol', source: 'sel', minzoom: 11.2,
        layout: { 'icon-image': 'm-sel', 'icon-rotate': ['get', 'b'], 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map', 'icon-allow-overlap': true, 'icon-size': ['interpolate', ['linear'], ['zoom'], 11.2, 0.8, 15, 1.3] } }
    ];

    return {
      version: 8,
      name: 'GerLines Atlas ' + theme,
      glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
      sources: {
        omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
        dem: { type: 'raster-dem', tiles: ['https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'], tileSize: 512, maxzoom: 12, encoding: 'terrarium', attribution: 'Mapterhorn' },
        mask: { type: 'geojson', data: D.mask },
        trains: { type: 'geojson', data: D.trains },
        route: { type: 'geojson', data: D.route },
        stops: { type: 'geojson', data: D.stops },
        sel: { type: 'geojson', data: D.sel }
      },
      layers
    };
  }

  function drawMarker(color, edge) {
    const s = 48, c = document.createElement('canvas');
    c.width = c.height = s;
    const x = c.getContext('2d');
    x.beginPath();
    x.moveTo(24, 4); x.lineTo(37, 41); x.lineTo(24, 33); x.lineTo(11, 41); x.closePath();
    x.lineJoin = 'round';
    x.lineWidth = 4; x.strokeStyle = edge; x.stroke();
    x.fillStyle = color; x.fill();
    return x.getImageData(0, 0, s, s);
  }

  function addMarker(map, name, theme) {
    const P = PAL[theme];
    const key = name.slice(2);
    const color = key === 'sel' ? P.sel : P[key];
    if (!color || map.hasImage(name)) return;
    map.addImage(name, drawMarker(color, key === 'sel' ? P.selRing : P.markerEdge), { pixelRatio: 2 });
  }

  window.AtlasStyle = { PAL, GROUPS, DGROUPS, buildStyle, addMarker, colorExpr, iconExpr, visibilityFilter };
})();
