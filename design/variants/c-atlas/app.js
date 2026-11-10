(async function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const q = new URLSearchParams(location.search);
  const AS = window.AtlasStyle;
  const root = document.documentElement;
  const phoneMQ = matchMedia('(max-width: 700px)');
  const fmt = (n) => n.toLocaleString('en-US');
  const short = (n) => n.replace(/Hauptbahnhof/g, 'Hbf').replace(/, Hbf$/, ' Hbf');
  const tn = (s) => String(s).replace(/\d/g, (d) => `<span class="d">${d}</span>`);
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  const state = {
    theme: q.get('theme') === 'light' ? 'light' : 'dark',
    view: q.get('view') || 'national',
    mode: 'category',
    hiddenGroups: new Set(),
    hiddenDelay: new Set(),
    foreignOn: true,
    routeOn: true,
    following: false,
    drawer: false,
    card: true
  };
  state.drawer = state.view === 'city';
  root.dataset.theme = state.theme;
  $$('#styles .chip[data-style]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.style === state.theme)));

  const [trains, meta, ice, mask] = await Promise.all([
    fetch('data/trains.json').then((r) => r.json()),
    fetch('data/meta.json').then((r) => r.json()),
    fetch('data/ice379.json').then((r) => r.json()),
    fetch('data/germany-mask.geojson').then((r) => r.json())
  ]);

  const groupOf = (t) => (t.foreign ? 'foreign' : { hsr: 'long', ld: 'long', night: 'long', rfast: 'fast', reg: 'reg', sbahn: 's' }[t.cat] || 'long');
  const dgroupOf = (t) => (!t.rt ? 'dn' : t.delay <= 5 ? 'd0' : t.delay <= 15 ? 'd1' : t.delay <= 30 ? 'd2' : 'd3');
  const sortKey = { foreign: 0, reg: 1, fast: 2, s: 3, long: 4 };

  const selTrain = trains.find((t) => t.line === ice.line && t.from === ice.segment.from && t.to === ice.segment.to);
  const selPos = [selTrain.lon, selTrain.lat];

  const dCounts = { d0: 0, d1: 0, d2: 0, d3: 0, dn: 0 };
  const features = trains.map((t) => {
    const g = groupOf(t), d = dgroupOf(t);
    dCounts[d]++;
    return { type: 'Feature', geometry: { type: 'Point', coordinates: [t.lon, t.lat] }, properties: { id: t.id, line: t.line, g, d, f: t.foreign, b: t.bearing, k: sortKey[g] } };
  });

  const nearestIdx = (pt, from, to) => {
    let bi = from, bd = Infinity;
    for (let i = from; i <= to; i++) {
      const c = ice.route[i];
      const dx = (c[0] - pt[0]) * Math.cos((pt[1] * Math.PI) / 180), dy = c[1] - pt[1];
      const dd = dx * dx + dy * dy;
      if (dd < bd) { bd = dd; bi = i; }
    }
    return bi;
  };
  const last = ice.route.length - 1;
  const prevStop = ice.stops[ice.nextStopIndex - 1], nextStopPt = ice.stops[ice.nextStopIndex];
  const iPrev = nearestIdx([prevStop.lon, prevStop.lat], 0, last);
  const iNext = nearestIdx([nextStopPt.lon, nextStopPt.lat], iPrev, last);
  const nearest = nearestIdx(selPos, iPrev, iNext);
  const routeFC = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { part: 'travelled' }, geometry: { type: 'LineString', coordinates: [...ice.route.slice(0, nearest + 1), selPos] } },
      { type: 'Feature', properties: { part: 'ahead' }, geometry: { type: 'LineString', coordinates: [selPos, ...ice.route.slice(nearest + 1)] } }
    ]
  };
  const stopsFC = {
    type: 'FeatureCollection',
    features: ice.stops.map((s) => ({ type: 'Feature', properties: { name: short(s.name), passed: s.passed }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } }))
  };
  const selFC = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { b: selTrain.bearing }, geometry: { type: 'Point', coordinates: selPos } }] };
  const D = { trains: { type: 'FeatureCollection', features }, route: routeFC, stops: stopsFC, sel: selFC, mask, selId: selTrain.id };

  const C = meta.countsByCategory;
  const counts = { long: C.hsr + C.ld + C.night, fast: C.rfast, reg: C.reg, s: C.sbahn, foreign: C.foreign };
  const dataTime = ice.captureLocal.slice(11);

  $('#dataTime').textContent = `Data ${dataTime}, Fri 23 Oct`;
  $('#dataTime').parentElement.title = meta.capturedLocal;
  $('#foreignN').textContent = fmt(C.foreign);
  $('#attribText').innerHTML = 'OpenStreetMap contributors, OpenFreeMap, OpenMapTiles, Transitous, DELFI, Mapterhorn. ' +
    '<span class="more" hidden>Coach sequence from bahn.de. Germany outline from Natural Earth. </span>';

  const KEYS = {
    category: [
      { id: 'long', label: 'Long distance', c: 'var(--long)', n: counts.long, tip: `ICE and other high speed ${C.hsr}, IC, EC and FLX ${C.ld}, night trains ${C.night}` },
      { id: 'fast', label: 'Fast regional', c: 'var(--fast)', n: counts.fast, tip: 'RE, IRE, MEX and other fast regional' },
      { id: 'reg', label: 'Regional', c: 'var(--reg)', n: counts.reg, tip: 'RB and other regional' },
      { id: 's', label: 'S-Bahn', c: 'var(--s)', n: counts.s, tip: 'S-Bahn' }
    ],
    delay: [
      { id: 'd0', label: 'Up to 5 min', c: 'var(--d0)', n: dCounts.d0 },
      { id: 'd1', label: '6 to 15 min', c: 'var(--d1)', n: dCounts.d1 },
      { id: 'd2', label: '16 to 30 min', c: 'var(--d2)', n: dCounts.d2 },
      { id: 'd3', label: 'Over 30 min', c: 'var(--d3)', n: dCounts.d3 },
      { id: 'dn', label: 'No realtime', c: 'var(--dn)', n: dCounts.dn }
    ]
  };

  function renderKeys() {
    const hidden = state.mode === 'delay' ? state.hiddenDelay : state.hiddenGroups;
    $('#keys').innerHTML = KEYS[state.mode].map((k) =>
      `<button class="key" data-id="${k.id}" aria-pressed="${!hidden.has(k.id)}" title="${esc(k.tip || k.label)}" style="--c:${k.c}"><span class="sw"></span><span>${k.label}</span><span class="n num">${fmt(k.n)}</span></button>`
    ).join('');
  }

  const card = $('#card'), drawer = $('#drawer'), tag = $('#tag');
  const next = ice.stops[ice.nextStopIndex];
  const nextName = short(next.name);
  const platText = `Platform ${next.track}, was ${next.trackSched}`;
  const provText = `Position is estimated between reports. Data from ${dataTime}.`;
  const actionsHTML = (withDetails) => `<div class="actions">
      ${withDetails ? '<button class="btn primary" data-act="details"><i data-lucide="panel-right-open"></i>Details</button>' : ''}
      <button class="btn" data-act="follow" aria-pressed="${state.following}"><i data-lucide="locate-fixed"></i>Follow</button>
      <button class="btn" data-act="route" aria-pressed="${state.routeOn}"><i data-lucide="route"></i>Route</button>
      <button class="btn" data-act="share"><i data-lucide="share-2"></i>Share</button>
    </div>`;
  const badgeHTML = '<span class="badge"><svg class="g" aria-hidden="true"><use href="#g-long"/></svg>High speed</span>';
  const delayHTML = `<span class="delay num">+${ice.currentDelay} min</span>`;

  function renderCard() {
    card.innerHTML = `<div class="sheet-grip"></div>
      <div class="row">${badgeHTML}<button class="icon-btn close" data-act="close" aria-label="Close train card"><i data-lucide="x"></i></button></div>
      <div class="row" style="align-items:flex-start;margin-top:4px"><h2 class="title">${esc(ice.line)}</h2><div style="display:grid;justify-items:end;gap:4px;margin-top:6px">${delayHTML}<span class="rt"><i></i>Realtime</span></div></div>
      <p class="dest">To ${esc(ice.destination)}</p>
      <p class="op">${esc(ice.operator)}</p>
      <div class="next row" style="align-items:flex-start">
        <div><div class="lbl">Next stop</div><div class="name">${esc(nextName)}</div><div class="plat">${platText}</div></div>
        <div><div class="time num">${next.arr}</div><div class="was num">was ${next.arrSched}</div></div>
      </div>
      ${actionsHTML(true)}
      <p class="prov">${provText}</p>`;
    tag.innerHTML = `<span>${esc(ice.line)}</span><span class="d num">+${ice.currentDelay} min</span>`;
  }

  function stopRows() {
    return ice.stops.map((s, i) => {
      const live = s.arr || s.dep, plan = s.arrSched || s.depSched;
      const changed = s.trackSched && s.trackSched !== s.track;
      const cls = s.passed ? 'passed' : i === ice.nextStopIndex ? 'nxt' : '';
      const row = `<tr class="${cls}"><td title="${esc(s.name)}">${esc(short(s.name))}</td><td class="plan num">${tn(plan)}</td><td class="num">${tn(live)}</td><td class="num">+${tn(s.delay)} min</td><td class="num ${changed ? 'chg' : ''}">${tn(s.track)}</td></tr>`;
      return i === ice.nextStopIndex ? `<tr class="here"><td colspan="5"><span><i></i>${esc(ice.line)} is between ${esc(short(ice.segment.from))} and ${esc(short(ice.segment.to))}</span></td></tr>${row}` : row;
    }).join('');
  }

  function renderDrawer() {
    const v = ice.vehicle, p = ice.photo;
    drawer.innerHTML = `<div class="sheet-grip"></div><div class="scroll">
      <div class="head">${badgeHTML}<button class="icon-btn close" data-act="collapse" aria-label="Close details"><i data-lucide="x"></i></button></div>
      <div class="headrow" style="align-items:flex-start"><h2 class="title">${esc(ice.line)}</h2><div style="display:grid;justify-items:end;gap:4px;margin-top:6px">${delayHTML}<span class="rt"><i></i>Realtime</span></div></div>
      <p class="dest">${esc(short(ice.origin))} to ${esc(ice.destination)}</p>
      <p class="op">${esc(ice.operator)}</p>
      ${actionsHTML(false)}
      <section class="nextsec">
        <div class="next row" style="align-items:flex-start;margin:0;padding:0;border:0">
          <div><div class="lbl">Next stop</div><div class="name">${esc(nextName)}</div><div class="plat">${platText}</div></div>
          <div><div class="time num">${next.arr}</div><div class="was num">was ${next.arrSched}</div></div>
        </div>
      </section>
      <section>
        <div class="veh">
          <dl>
            <dt>Vehicle</dt><dd>${esc(v.name)}, ${esc(v.series)}</dd>
            <dt>Set</dt><dd>${esc(v.set)}, ${v.cars} cars, ${v.lengthM} m</dd>
            <dt>Confidence</dt><dd class="conf"><i data-lucide="badge-check"></i>${esc(v.label)}</dd>
          </dl>
          <img src="data/${p.file}" alt="${esc(p.title)}" width="330" height="186">
        </div>
        <p class="credit">Photo: <a href="${p.source}" target="_blank" rel="noopener">${esc(p.title)}</a> by <a href="${p.authorUrl}" target="_blank" rel="noopener">${esc(p.author)}</a>, <a href="${p.licenceUrl}" target="_blank" rel="noopener">${esc(p.licence)}</a>, Wikimedia Commons. Vehicle source: ${esc(v.source.replace('2026-10-23', '23 October 2026'))}.</p>
      </section>
      <section>
        <h3>Stops</h3>
        <table class="stops"><thead><tr><th>Stop</th><th>Plan</th><th>Live</th><th>Delay</th><th>Platform</th></tr></thead><tbody>${stopRows()}</tbody></table>
      </section>
    </div>
    <p class="prov foot">${provText}</p>`;
  }

  renderKeys();
  renderCard();
  renderDrawer();
  lucide.createIcons();

  function syncPanels(animate) {
    const phone = phoneMQ.matches;
    card.hidden = !state.card || state.drawer;
    drawer.hidden = !state.card || !state.drawer;
    tag.hidden = !state.card || !state.drawer || phone;
    document.body.classList.toggle('drawer-open', state.card && state.drawer && !phone);
    if (animate) {
      for (const el of [card, tag]) { el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter'); }
      drawer.style.animation = 'none'; void drawer.offsetWidth; drawer.style.animation = '';
    }
    placeAnchored();
    sheetHeight();
  }

  function sheetHeight() {
    const el = !drawer.hidden ? drawer : !card.hidden ? card : null;
    document.documentElement.style.setProperty('--sheet-h', (el && phoneMQ.matches ? el.offsetHeight : 0) + 'px');
  }

  let map;
  function safeArea() {
    const W = innerWidth, H = innerHeight, bar = $('.bar').offsetHeight, strip = phoneMQ.matches ? 0 : $('.strip').offsetHeight;
    const rightCtrl = phoneMQ.matches ? 12 : 12 + 40;
    const rightDrawer = document.body.classList.contains('drawer-open') ? 400 + 12 : 0;
    return { top: bar + 12, bottom: H - strip - 12, left: 12, right: W - rightCtrl - rightDrawer - 4 };
  }

  function placeAnchored() {
    const line = $('#leader line'), dot = $('#leader circle');
    if (!map || phoneMQ.matches || !state.card) { line.hidden = dot.hidden = true; return; }
    const el = !drawer.hidden ? tag : card;
    if (el.hidden) { line.hidden = dot.hidden = true; return; }
    const w = el.offsetWidth, h = el.offsetHeight;
    const p = map.project(selPos);
    const S = safeArea();
    const far = map.getZoom() < 8, gx = !drawer.hidden ? 30 : far ? 150 : 48, gy = !drawer.hidden ? 22 : far ? 40 : 30;
    const cands = [['left', 'up'], ['right', 'up'], ['left', 'down'], ['right', 'down']];
    let pick = null;
    for (const [sx, sy] of cands) {
      const x = sx === 'left' ? p.x - gx - w : p.x + gx;
      const y = sy === 'up' ? p.y - gy - h : p.y + gy;
      if (x >= S.left && x + w <= S.right && y >= S.top && y + h <= S.bottom) { pick = { sx, sy, x, y }; break; }
    }
    if (!pick) {
      const [sx, sy] = cands[0];
      pick = { sx, sy, x: Math.min(Math.max(p.x - gx - w, S.left), S.right - w), y: Math.min(Math.max(p.y - gy - h, S.top), S.bottom - h) };
    }
    el.style.left = pick.x + 'px'; el.style.top = pick.y + 'px';
    el.style.setProperty('--origin', `${pick.sx === 'left' ? 'right' : 'left'} ${pick.sy === 'up' ? 'bottom' : 'top'}`);
    const ax = pick.sx === 'left' ? pick.x + w : pick.x, ay = pick.sy === 'up' ? pick.y + h : pick.y;
    const vx = ax - p.x, vy = ay - p.y, len = Math.hypot(vx, vy) || 1, r = 15;
    line.setAttribute('x1', p.x + (vx / len) * r); line.setAttribute('y1', p.y + (vy / len) * r);
    line.setAttribute('x2', ax); line.setAttribute('y2', ay);
    dot.setAttribute('cx', ax); dot.setAttribute('cy', ay);
    line.hidden = dot.hidden = false;
  }

  function cameraPadding() {
    const phone = phoneMQ.matches;
    if (phone) return { top: 72, bottom: (card.hidden ? 0 : card.offsetHeight) + 20, left: 16, right: 16 };
    return { top: 72, bottom: 64, left: 24, right: state.drawer ? 424 : 24 };
  }

  function updateStage() {
    if (!map) return;
    const z = map.getZoom();
    let text = 'Germany, all trains';
    if (z >= 6.6) {
      const b = map.getBounds();
      const hidden = state.mode === 'delay' ? state.hiddenDelay : state.hiddenGroups;
      let n = 0;
      for (let i = 0; i < trains.length; i++) {
        const t = trains[i];
        if (t.lon < b.getWest() || t.lon > b.getEast() || t.lat < b.getSouth() || t.lat > b.getNorth()) continue;
        if (t.foreign && !state.foreignOn) continue;
        const key = state.mode === 'delay' ? features[i].properties.d : features[i].properties.g;
        if (hidden.has(key)) continue;
        n++;
      }
      text = `${z < 9 ? 'Region' : z < 11 ? 'Area' : 'City'}, ${fmt(n)} trains in view`;
    }
    $('#stage').textContent = text;
  }

  function applyFilters() {
    const f = AS.visibilityFilter([...state.hiddenGroups], [...state.hiddenDelay], state.mode, state.foreignOn, selTrain.id);
    map.setFilter('tr-dot', f); map.setFilter('tr-sym', f);
    updateStage();
  }

  function applyMode() {
    const P = AS.PAL[state.theme];
    map.setPaintProperty('tr-dot', 'circle-color', AS.colorExpr(P, state.mode));
    map.setLayoutProperty('tr-sym', 'icon-image', AS.iconExpr(state.mode));
    applyFilters();
  }

  function styleOpts() {
    return { mode: state.mode, hiddenGroups: [...state.hiddenGroups], hiddenDelay: [...state.hiddenDelay], foreignOn: state.foreignOn, routeOn: state.routeOn };
  }

  function whenReady() {
    delete document.body.dataset.ready;
    const done = () => { document.fonts.ready.then(() => { placeAnchored(); updateStage(); document.body.dataset.ready = '1'; }); };
    map.once('idle', done);
  }

  const view = state.view;
  const startZoom = view === 'city' ? 12.5 : 5.5;
  map = new maplibregl.Map({
    container: 'map', style: AS.buildStyle(state.theme, D, styleOpts()), center: view === 'city' ? selPos : [10.4, 51.2], zoom: startZoom,
    attributionControl: false, fadeDuration: 0, maxPitch: 60, minZoom: 3, canvasContextAttributes: { antialias: true }
  });
  window.__map = map;

  map.on('styleimagemissing', (e) => AS.addMarker(map, e.id, state.theme));
  map.on('move', placeAnchored);
  map.on('moveend', updateStage);
  map.on('error', (e) => console.error('map error', e && e.error && e.error.message));

  map.once('load', () => {
    state.card = true;
    syncPanels(false);
    if (view === 'city') map.jumpTo({ center: selPos, zoom: 12.5, padding: cameraPadding() });
    else map.fitBounds([[5.7, 47.2], [15.2, 55.1]], { padding: cameraPadding(), duration: 0 });
    placeAnchored();
    updateStage();
    whenReady();
  });

  function setTheme(theme) {
    state.theme = theme;
    root.dataset.theme = theme;
    $$('#styles .chip[data-style]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.style === theme)));
    delete document.body.dataset.ready;
    map.setStyle(AS.buildStyle(theme, D, styleOpts()), { diff: false });
    whenReady();
  }
  window.__setTheme = setTheme;

  $('#styles').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b || b.disabled) return;
    setTheme(b.dataset.style);
  });
  $('#modes').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b || b.disabled) return;
    state.mode = b.dataset.mode;
    $$('#modes .chip').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderKeys(); applyMode();
  });
  $('#keys').addEventListener('click', (e) => {
    const b = e.target.closest('.key');
    if (!b) return;
    const set = state.mode === 'delay' ? state.hiddenDelay : state.hiddenGroups;
    set.has(b.dataset.id) ? set.delete(b.dataset.id) : set.add(b.dataset.id);
    b.setAttribute('aria-pressed', String(!set.has(b.dataset.id)));
    applyFilters();
  });
  $('#foreign').addEventListener('click', (e) => {
    state.foreignOn = !state.foreignOn;
    e.currentTarget.setAttribute('aria-checked', String(state.foreignOn));
    applyFilters();
  });

  function togglePanels(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'details') { state.drawer = true; syncPanels(true); if (!phoneMQ.matches) map.easeTo({ padding: cameraPadding(), duration: 240 }); }
    if (act === 'collapse') { state.drawer = false; syncPanels(true); if (!phoneMQ.matches) map.easeTo({ padding: cameraPadding(), duration: 240 }); }
    if (act === 'close') { state.card = false; syncPanels(false); }
    if (act === 'follow') {
      state.following = !state.following;
      $$('[data-act="follow"]').forEach((x) => { x.setAttribute('aria-pressed', String(state.following)); x.lastChild.textContent = state.following ? 'Following' : 'Follow'; });
    }
    if (act === 'route') {
      state.routeOn = !state.routeOn;
      const vis = state.routeOn ? 'visible' : 'none';
      ['route-ahead-casing', 'route-travelled', 'route-ahead', 'stops-dot', 'stops-label'].forEach((id) => map.setLayoutProperty(id, 'visibility', vis));
      $$('[data-act="route"]').forEach((x) => x.setAttribute('aria-pressed', String(state.routeOn)));
    }
    if (act === 'share') {
      const s = b.lastChild; const old = s.textContent; s.textContent = 'Link copied'; setTimeout(() => (s.textContent = old), 1400);
    }
  }
  card.addEventListener('click', togglePanels);
  drawer.addEventListener('click', togglePanels);
  tag.addEventListener('click', () => { state.drawer = false; syncPanels(true); map.easeTo({ padding: cameraPadding(), duration: 240 }); });
  map.on('click', (e) => {
    const p = map.project(selPos);
    if (Math.hypot(e.point.x - p.x, e.point.y - p.y) < 18 && !state.card) { state.card = true; syncPanels(true); }
  });

  $('#zin').onclick = () => map.zoomIn();
  $('#zout').onclick = () => map.zoomOut();
  $('#north').onclick = () => map.resetNorthPitch();

  $('#menuBtn').addEventListener('click', (e) => {
    const open = !document.body.classList.contains('menu-open');
    document.body.classList.toggle('menu-open', open);
    e.currentTarget.setAttribute('aria-expanded', String(open));
    if (open) {
      const bc = $('#barControls');
      $('#strip').style.setProperty('--strip-top', bc.getBoundingClientRect().bottom + 'px');
    }
  });
  $('#searchBtn').addEventListener('click', () => {
    document.body.classList.add('search-open');
    $('#q').focus();
  });
  $('#q').addEventListener('blur', () => document.body.classList.remove('search-open'));
  $('#attrBtn').addEventListener('click', (e) => {
    const open = $('#attrib').classList.toggle('open');
    $('#attrib .more').hidden = !open;
    e.currentTarget.setAttribute('aria-expanded', String(open));
  });

  const ro = new ResizeObserver(() => { sheetHeight(); placeAnchored(); });
  ro.observe(card); ro.observe(drawer);
  addEventListener('resize', () => { map.resize(); syncPanels(false); });
  phoneMQ.addEventListener('change', () => { map.resize(); syncPanels(false); });
})();
