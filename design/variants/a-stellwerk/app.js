(function () {
  const params = new URLSearchParams(location.search);
  const state = {
    theme: params.get('theme') === 'light' ? 'light' : 'dark',
    view: params.get('view') || 'national',
    mode: 'category',
    off: new Set(),
    foreign: true,
    route: true,
    follow: false,
    expanded: params.get('open') === '1'
  };

  const CATS = [
    { id: 'hsr', keys: ['hsr'], label: 'ICE and high speed', varName: '--c-hsr' },
    { id: 'ld', keys: ['ld', 'night'], label: 'IC, EC, FLX and night', varName: '--c-ld' },
    { id: 'rfast', keys: ['rfast'], label: 'RE, IRE, MEX', varName: '--c-rfast' },
    { id: 'reg', keys: ['reg'], label: 'RB and regional', varName: '--c-reg' },
    { id: 'sbahn', keys: ['sbahn'], label: 'S-Bahn', varName: '--c-sbahn' }
  ];
  const DELAY_ROWS = [
    { label: 'Up to 2 min late', varName: '--d-0' },
    { label: '3 to 10 min late', varName: '--d-1' },
    { label: '11 to 30 min late', varName: '--d-2' },
    { label: 'More than 30 min late', varName: '--d-3' },
    { label: 'No realtime', varName: '--d-4' }
  ];
  const CAT_NAME = { hsr: 'High speed', ld: 'Long distance', night: 'Night train', rfast: 'Fast regional', reg: 'Regional', sbahn: 'S-Bahn' };

  const fmt = (n) => n.toLocaleString('en-US');
  const shortName = (n) => n.replace(/^S\+U /, '').replace(/, (Hauptbahnhof|Hbf)$/, ' Hbf').replace(/ Hauptbahnhof$/, ' Hbf').replace(/ Bahnhof$/, '');
  const delayBucket = (t) => (!t.rt ? 4 : t.delay <= 2 ? 0 : t.delay <= 10 ? 1 : t.delay <= 30 ? 2 : 3);
  const $ = (s, r) => (r || document).querySelector(s);
  const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const icons = () => lucide.createIcons();

  let trains, meta, ice, selected, map, routeParts, delayCounts;

  const SORT = { foreign: 0, reg: 1, rfast: 2, sbahn: 3, ld: 4, night: 4, hsr: 5 };

  function prepare(data) {
    const feats = data.filter((t) => t.id !== selected.id).map((t) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [t.lon, t.lat] },
      properties: {
        cat: t.cat, foreign: t.foreign, bearing: t.bearing || 0,
        ck: t.foreign ? 'foreign' : t.cat, dk: 'd' + delayBucket(t),
        sort: t.foreign ? 0 : SORT[t.cat]
      }
    }));
    return { type: 'FeatureCollection', features: feats };
  }

  function project(route, p) {
    const k = Math.cos((p[1] * Math.PI) / 180);
    let best = { d: Infinity, i: 0, pt: p };
    for (let i = 0; i < route.length - 1; i++) {
      const ax = route[i][0] * k, ay = route[i][1], bx = route[i + 1][0] * k, by = route[i + 1][1];
      const dx = bx - ax, dy = by - ay, px = p[0] * k, py = p[1];
      const len = dx * dx + dy * dy;
      const u = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len));
      const qx = ax + u * dx, qy = ay + u * dy;
      const d = (px - qx) ** 2 + (py - qy) ** 2;
      if (d < best.d) best = { d, i, pt: [qx / k, qy] };
    }
    return best;
  }

  function splitRoute() {
    const r = ice.route;
    const pr = project(r, [selected.lon, selected.lat]);
    return {
      travelled: r.slice(0, pr.i + 1).concat([pr.pt]),
      ahead: [pr.pt].concat(r.slice(pr.i + 1))
    };
  }

  function arrow(color, edge, size, stroke) {
    const w = 22 * size, h = 28 * size, c = document.createElement('canvas');
    const px = 2;
    c.width = w * px; c.height = h * px;
    const g = c.getContext('2d');
    g.scale(px, px);
    const pad = stroke + 1;
    g.beginPath();
    g.moveTo(w / 2, pad);
    g.lineTo(w - pad - 1, h - pad);
    g.lineTo(w / 2, h - pad - 6 * size);
    g.lineTo(pad + 1, h - pad);
    g.closePath();
    g.lineJoin = 'round';
    g.lineWidth = stroke * 2;
    g.strokeStyle = edge;
    g.stroke();
    g.fillStyle = color;
    g.fill();
    return g.getImageData(0, 0, c.width, c.height);
  }

  function addImages() {
    const t = TOKENS[state.theme];
    const edge = t.edge;
    Object.entries(t.cat).forEach(([k, c]) => map.addImage('arrow-' + k, arrow(c, edge, 1, 1.25), { pixelRatio: 2 }));
    t.delay.forEach((c, i) => map.addImage('arrow-d' + i, arrow(c, edge, 1, 1.25), { pixelRatio: 2 }));
    map.addImage('arrow-sel', arrow(t.sel, t.halo, 1.2, 2), { pixelRatio: 2 });
  }

  function colourExpr() {
    const t = TOKENS[state.theme];
    if (state.mode === 'delay') {
      return ['match', ['get', 'dk'], 'd0', t.delay[0], 'd1', t.delay[1], 'd2', t.delay[2], 'd3', t.delay[3], t.delay[4]];
    }
    return ['match', ['get', 'ck'], 'hsr', t.cat.hsr, 'ld', t.cat.ld, 'night', t.cat.night, 'rfast', t.cat.rfast, 'reg', t.cat.reg, 'sbahn', t.cat.sbahn, t.cat.foreign];
  }
  function iconExpr() {
    return ['concat', 'arrow-', ['get', state.mode === 'delay' ? 'dk' : 'ck']];
  }
  function filterExpr() {
    const enabled = CATS.filter((c) => !state.off.has(c.id)).flatMap((c) => c.keys);
    return ['all', ['in', ['get', 'cat'], ['literal', enabled]], ['any', ['!', ['get', 'foreign']], state.foreign]];
  }

  function addDataLayers() {
    const t = TOKENS[state.theme];
    addImages();
    map.addSource('trains', { type: 'geojson', data: prepare(trains) });
    map.addSource('route', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', properties: { part: 'travelled' }, geometry: { type: 'LineString', coordinates: routeParts.travelled } },
          { type: 'Feature', properties: { part: 'ahead' }, geometry: { type: 'LineString', coordinates: routeParts.ahead } }
        ]
      }
    });
    map.addSource('stops', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: ice.stops.map((s, i) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
          properties: { name: shortName(s.name), passed: s.passed, terminal: i === 0 || i === ice.stops.length - 1 }
        }))
      }
    });
    map.addSource('sel', {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'Point', coordinates: [selected.lon, selected.lat] }, properties: { bearing: selected.bearing, label: ice.line } }
    });

    map.addLayer({
      id: 'trains-dot', type: 'circle', source: 'trains', maxzoom: 11, filter: filterExpr(),
      layout: { 'circle-sort-key': ['get', 'sort'] },
      paint: {
        'circle-color': colourExpr(),
        'circle-opacity': ['case', ['get', 'foreign'], 0.7, 1],
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 1.6, 6, 2.6, 8, 3.6, 10, 5, 11, 6],
        'circle-stroke-color': t.edge, 'circle-stroke-width': 0.8, 'circle-stroke-opacity': 0.9
      }
    });
    map.addLayer({
      id: 'trains-arrow', type: 'symbol', source: 'trains', minzoom: 11, filter: filterExpr(),
      layout: {
        'icon-image': iconExpr(), 'icon-rotate': ['get', 'bearing'], 'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true, 'icon-ignore-placement': true, 'symbol-sort-key': ['get', 'sort'],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 11, 0.6, 13, 0.85, 16, 1.1]
      },
      paint: { 'icon-opacity': ['case', ['get', 'foreign'], 0.7, 1] }
    });
    map.addLayer({
      id: 'route-casing', type: 'line', source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: state.route ? 'visible' : 'none' },
      paint: { 'line-color': t.edge, 'line-opacity': 0.85, 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 3, 12, 8] }
    });
    map.addLayer({
      id: 'route-travelled', type: 'line', source: 'route', filter: ['==', ['get', 'part'], 'travelled'],
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: state.route ? 'visible' : 'none' },
      paint: { 'line-color': t.sel, 'line-opacity': 0.4, 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.5, 12, 4] }
    });
    map.addLayer({
      id: 'route-ahead', type: 'line', source: 'route', filter: ['==', ['get', 'part'], 'ahead'],
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: state.route ? 'visible' : 'none' },
      paint: { 'line-color': t.sel, 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 2, 12, 5] }
    });
    map.addLayer({
      id: 'stops-dot', type: 'circle', source: 'stops',
      layout: { visibility: state.route ? 'visible' : 'none' },
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 2.5, 10, 4.5, 14, 6],
        'circle-color': ['case', ['get', 'passed'], t.sel, t.surface],
        'circle-opacity': ['case', ['get', 'passed'], 0.5, 1],
        'circle-stroke-color': t.sel, 'circle-stroke-width': 1.75,
        'circle-stroke-opacity': ['case', ['get', 'passed'], 0.5, 1]
      }
    });
    const stopLabel = (id, filter, minzoom) => ({
      id, type: 'symbol', source: 'stops', filter, minzoom,
      layout: {
        visibility: state.route ? 'visible' : 'none',
        'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'], 'text-size': 12,
        'text-anchor': 'left', 'text-offset': [0.9, 0], 'text-max-width': 9
      },
      paint: { 'text-color': t.ink, 'text-halo-color': t.surface, 'text-halo-width': 2 }
    });
    map.addLayer(stopLabel('stops-label-terminal', ['get', 'terminal'], 0));
    map.addLayer(stopLabel('stops-label', ['!', ['get', 'terminal']], 6.6));
    map.addLayer({
      id: 'sel-dot', type: 'circle', source: 'sel', maxzoom: 11,
      paint: {
        'circle-color': t.sel, 'circle-stroke-color': t.halo, 'circle-stroke-width': 2,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 5, 8, 7, 11, 9]
      }
    });
    map.addLayer({
      id: 'sel-arrow', type: 'symbol', source: 'sel', minzoom: 11,
      layout: {
        'icon-image': 'arrow-sel', 'icon-rotate': ['get', 'bearing'], 'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true, 'icon-ignore-placement': true,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 11, 0.8, 13, 1, 16, 1.2]
      }
    });
    map.addLayer({
      id: 'sel-label', type: 'symbol', source: 'sel',
      layout: {
        'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 12,
        'text-anchor': 'left', 'text-offset': ['interpolate', ['linear'], ['zoom'], 5, ['literal', [1, 0]], 12, ['literal', [1.4, 0]]],
        'text-allow-overlap': true
      },
      paint: { 'text-color': t.ink, 'text-halo-color': t.surface, 'text-halo-width': 2 }
    });
  }

  function refreshTrainLayers() {
    if (!map.getLayer('trains-dot')) return;
    ['trains-dot', 'trains-arrow'].forEach((id) => map.setFilter(id, filterExpr()));
    map.setPaintProperty('trains-dot', 'circle-color', colourExpr());
    map.setLayoutProperty('trains-arrow', 'icon-image', iconExpr());
  }

  function markIdle() {
    document.body.dataset.ready = '0';
    map.once('idle', async () => {
      await document.fonts.ready;
      document.body.dataset.ready = '1';
    });
  }

  function camera() {
    const phone = matchMedia('(max-width: 760px)').matches;
    if (state.view === 'city') return { center: [8.6595, 50.1035], zoom: 12.5 };
    if (state.view === 'route' || phone) {
      return { bounds: [[7.3, 47.4], [13.7, 52.7]], fit: { padding: { top: 120, bottom: 430, left: 24, right: 24 } } };
    }
    return { bounds: [[5.9, 47.2], [15.1, 55.1]], fit: { padding: { top: 56, bottom: 48, left: 24, right: 24 } } };
  }

  function updateStage() {
    const z = map.getZoom();
    $('#stageText').textContent = z < 11 ? (z < 7 ? 'Germany, all trains' : 'Region, all trains') : 'City, trains show direction';
    $('#zoomText').textContent = 'Zoom ' + z.toFixed(1);
  }

  function initMap() {
    const cam = camera();
    map = new maplibregl.Map({
      container: 'map', style: buildStyle(state.theme), attributionControl: false,
      center: cam.center || [10.4, 51.2], zoom: cam.zoom || 5.5, fadeDuration: 0,
      dragRotate: false, pitchWithRotate: false, maxPitch: 0, renderWorldCopies: false
    });
    map.touchZoomRotate.disableRotation();
    if (cam.bounds) map.fitBounds(cam.bounds, { ...cam.fit, animate: false });
    map.on('zoom', updateStage);
    map.on('load', () => { addDataLayers(); updateStage(); markIdle(); });
    window.__map = map;
  }

  function setTheme(theme) {
    if (theme === state.theme) return;
    state.theme = theme;
    document.documentElement.dataset.theme = theme;
    document.querySelectorAll('#styles button[data-style]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.style === theme)));
    document.body.dataset.ready = '0';
    map.setStyle(buildStyle(theme));
    map.once('style.load', () => { addDataLayers(); applyVisibility(); markIdle(); });
  }

  function renderLegend(container, compact) {
    const counts = meta.countsByCategory;
    container.textContent = '';
    if (state.mode === 'delay') {
      DELAY_ROWS.forEach((r, i) => container.append(el(
        `<div class="row plain"><span class="swatch" style="--sw:var(${r.varName})"></span><span class="name">${r.label}</span><span class="n">${fmt(delayCounts[i])}</span></div>`
      )));
      return;
    }
    CATS.forEach((c) => {
      const n = c.keys.reduce((a, k) => a + counts[k], 0);
      const row = el(
        `<label class="row${state.off.has(c.id) ? ' off' : ''}"><input type="checkbox" ${state.off.has(c.id) ? '' : 'checked'}><span class="swatch" style="--sw:var(${c.varName})"></span><span class="name">${c.label}</span><span class="n">${fmt(n)}</span></label>`
      );
      row.querySelector('input').addEventListener('change', (e) => {
        if (e.target.checked) state.off.delete(c.id); else state.off.add(c.id);
        row.classList.toggle('off', !e.target.checked);
        refreshTrainLayers();
        syncLegends();
      });
      container.append(row);
    });
    container.append(el('<div class="row-sep"></div>'));
    const f = el(
      `<label class="row foreign${state.foreign ? ' on' : ''}"><input type="checkbox" role="switch" ${state.foreign ? 'checked' : ''}><span class="swatch" style="--sw:var(--c-foreign)"></span><span class="name">Neighbouring countries</span><span class="n">${fmt(counts.foreign)}</span></label>`
    );
    f.querySelector('input').addEventListener('change', (e) => {
      state.foreign = e.target.checked;
      refreshTrainLayers();
      syncLegends();
    });
    container.append(f);
  }

  const legends = [];
  function syncLegends() { legends.forEach((l) => renderLegend(l)); }

  function buildLive() {
    const root = $('#viewLive');
    root.append(el(`
      <div class="block">
        <label class="field"><i data-lucide="search"></i><span class="sr">Search</span><input id="q" type="search" placeholder="Train, line or station" autocomplete="off"></label>
        <p class="counts"><b>${fmt(meta.trainsTotal)}</b> trains, <b>${fmt(meta.trainsRealtime)}</b> with realtime. Data from ${meta.capturedLocal}.</p>
      </div>`));
    const mode = el(`
      <div class="block">
        <div class="colour-head"><span class="label">Colour by</span></div>
        <div class="seg" role="radiogroup" aria-label="Colour by">
          <button type="button" role="radio" aria-checked="true" data-mode="category">Category</button>
          <button type="button" role="radio" aria-checked="false" data-mode="delay">Delay</button>
          <button type="button" role="radio" aria-disabled="true" aria-checked="false" title="Operator is not in the snapshot data">Operator</button>
        </div>
        <div class="legend" id="legendLive"></div>
      </div>`);
    root.append(mode);
    mode.querySelectorAll('button[data-mode]').forEach((b) => b.addEventListener('click', () => {
      state.mode = b.dataset.mode;
      mode.querySelectorAll('button[data-mode]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      refreshTrainLayers();
      syncLegends();
    }));
    legends.push($('#legendLive'));
    $('#tabSearch').addEventListener('click', () => $('#q').focus());
    $('#topSearch').addEventListener('click', () => {
      showCard(false);
      $('#panel').classList.add('open');
      $('#sheetHandle').setAttribute('aria-expanded', 'true');
      $('#q').focus();
    });
  }

  function stopsTable() {
    const rows = [];
    ice.stops.forEach((s, i) => {
      const first = i === 0, last = i === ice.stops.length - 1;
      const act = first ? s.dep : s.arr, plan = first ? s.depSched : s.arrSched;
      const plat = s.trackSched && s.trackSched !== s.track ? `<s>${s.trackSched}</s>${s.track}` : (s.track || '');
      const cls = s.passed ? 'passed' : 'ahead';
      if (i === ice.nextStopIndex) {
        rows.push(`<tr class="now"><td class="trk"><i class="ln up"></i><i class="ln dn"></i><i class="nd"></i></td><td colspan="5">Now, about one minute before arrival</td></tr>`);
      }
      rows.push(`<tr class="${cls}"><td class="trk"><i class="ln up"></i><i class="ln dn"></i><i class="nd"></i></td><td title="${s.name}">${shortName(s.name)}</td><td class="sched">${plan || ''}</td><td class="act">${act || ''}</td><td>${plat}</td><td class="${s.delay >= 30 ? 'late' : ''}">+${s.delay} min</td></tr>`);
    });
    return `<table class="stops"><caption class="sr">Stops of ${ice.line}, scheduled and predicted times, platform and delay</caption>
      <colgroup><col style="width:14px"><col><col style="width:40px"><col style="width:42px"><col style="width:46px"><col style="width:50px"></colgroup>
      <thead><tr><th></th><th>Stop</th><th>Plan</th><th>Actual</th><th>Platform</th><th>Delay</th></tr></thead>
      <tbody>${rows.join('')}</tbody></table>`;
  }

  function buildCard() {
    const root = $('#viewCard');
    const next = ice.stops[ice.nextStopIndex];
    const v = ice.vehicle, p = ice.photo;
    const platChanged = v.platformAtFrankfurt.scheduled !== v.platformAtFrankfurt.actual;
    root.innerHTML = `
      <div class="card-top"><button type="button" class="back" id="back"><i data-lucide="chevron-left"></i>Back to all trains</button></div>
      <div class="ident">
        <div class="t"><h2>${ice.line}</h2><span class="badge"><span class="swatch" style="--sw:var(--c-hsr)"></span>${CAT_NAME[ice.category]}</span></div>
        <p class="dest">${shortName(ice.origin)} to ${shortName(ice.destination)}</p>
        <p class="op">${ice.operator}</p>
      </div>
      <div class="facts">
        <div class="fact"><span class="label">Delay</span><div><div class="delay"><strong>+${ice.currentDelay} min</strong><span class="rt"><i data-lucide="radio"></i>Realtime</span></div></div></div>
        <div class="fact"><span class="label">Next stop</span><div>
          <p class="next-name">${shortName(next.name)}</p>
          <p class="next-t"><strong>${next.arr}</strong><span class="was">${next.arrSched}</span><span class="plat">${platChanged ? `Platform <b>${v.platformAtFrankfurt.actual}</b>, was ${v.platformAtFrankfurt.scheduled}` : `Platform <b>${next.track}</b>`}</span></p>
        </div></div>
      </div>
      <div class="actions">
        <button type="button" class="btn primary" id="follow" aria-pressed="false"><i data-lucide="locate-fixed"></i>Follow</button>
        <button type="button" class="btn" id="routeBtn" aria-pressed="false"><i data-lucide="route"></i>Route</button>
        <button type="button" class="btn" id="share"><i data-lucide="share-2"></i>Share</button>
      </div>
      <div class="card-more">
        <div class="dl">
          <div class="dl-head"><span class="label">Vehicle</span><span class="conf"><i data-lucide="badge-check"></i>${v.label}</span></div>
          <p class="big">${v.name}, ${v.series}, ${v.set}</p>
          <p class="small">${v.cars} cars, ${v.lengthM} m, up to ${v.maxSpeedKmh} km/h</p>
        </div>
        <p class="prov"><i data-lucide="info"></i><span>Position estimated between reports. Data from ${ice.captureLocal.slice(11)}.</span></p>
        <button type="button" class="more-btn" id="moreBtn" aria-expanded="false" aria-controls="details"><span id="moreLabel">Show stops and photo</span><i data-lucide="chevron-down"></i></button>
        <div class="details" id="details" hidden>
          <h3>Stops</h3>
          ${stopsTable()}
          <figure class="photo">
            <img src="data/${p.file}" width="330" alt="${p.title}">
            <figcaption><a href="${p.source}">${p.title}</a> by <a href="${p.authorUrl}">${p.author}</a>, <a href="${p.licenceUrl}">${p.licence}</a>, via Wikimedia Commons.</figcaption>
          </figure>
          <dl class="spec">
            <dt>Series</dt><dd>${v.series}, ${v.name}</dd>
            <dt>Set</dt><dd>${v.set}, ${v.cars} cars, ${v.lengthM} m</dd>
            <dt>Confidence</dt><dd>${v.layer}, ${v.label}</dd>
            <dt>Source</dt><dd>${v.source}</dd>
          </dl>
        </div>
      </div>
      <div class="block card-legend" style="margin-top:16px;border-top:1px solid var(--hair)">
        <div class="colour-head"><span class="label">Colour by ${state.mode === 'delay' ? 'delay' : 'category'}</span></div>
        <div class="legend" id="legendCard" style="margin-top:0"></div>
      </div>`;
    legends.push($('#legendCard'));
    $('#back').addEventListener('click', () => showCard(false));
    const more = $('#moreBtn');
    const setExpanded = (on) => {
      state.expanded = on;
      more.setAttribute('aria-expanded', String(on));
      $('#moreLabel').textContent = on ? 'Hide stops and photo' : 'Show stops and photo';
      $('#details').hidden = !on;
    };
    more.addEventListener('click', () => setExpanded(!state.expanded));
    setExpanded(state.expanded);
    const routeBtn = $('#routeBtn');
    routeBtn.setAttribute('aria-pressed', String(state.route));
    routeBtn.addEventListener('click', () => {
      state.route = !state.route;
      routeBtn.setAttribute('aria-pressed', String(state.route));
      applyVisibility();
    });
    const follow = $('#follow');
    follow.addEventListener('click', () => {
      state.follow = !state.follow;
      follow.setAttribute('aria-pressed', String(state.follow));
      follow.lastChild.textContent = state.follow ? 'Following' : 'Follow';
    });
  }

  function showCard(on) {
    $('#viewCard').hidden = !on;
    $('#viewLive').hidden = on;
    $('#panel').classList.toggle('has-train', on);
    $('#panelBody').scrollTop = 0;
    state.selected = on;
    applyVisibility();
    syncLegends();
    measurePeek();
  }

  function applyVisibility() {
    ['sel-dot', 'sel-arrow', 'sel-label', 'route-casing', 'route-travelled', 'route-ahead', 'stops-dot', 'stops-label', 'stops-label-terminal'].forEach((id) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', state.selected && (state.route || id.startsWith('sel')) ? 'visible' : 'none');
    });
  }

  function measurePeek() {
    const panel = $('#panel');
    if (!matchMedia('(max-width: 760px)').matches) return;
    requestAnimationFrame(() => document.documentElement.style.setProperty('--peek', panel.offsetHeight + 'px'));
  }

  function wireChrome() {
    $('#zoomIn').addEventListener('click', () => map.zoomIn());
    $('#zoomOut').addEventListener('click', () => map.zoomOut());
    document.querySelectorAll('#styles button[data-style]').forEach((b) => b.addEventListener('click', () => setTheme(b.dataset.style)));
    const lb = $('#layersBtn');
    lb.addEventListener('click', () => {
      const open = $('#styles').classList.toggle('open');
      lb.setAttribute('aria-expanded', String(open));
    });
    const handle = $('#sheetHandle');
    handle.addEventListener('click', () => {
      const open = $('#panel').classList.toggle('open');
      handle.setAttribute('aria-expanded', String(open));
      handle.setAttribute('aria-label', open ? 'Show fewer details' : 'Show more details');
      if (!open) measurePeek();
    });
    const at = $('#attrib');
    const syncAttrib = () => { at.open = !matchMedia('(max-width: 760px)').matches; };
    syncAttrib();
    matchMedia('(max-width: 760px)').addEventListener('change', () => { syncAttrib(); measurePeek(); });
    new ResizeObserver(measurePeek).observe($('#panel'));
  }

  async function boot() {
    document.documentElement.dataset.theme = state.theme;
    document.querySelectorAll('#styles button[data-style]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.style === state.theme)));
    const base = 'data/';
    [trains, meta, ice] = await Promise.all(['trains.json', 'meta.json', 'ice379.json'].map((f) => fetch(base + f).then((r) => r.json())));
    selected = trains.find((t) => t.line === ice.line && t.from === ice.segment.from);
    routeParts = splitRoute();
    delayCounts = [0, 0, 0, 0, 0];
    trains.forEach((t) => { delayCounts[delayBucket(t)] += 1; });
    buildLive();
    buildCard();
    wireChrome();
    icons();
    initMap();
    map.once('load', () => showCard(params.get('card') !== '0'));
  }

  boot();
})();
