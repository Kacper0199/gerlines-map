(async function () {
  const params = new URLSearchParams(location.search);
  const isPhone = () => matchMedia('(max-width: 640px)').matches;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let theme = params.get('theme') === 'light' ? 'light' : 'dark';
  document.body.dataset.theme = theme;

  const PAL = {
    dark: { hsr: '#EDE6D6', ld: '#B9AF98', night: '#EDE6D6', rfast: '#9CC5F6', reg: '#5F97DE', sbahn: '#5FC08A', foreign: '#8F87A8',
            sel: '#FFB000', ring: '#17181A', travelled: '#F1EFEA', land: '#1A1B1D', label: '#A7A39B', halo: '#1A1B1D', stopFill: '#1A1B1D',
            d0: '#7CC9B4', d1: '#E8D7A0', d2: '#E58F8F', d3: '#B5527C', dn: '#8F87A8' },
    light: { hsr: '#26231E', ld: '#6A604C', night: '#26231E', rfast: '#3F83D6', reg: '#1F5EB0', sbahn: '#17814C', foreign: '#6F6790',
             sel: '#F08C00', ring: '#1B1A18', travelled: '#1B1A18', land: '#EDEBE5', label: '#47433D', halo: '#EDEBE5', stopFill: '#EDEBE5',
             d0: '#1F8E78', d1: '#B08A12', d2: '#C2503F', d3: '#7A2A5C', dn: '#6F6790' },
  };
  const CAT_ORDER = ['hsr', 'ld', 'night', 'rfast', 'reg', 'sbahn'];
  const CAT_LABEL = { hsr: 'ICE and high speed', ld: 'IC, EC, FLX', night: 'Night trains', rfast: 'RE, IRE, MEX', reg: 'RB', sbahn: 'S-Bahn', foreign: 'Foreign trains' };
  const CAT_BADGE = { hsr: 'High speed', ld: 'Long distance', night: 'Night train', rfast: 'Fast regional', reg: 'Regional', sbahn: 'S-Bahn' };

  const get = (u) => fetch(u).then((r) => r.json());
  const [trainsRaw, meta, ice, baseDark, baseLight] = await Promise.all([
    get('data/trains.json'), get('data/meta.json'), get('data/ice379.json'),
    get('b-fahrplan/style-dark.json'), get('b-fahrplan/style-light.json'),
  ]);
  const BASE = { dark: baseDark, light: baseLight };

  const keyOf = (t) => (t.foreign ? 'foreign' : t.cat);
  const SEL_ID = (trainsRaw.find((t) => t.line === ice.line && t.delay === ice.currentDelay) || {}).id;
  const selTrain = trainsRaw.find((t) => t.id === SEL_ID);
  const bucketOf = (t) => (t.foreign ? 'foreign' : !t.rt ? 'dn' : t.delay <= 5 ? 'd0' : t.delay <= 15 ? 'd1' : t.delay < 60 ? 'd2' : 'd3');
  const trainsFC = {
    type: 'FeatureCollection',
    features: trainsRaw.map((t) => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [t.lon, t.lat] },
      properties: { id: t.id, line: t.line, key: keyOf(t), foreign: t.foreign, rt: t.rt, delay: t.delay, bearing: t.bearing, bkt: bucketOf(t) },
    })),
  };

  const shortName = (n) => n.replace(/^S\+U /, '').replace(/,? ?Hauptbahnhof/, ' Hbf').replace(/, Hbf/, ' Hbf').replace(/^Fulda Bahnhof$/, 'Fulda').replace(/^Offenburg Bahnhof$/, 'Offenburg');
  const stops = ice.stops.map((s) => ({ ...s, short: shortName(s.name) }));
  const route = ice.route;

  // geometry helpers
  const kx = Math.cos((50 * Math.PI) / 180);
  const d2 = (a, b) => ((a[0] - b[0]) * kx) ** 2 + (a[1] - b[1]) ** 2;
  const nearest = (pt) => { let bi = 0, bd = Infinity; route.forEach((p, i) => { const d = d2(p, pt); if (d < bd) { bd = d; bi = i; } }); return bi; };
  const cum = [0]; for (let i = 1; i < route.length; i++) cum.push(cum[i - 1] + Math.sqrt(d2(route[i], route[i - 1])));
  const iT = nearest([selTrain.lon, selTrain.lat]);
  const prevStop = stops[ice.nextStopIndex - 1];
  const nextStop = stops[ice.nextStopIndex];
  const iP = nearest([prevStop.lon, prevStop.lat]);
  const iN = nearest([nextStop.lon, nextStop.lat]);
  const progress = Math.min(0.7, Math.max(0.25, (cum[iT] - cum[iP]) / (cum[iN] - cum[iP])));
  const travelled = route.slice(0, iT + 1);
  const aheadFull = route.slice(iT);

  // state
  const state = { mode: 'category', cats: new Set([...CAT_ORDER, 'foreign']), aheadN: aheadFull.length, cardState: params.get('card') === 'expanded' ? 'expanded' : 'collapsed' };
  if (params.get('card') == null && params.get('view') === 'city') state.cardState = 'expanded';

  const lineFC = (c) => ({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: c.length > 1 ? c : [c[0], c[0]] } }] });
  const stopsFC = {
    type: 'FeatureCollection',
    features: stops.map((s, i) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      properties: { name: s.short, passed: i < ice.nextStopIndex, next: i === ice.nextStopIndex, key: i === 0 || i === stops.length - 1 || i === ice.nextStopIndex } })),
  };
  const selFC = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [selTrain.lon, selTrain.lat] }, properties: { bearing: selTrain.bearing } }] };

  const colorExpr = (p) => {
    if (state.mode === 'delay') {
      return ['case', ['get', 'foreign'], p.dn, ['!', ['get', 'rt']], p.dn,
        ['<=', ['get', 'delay'], 5], p.d0, ['<=', ['get', 'delay'], 15], p.d1, ['<', ['get', 'delay'], 60], p.d2, p.d3];
    }
    return ['match', ['get', 'key'], 'hsr', p.hsr, 'ld', p.ld, 'night', p.night, 'rfast', p.rfast, 'reg', p.reg, 'sbahn', p.sbahn, p.foreign];
  };
  const visFilter = () => ['all', ['!=', ['get', 'id'], SEL_ID], ['in', ['get', 'key'], ['literal', [...state.cats]]]];
  const sortKey = ['match', ['get', 'key'], 'foreign', 0, 'reg', 1, 'rfast', 2, 'sbahn', 3, 'ld', 4, 'night', 4, 'hsr', 5, 0];
  const opacityExpr = ['case', ['get', 'foreign'], 0.7, 1];

  function buildStyle(th) {
    const p = PAL[th];
    const s = JSON.parse(JSON.stringify(BASE[th]));
    s.sources.trains = { type: 'geojson', data: trainsFC };
    s.sources.sel = { type: 'geojson', data: selFC };
    s.sources.stops = { type: 'geojson', data: stopsFC };
    s.sources.rpast = { type: 'geojson', data: lineFC(travelled) };
    s.sources.rahead = { type: 'geojson', data: lineFC(aheadFull.slice(0, state.aheadN)) };
    const isNight = ['==', ['get', 'key'], 'night'];
    const fontReg = ['literal', ['Noto Sans Regular']], fontBold = ['literal', ['Noto Sans Bold']];
    s.layers.push(
      { id: 'route-past', type: 'line', source: 'rpast', layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': p.travelled, 'line-opacity': 0.45, 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 2.5, 12, 4] } },
      { id: 'route-ahead-casing', type: 'line', source: 'rahead', layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': p.ring, 'line-opacity': 0.85, 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 5, 12, 8] } },
      { id: 'route-ahead', type: 'line', source: 'rahead', layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': p.sel, 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 3, 12, 5] } },
      { id: 'stops-dots', type: 'circle', source: 'stops',
        paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3, 12, 5], 'circle-color': p.stopFill,
                 'circle-stroke-width': 2, 'circle-stroke-color': ['case', ['get', 'passed'], p.travelled, p.sel] } },
      { id: 'trains-dots', type: 'circle', source: 'trains', maxzoom: 11, filter: visFilter(),
        layout: { 'circle-sort-key': sortKey },
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, ['match', ['get', 'key'], 'hsr', 3.2, 'foreign', 2, 2.5], 8, ['match', ['get', 'key'], 'hsr', 4.4, 'foreign', 3, 3.6], 11, ['match', ['get', 'key'], 'hsr', 6, 'foreign', 4.4, 5]],
          'circle-color': ['case', isNight, p.land, colorExpr(p)],
          'circle-stroke-width': ['case', isNight, 2, 0.8],
          'circle-stroke-color': ['case', isNight, colorExpr(p), p.land],
          'circle-opacity': ['interpolate', ['linear'], ['zoom'], 10, 1, 11, 0],
          'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 10, 1, 11, 0],
        } },
      { id: 'trains-arrows', type: 'symbol', source: 'trains', minzoom: 9.5, filter: visFilter(),
        layout: {
          'symbol-sort-key': sortKey,
          'icon-image': ['concat', 'tr-' + th + '-', ['get', state.mode === 'delay' ? 'bkt' : 'key']],
          'icon-rotate': ['get', 'bearing'], 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map',
          'icon-allow-overlap': true, 'icon-ignore-placement': true,
          'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.55, 13, 0.95, 16, 1.25],
        },
        paint: { 'icon-opacity': ['interpolate', ['linear'], ['zoom'], 9.5, 0, 10.5, ['case', ['get', 'foreign'], 0.7, 1]] } },
      { id: 'sel-ring', type: 'circle', source: 'sel',
        paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 9, 13, 17], 'circle-color': p.ring, 'circle-opacity': 0.0,
                 'circle-stroke-width': 2.5, 'circle-stroke-color': th === 'light' ? p.ring : p.sel } },
      { id: 'sel-dot', type: 'circle', source: 'sel', maxzoom: 11,
        paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 4.5, 11, 7], 'circle-color': p.sel, 'circle-stroke-width': 1.5, 'circle-stroke-color': p.ring,
                 'circle-opacity': ['interpolate', ['linear'], ['zoom'], 10, 1, 11, 0], 'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 10, 1, 11, 0] } },
      { id: 'sel-arrow', type: 'symbol', source: 'sel', minzoom: 9.5,
        layout: { 'icon-image': 'tr-' + th + '-sel', 'icon-rotate': ['get', 'bearing'], 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map',
                  'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 13, 1.3, 16, 1.7] },
        paint: { 'icon-opacity': ['interpolate', ['linear'], ['zoom'], 9.5, 0, 10.5, 1] } },
      { id: 'stops-key-labels', type: 'symbol', source: 'stops', filter: ['get', 'key'],
        layout: { 'text-field': ['get', 'name'], 'text-font': ['case', ['get', 'next'], fontBold, fontReg], 'text-size': 12.5, 'text-anchor': 'left', 'text-offset': [1.5, 0], 'text-allow-overlap': true },
        paint: { 'text-color': p.label === '#A7A39B' ? '#F1EFEA' : '#1B1A18', 'text-halo-color': p.halo, 'text-halo-width': 1.8 } },
      { id: 'stops-labels', type: 'symbol', source: 'stops', minzoom: 7.5, filter: ['!', ['get', 'key']],
        layout: { 'text-field': ['get', 'name'], 'text-font': fontReg, 'text-size': 12, 'text-anchor': 'left', 'text-offset': [0.9, 0] },
        paint: { 'text-color': p.label, 'text-halo-color': p.halo, 'text-halo-width': 1.8 } },
    );
    return s;
  }

  function drawArrow(color, opts) {
    const w = 22, h = 28, r = 2;
    const c = document.createElement('canvas'); c.width = w * r; c.height = h * r;
    const g = c.getContext('2d'); g.scale(r, r);
    g.beginPath(); g.moveTo(11, 1.5); g.lineTo(19.5, 25); g.lineTo(11, 19.5); g.lineTo(2.5, 25); g.closePath();
    g.lineJoin = 'round';
    if (opts.ring) { g.lineWidth = 4; g.strokeStyle = opts.ring; g.stroke(); }
    if (opts.hollow) {
      g.fillStyle = opts.hollow; g.fill(); g.lineWidth = 2.4; g.strokeStyle = color; g.stroke();
    } else {
      g.fillStyle = color; g.fill(); g.lineWidth = 1.4; g.strokeStyle = opts.edge; g.stroke();
    }
    return { image: g.getImageData(0, 0, c.width, c.height), pixelRatio: r };
  }

  const map = new maplibregl.Map({
    container: 'map', style: buildStyle(theme), attributionControl: false, dragRotate: false, pitchWithRotate: false, touchPitch: false,
    center: [10.4, 51.2], zoom: 5, minZoom: 3, maxZoom: 17, fadeDuration: 0, canvasContextAttributes: { antialias: true },
  });
  map.touchZoomRotate.disableRotation();

  map.on('styleimagemissing', (e) => {
    const m = /^tr-(dark|light)-(\w+)$/.exec(e.id);
    if (!m || map.hasImage(e.id)) return;
    const p = PAL[m[1]], key = m[2];
    let img;
    if (key === 'sel') img = drawArrow(p.sel, { ring: p.ring, edge: p.ring });
    else if (key === 'night' && state.mode !== 'delay') img = drawArrow(p[key], { hollow: p.land, edge: p.land });
    else img = drawArrow(key === 'dn' ? p.dn : p[key] || p.foreign, { edge: p.land });
    map.addImage(e.id, img.image, { pixelRatio: img.pixelRatio });
  });

  const padding = () => (isPhone()
    ? { top: 210, bottom: 350, left: 16, right: 16 }
    : { top: 24, bottom: 72, left: 412, right: 248 });

  function setView() {
    const view = params.get('view');
    if (view === 'city') {
      map.jumpTo({ center: [8.662206, 50.105976], zoom: 12.5, padding: padding() });
    } else if (isPhone()) {
      map.fitBounds([[7.45, 47.45], [9.1, 50.25]], { padding: padding(), duration: 0 });
    } else {
      map.fitBounds([[5.7, 47.2], [15.2, 55.1]], { padding: padding(), duration: 0 });
    }
  }

  function renderStage() {
    const z = map.getZoom();
    document.getElementById('stage').textContent = z < 8 ? 'Germany, all trains' : z < 11 ? 'Region, all trains' : 'City, trains with heading';
  }

  // UI rendering
  const pun = (s) => String(s).replace(/[:,]/g, (c) => `<span class="p">${c}</span>`);
  const num = (s) => `<span class="num">${pun(s)}</span>`;
  const platText = (s) => {
    if (!s.track) return '';
    if (s.trackSched && s.trackSched !== s.track) return { text: `Platform ${num(s.track)}, was ${num(s.trackSched)}`, changed: true };
    return { text: `Platform ${num(s.track)}`, changed: false };
  };
  function stopRow(s, i) {
    const passed = i < ice.nextStopIndex, next = i === ice.nextStopIndex, prev = i === ice.nextStopIndex - 1;
    const pred = s.arr || s.dep, sched = s.arrSched || s.depSched;
    const showSched = sched && sched !== pred;
    const pl = !passed ? platText(s) : '';
    const cls = ['stop', passed ? 'passed' : next ? 'next' : 'ahead', prev ? 'prev' : '', (!prev && !next) ? 'far' : ''].filter(Boolean).join(' ');
    const label = next ? '<span class="next-label">Next stop</span>' : '';
    return `<li class="${cls}"><span class="node"></span>
      <div><span class="s-name">${label.replace('<span class="next-label">', '<span class="next-label">')}${s.short}</span>${pl ? `<span class="s-plat${pl.changed ? ' changed' : ''}">${pl.text}</span>` : ''}</div>
      <div class="s-time"><span class="t-pred num">${pun(pred)}</span>${showSched && !passed ? `<s class="t-sched num">${pun(sched)}</s>` : ''}</div>
      <span class="s-delay num">+${s.delay}</span></li>`;
  }
  function renderCard() {
    const key = keyOf(selTrain);
    const p = PAL[theme];
    const rows = [];
    stops.forEach((s, i) => {
      if (i === ice.nextStopIndex) {
        rows.push(`<li class="stop between"><span class="passed-seg"></span><span class="ahead-seg"></span><span class="dot pre"></span>
          <span class="now pre"><span>Now</span><small>about one minute before arrival</small></span></li>`);
      }
      rows.push(stopRow(s, i));
    });
    const ph = ice.photo, v = ice.vehicle;
    document.getElementById('card').dataset.state = state.cardState;
    document.getElementById('card').innerHTML = `
      <button type="button" class="grab" aria-label="Show or hide details"></button>
      <div class="tc-scroll">
        <header class="tc-head">
          <span class="badge" style="--cat:${p[key]}"><i></i>${CAT_BADGE[key]}</span>
          <span></span>
          <h2 class="tc-title">${ice.line}</h2>
          <div class="tc-delay"><span class="delay-val"><span class="num">+${ice.currentDelay}</span><span class="unit"> min</span></span>
            <span class="rt${ice.realtime ? '' : ' off'}"><i></i>${ice.realtime ? 'Realtime' : 'Timetable only'}</span></div>
          <p class="tc-dest">${shortName(ice.origin)} to ${ice.destination}</p>
          <p class="tc-op">${ice.operator}</p>
          <button type="button" class="close" aria-label="Close train card"><i data-lucide="x"></i></button>
        </header>
        <ol class="stops" id="stops">${rows.join('')}</ol>
        <button type="button" class="more" id="more" aria-expanded="${state.cardState === 'expanded'}"><i data-lucide="chevron-down"></i><span></span></button>
        <section class="vehicle">
          <h3>Vehicle</h3>
          <img class="v-img" src="data/${ph.file}" width="330" height="186" alt="ICE 4 train at Basel SBB, photo of another set of the same type">
          <div class="v-text">
            <p class="v-name">${v.name}, ${v.series}</p>
            <p class="v-facts">Set ${v.set.split(' ')[0]} ${num(v.set.split(' ')[1])}, ${num(v.cars)} cars, ${num(v.lengthM)} m</p>
            <p class="v-conf"><i data-lucide="badge-check"></i><span>${v.label}<small>Source ${v.source.replace(/, \d{4}-\d\d-\d\d$/, '')}</small></span></p>
          </div>
          <p class="v-credit"><a href="${ph.source}" target="_blank" rel="noopener">${ph.title}</a> by <a href="${ph.authorUrl}" target="_blank" rel="noopener">${ph.author}</a>,
            <a href="${ph.licenceUrl}" target="_blank" rel="noopener">${ph.licence}</a>, via Wikimedia Commons. Another ICE 4 set, not this one.</p>
        </section>
        <p class="prov">Position is estimated between reports. Data from ${num(meta.capturedLocal.split(', ')[1])}, ${meta.capturedLocal.split(', ')[0].replace(/^(\w+) (\d+ \w+) (\d+)$/, '$1 $2')}.</p>
      </div>
      <footer class="tc-actions">
        <button type="button" class="btn primary" id="follow" aria-pressed="false"><i data-lucide="locate-fixed"></i>Follow</button>
        <button type="button" class="btn" id="routebtn"><i data-lucide="route"></i>Route</button>
        <button type="button" class="btn"><i data-lucide="share-2"></i>Share</button>
      </footer>`;
    const st = document.getElementById('stops');
    st.style.setProperty('--p', (progress * 100).toFixed(1) + '%');
    const bt = st.querySelector('.between'); bt.style.setProperty('--p', (progress * 100).toFixed(1) + '%');
    bindCard();
    lucide.createIcons();
    updateMore();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      bt.querySelector('.dot').classList.remove('pre'); bt.querySelector('.now').classList.remove('pre');
    }));
  }
  function updateMore() {
    const card = document.getElementById('card');
    const more = document.getElementById('more');
    const exp = card.dataset.state === 'expanded';
    more.querySelector('span').textContent = exp ? 'Fewer stops' : `All ${stops.length} stops`;
    more.querySelector('svg')?.style.setProperty('rotate', exp ? '180deg' : '0deg');
    more.setAttribute('aria-expanded', String(exp));
    document.body.classList.toggle('expanded-sheet', exp);
  }
  function toggleCard() {
    const card = document.getElementById('card');
    state.cardState = card.dataset.state === 'expanded' ? 'collapsed' : 'expanded';
    card.dataset.state = state.cardState;
    updateMore();
  }
  function bindCard() {
    document.getElementById('more').addEventListener('click', toggleCard);
    document.querySelector('.grab').addEventListener('click', toggleCard);
    document.querySelector('.close').addEventListener('click', () => { document.getElementById('card').hidden = true; });
    const f = document.getElementById('follow');
    f.addEventListener('click', () => {
      const on = f.getAttribute('aria-pressed') !== 'true';
      f.setAttribute('aria-pressed', String(on));
      if (on) map.easeTo({ center: [selTrain.lon, selTrain.lat], zoom: Math.max(map.getZoom(), 12), padding: padding(), duration: 800 });
    });
    document.getElementById('routebtn').addEventListener('click', () => {
      map.fitBounds([[7.45, 47.45], [9.1, 50.25]], { padding: padding(), duration: 800 });
    });
  }

  // right column
  function renderCats() {
    const p = PAL[theme];
    const el = document.getElementById('cats');
    const counts = meta.countsByCategory;
    let html = `<div class="cats-head"><h2>Trains</h2><span>${num(meta.trainsTotal.toLocaleString('en-US'))} total, ${num(meta.trainsRealtime.toLocaleString('en-US'))} realtime</span></div>`;
    if (state.mode === 'category') {
      CAT_ORDER.forEach((k) => {
        html += `<button type="button" class="cat" data-k="${k}" aria-pressed="${state.cats.has(k)}"><span class="sw${k === 'night' ? ' ring' : ''}" style="--c:${p[k]}"></span><span>${CAT_LABEL[k]}</span><span class="n num">${pun(counts[k].toLocaleString('en-US'))}</span></button>`;
      });
      html += `<hr><button type="button" class="cat" data-k="foreign" aria-pressed="${state.cats.has('foreign')}"><span class="sw" style="--c:${p.foreign};opacity:.7"></span><span>${CAT_LABEL.foreign}</span><span class="n num">${pun(counts.foreign.toLocaleString('en-US'))}</span></button>`;
    } else {
      const nf = trainsRaw.filter((t) => !t.foreign);
      const b = [
        ['Up to 5 min', p.d0, nf.filter((t) => t.rt && t.delay <= 5).length],
        ['6 to 15 min', p.d1, nf.filter((t) => t.rt && t.delay > 5 && t.delay <= 15).length],
        ['16 to 59 min', p.d2, nf.filter((t) => t.rt && t.delay > 15 && t.delay < 60).length],
        ['60 min or more', p.d3, nf.filter((t) => t.rt && t.delay >= 60).length],
        ['No realtime', p.dn, nf.filter((t) => !t.rt).length],
      ];
      b.forEach(([l, c, n]) => { html += `<div class="cat" style="cursor:default"><span class="sw" style="--c:${c}"></span><span>${l}</span><span class="n num">${pun(n.toLocaleString('en-US'))}</span></div>`; });
      html += `<hr><button type="button" class="cat" data-k="foreign" aria-pressed="${state.cats.has('foreign')}"><span class="sw" style="--c:${p.foreign};opacity:.7"></span><span>${CAT_LABEL.foreign}</span><span class="n num">${pun(counts.foreign.toLocaleString('en-US'))}</span></button>`;
    }
    el.innerHTML = html;
    el.querySelectorAll('.cat[data-k]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.k;
      state.cats.has(k) ? state.cats.delete(k) : state.cats.add(k);
      b.setAttribute('aria-pressed', String(state.cats.has(k)));
      const f = visFilter();
      map.setFilter('trains-dots', f); map.setFilter('trains-arrows', f);
    }));
  }

  const THUMB = {
    dark: `<svg viewBox="0 0 104 64" aria-hidden="true"><rect width="104" height="64" fill="#1A1B1D"/><path d="M0 40 C20 34 30 48 52 44 S90 36 104 42 V64 H0Z" fill="#121315"/><path d="M-4 14 L40 22 L70 10 L108 20" stroke="#323336" stroke-width="3" fill="none"/><path d="M22 -4 L34 30 L60 68" stroke="#2C2D2F" stroke-width="2" fill="none"/><path d="M0 28 L104 52" stroke="#3A3B3F" stroke-width="1"/><circle cx="30" cy="16" r="3" fill="#EDE6D6"/><circle cx="58" cy="19" r="2.4" fill="#5F97DE"/><circle cx="78" cy="30" r="2.4" fill="#5FC08A"/></svg>`,
    light: `<svg viewBox="0 0 104 64" aria-hidden="true"><rect width="104" height="64" fill="#EDEBE5"/><path d="M0 40 C20 34 30 48 52 44 S90 36 104 42 V64 H0Z" fill="#C7CFD3"/><path d="M-4 14 L40 22 L70 10 L108 20" stroke="#C9C4B8" stroke-width="3" fill="none"/><path d="M22 -4 L34 30 L60 68" stroke="#D6D2C8" stroke-width="2" fill="none"/><path d="M0 28 L104 52" stroke="#B2AEA5" stroke-width="1"/><circle cx="30" cy="16" r="3" fill="#26231E"/><circle cx="58" cy="19" r="2.4" fill="#1F5EB0"/><circle cx="78" cy="30" r="2.4" fill="#17814C"/></svg>`,
    sat: `<svg viewBox="0 0 104 64" aria-hidden="true"><rect width="104" height="64" fill="#3B4A33"/><path d="M0 0 H46 L38 30 L0 38Z" fill="#4A5A3C"/><path d="M60 0 H104 V34 L70 28Z" fill="#5A6140"/><path d="M0 44 C20 38 30 52 52 48 S90 40 104 46 V64 H0Z" fill="#26343A"/><path d="M40 64 L70 30 L104 40 V64Z" fill="#46503A"/></svg>`,
    terr: `<svg viewBox="0 0 104 64" aria-hidden="true"><rect width="104" height="64" fill="#2A2B2D"/><g fill="none" stroke="#4A4B4F" stroke-width="1"><path d="M0 50 C30 40 50 56 104 38"/><path d="M0 40 C30 30 52 46 104 28"/><path d="M0 30 C30 20 54 36 104 18"/><path d="M0 20 C30 10 56 26 104 8"/></g><path d="M20 64 L48 22 L78 64Z" fill="#3A3B3F" opacity=".7"/></svg>`,
  };
  function renderThumbs() {
    const t = document.getElementById('thumbs');
    t.innerHTML = [
      ['dark', 'Dark', THUMB.dark, false], ['light', 'Light', THUMB.light, false], ['sat', 'Satellite', THUMB.sat, true], ['terr', 'Terrain', THUMB.terr, true],
    ].map(([k, l, svg, off]) => `<button type="button" class="thumb" data-t="${k}" aria-pressed="${k === theme}" ${off ? 'aria-disabled="true" title="Not in this mockup"' : ''}>${svg}<span>${l}</span></button>`).join('');
    t.querySelectorAll('.thumb:not([aria-disabled])').forEach((b) => b.addEventListener('click', () => setTheme(b.dataset.t)));
  }
  function setTheme(th) {
    if (th === theme) return;
    theme = th; document.body.dataset.theme = th;
    delete document.body.dataset.ready;
    map.setStyle(buildStyle(th), { diff: false });
    map.once('idle', () => { document.body.dataset.ready = '1'; });
    renderThumbs(); renderCats(); renderCard();
  }

  document.querySelectorAll('.mode:not([aria-disabled])').forEach((b) => b.addEventListener('click', () => {
    state.mode = b.dataset.mode;
    document.querySelectorAll('.mode').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    const p = PAL[theme];
    map.setPaintProperty('trains-dots', 'circle-color', ['case', ['==', ['get', 'key'], 'night'], p.land, colorExpr(p)]);
    map.setPaintProperty('trains-dots', 'circle-stroke-color', ['case', ['==', ['get', 'key'], 'night'], colorExpr(p), p.land]);
    map.setLayoutProperty('trains-arrows', 'icon-image', ['concat', 'tr-' + theme + '-', ['get', state.mode === 'delay' ? 'bkt' : 'key']]);
    renderCats();
  }));
  document.getElementById('zin').addEventListener('click', () => map.zoomIn());
  document.getElementById('zout').addEventListener('click', () => map.zoomOut());
  const lb = document.getElementById('layers-btn');
  lb.addEventListener('click', () => { const o = document.body.classList.toggle('layers-open'); lb.setAttribute('aria-expanded', String(o)); });

  const [, cap] = meta.capturedLocal.split(', ');
  document.getElementById('live-time').innerHTML = pun(cap);
  document.getElementById('live-date').textContent = meta.capturedLocal.split(', ')[0].replace(/ \d{4}$/, '');

  renderThumbs(); renderCats(); renderCard(); lucide.createIcons();
  map.on('zoom', renderStage);

  map.on('load', () => {
    setView(); renderStage();
    const finish = () => map.once('idle', () => { document.body.dataset.ready = '1'; });
    if (reduceMotion) { finish(); return; }
    state.aheadN = 2; map.getSource('rahead').setData(lineFC(aheadFull.slice(0, 2)));
    const t0 = performance.now(), dur = 600;
    (function step(now) {
      const t = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - t, 3);
      state.aheadN = Math.max(2, Math.round(e * aheadFull.length));
      map.getSource('rahead').setData(lineFC(aheadFull.slice(0, state.aheadN)));
      if (t < 1) requestAnimationFrame(step); else { map.triggerRepaint(); finish(); }
    })(t0);
  });
  window.__map = map;
})();
