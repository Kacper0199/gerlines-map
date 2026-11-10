(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const empty = () => ({ type: "FeatureCollection", features: [] });
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const isPhone = () => matchMedia("(max-width: 640px)").matches;
  const params = new URLSearchParams(location.search);
  const fmt = new Intl.NumberFormat("en-US");

  const CAT_LABEL = {
    hsr: "High speed", ld: "Long distance", night: "Night train", rfast: "Fast regional",
    reg: "Regional", sbahn: "S-Bahn", foreign: "Foreign feed"
  };
  const LEGEND = [
    ["hsr", "High speed, ICE"],
    ["ld", "Long distance, IC EC FLX"],
    ["night", "Night trains"],
    ["rfast", "Fast regional, RE IRE MEX"],
    ["reg", "Regional, RB"],
    ["sbahn", "S-Bahn"]
  ];
  const DELAY_LEGEND = [
    ["b0", "On time or up to 5 min", "--d-0"],
    ["b1", "6 to 15 min late", "--d-1"],
    ["b2", "16 to 30 min late", "--d-2"],
    ["b3", "More than 30 min late", "--d-3"],
    ["nort", "No realtime", "--d-n"]
  ];
  const GERMANY = [[5.6, 47.15], [15.3, 55.1]];
  const FRANKFURT = [8.6622, 50.106];

  const S = {
    theme: params.get("theme") === "light" ? "light" : "dark",
    mode: "category",
    enabled: ["hsr", "ld", "night", "rfast", "reg", "sbahn", "foreign"],
    expanded: false,
    selectedId: null,
    follow: false,
    routeVisible: true,
    passedOpen: false,
    data: { network: empty(), mask: empty(), trains: empty(), selected: empty(), routePast: empty(), routeAhead: empty(), stops: empty() }
  };
  let map, meta, ice, trains, iceTrain, routeSplit, trainsById = new Map();
  let anim = { route: false, pulse: false, fly: false, net: true };
  let counts = { cats: {}, delay: {} };

  const cleanName = (n) =>
    n.replace(/^S\+U /, "").replace(/, Hauptbahnhof/, " Hbf").replace(/ Hauptbahnhof/, " Hbf").replace(/ Bahnhof$/, "");
  const deltaText = (d) => (d > 0 ? "+" + d + " min" : d + " min");
  const delayBucket = (t) => (!t.rt ? "nort" : t.delay <= 5 ? "b0" : t.delay <= 15 ? "b1" : t.delay <= 30 ? "b2" : "b3");
  const cssv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  function icon(id, cls = "") {
    return `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
  }

  async function loadData() {
    const get = (f) => fetch("data/" + f).then((r) => {
      if (!r.ok) throw new Error(f + " " + r.status);
      return r.json();
    });
    [meta, ice, trains, S.data.mask] = await Promise.all([
      get("meta.json"), get("ice379.json"), get("trains.json"), get("germany-mask.geojson")
    ]);
    const feats = trains.map((t) => {
      const k = t.foreign ? "foreign" : t.cat;
      const dc = delayBucket(t);
      counts.cats[k] = (counts.cats[k] || 0) + 1;
      if (!t.foreign) counts.delay[dc] = (counts.delay[dc] || 0) + 1;
      trainsById.set(t.id, t);
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [t.lon, t.lat] },
        properties: { id: t.id, line: t.line, k, cat: t.cat, foreign: t.foreign, rt: t.rt, delay: t.delay, dc, bearing: t.bearing }
      };
    });
    S.data.trains = { type: "FeatureCollection", features: feats };
    iceTrain = trains.find((t) => t.line === "ICE 379" && !t.foreign);

    const pos = [iceTrain.lon, iceTrain.lat];
    const r = ice.route;
    let best = 0, bd = Infinity;
    r.forEach((p, i) => {
      const d = Math.hypot((p[0] - pos[0]) * 0.64, p[1] - pos[1]);
      if (d < bd) { bd = d; best = i; }
    });
    routeSplit = { past: r.slice(0, best + 1).concat([pos]), ahead: [pos].concat(r.slice(best + 1)) };

    S.data.stops = {
      type: "FeatureCollection",
      features: ice.stops.map((s, i) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [s.lon, s.lat] },
        properties: { name: s.name, short: cleanName(s.name), passed: s.passed, i }
      }))
    };
    S.iceKey = iceTrain.id;
  }

  function line(coords) {
    return { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: {} }] };
  }

  function arrowImage() {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d");
    g.fillStyle = "#fff";
    g.beginPath();
    g.moveTo(32, 5);
    g.lineTo(51, 55);
    g.lineTo(32, 44);
    g.lineTo(13, 55);
    g.closePath();
    g.fill();
    return g.getImageData(0, 0, 64, 64);
  }

  function addArrow() {
    if (!map.hasImage("arrow")) map.addImage("arrow", arrowImage(), { sdf: true, pixelRatio: 2 });
  }

  function styleState() {
    return { mode: S.mode, enabled: S.enabled, data: S.data };
  }

  function currentPadding() {
    if (isPhone()) {
      return { top: 96, bottom: S.selectedId ? sheetHeight() + 24 : 80, left: 24, right: 24 };
    }
    return { top: 96, bottom: 84, left: S.selectedId ? 300 : 40, right: S.selectedId ? 440 : 40 };
  }

  function sheetHeight() {
    return S.expanded ? Math.round(innerHeight * 0.8) : 388;
  }

  function setSheetVar() {
    document.documentElement.style.setProperty("--sheet-h", S.selectedId ? sheetHeight() + "px" : "0px");
  }

  async function loadNetwork() {
    try {
      const [vt, pb] = await Promise.all([
        import("https://cdn.jsdelivr.net/npm/@mapbox/vector-tile@1.3.1/+esm"),
        import("https://cdn.jsdelivr.net/npm/pbf@3.2.1/+esm")
      ]);
      const VectorTile = vt.VectorTile || vt.default.VectorTile;
      const Pbf = pb.default.default || pb.default;
      const tj = await fetch("https://tiles.openfreemap.org/planet").then((r) => r.json());
      const tpl = tj.tiles[0];
      const z = 8, n = 2 ** z;
      const tx = (lon) => Math.floor(((lon + 180) / 360) * n);
      const ty = (lat) => {
        const r = (lat * Math.PI) / 180;
        return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
      };
      const x0 = tx(4.9), x1 = tx(16), y0 = ty(55.4), y1 = ty(46.8);
      const jobs = [];
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          jobs.push(
            fetch(tpl.replace("{z}", z).replace("{x}", x).replace("{y}", y))
              .then((r) => (r.ok ? r.arrayBuffer() : null))
              .then((buf) => {
                if (!buf) return [];
                const layer = new VectorTile(new Pbf(buf)).layers.transportation;
                const out = [];
                if (!layer) return out;
                for (let i = 0; i < layer.length; i++) {
                  const f = layer.feature(i);
                  if (f.properties.class !== "rail" || f.properties.service) continue;
                  out.push(f.toGeoJSON(x, y, z));
                }
                return out;
              })
              .catch(() => [])
          );
        }
      }
      const feats = (await Promise.all(jobs)).flat();
      S.data.network = { type: "FeatureCollection", features: feats };
      map.getSource("network").setData(S.data.network);
    } catch (err) {
      console.warn("Network layer not loaded", err);
    }
    anim.net = false;
  }

  /* Legend */
  function renderLegend() {
    const el = $("#legend");
    let html;
    if (S.mode === "category") {
      html = `<h2>Trains by category</h2>`;
      LEGEND.forEach(([k, name]) => {
        const on = S.enabled.includes(k);
        html += `<button type="button" class="leg-row" data-k="${k}" aria-pressed="${on}" style="--sw:var(--c-${k})">
          <span class="sw"></span><span class="nm">${name}</span><span class="ct">${fmt.format(meta.countsByCategory[k])}</span></button>`;
      });
      const on = S.enabled.includes("foreign");
      html += `<div class="leg-sep"></div>
        <button type="button" class="leg-row foreign" data-k="foreign" aria-pressed="${on}" style="--sw:var(--c-foreign)">
        <span class="sw"></span><span class="nm">Neighbouring countries</span><span class="ct">${fmt.format(meta.countsByCategory.foreign)}</span><span class="tog" aria-hidden="true"></span></button>`;
    } else {
      html = `<h2>Trains by delay at the next stop</h2>`;
      DELAY_LEGEND.forEach(([k, name, v]) => {
        html += `<div class="leg-row static" style="--sw:var(${v})"><span class="sw"></span><span class="nm">${name}</span><span class="ct">${fmt.format(counts.delay[k] || 0)}</span></div>`;
      });
      const on = S.enabled.includes("foreign");
      html += `<div class="leg-sep"></div>
        <button type="button" class="leg-row foreign" data-k="foreign" aria-pressed="${on}" style="--sw:var(--d-0)">
        <span class="sw"></span><span class="nm">Neighbouring countries</span><span class="ct">${fmt.format(meta.countsByCategory.foreign)}</span><span class="tog" aria-hidden="true"></span></button>`;
    }
    el.innerHTML = html;
    $$(".leg-row[data-k]", el).forEach((b) =>
      b.addEventListener("click", () => {
        const k = b.dataset.k;
        S.enabled = S.enabled.includes(k) ? S.enabled.filter((x) => x !== k) : S.enabled.concat([k]);
        renderLegend();
        applyFilters();
      })
    );
  }

  function applyFilters() {
    if (!map.getLayer("trains-circle")) return;
    const f = NF.trainFilter(S.enabled);
    map.setFilter("trains-circle", f);
    map.setFilter("trains-arrow", f);
  }

  function applyMode() {
    const P = NF.readPalette();
    const e = NF.colorExpr(P, S.mode);
    map.setPaintProperty("trains-circle", "circle-color", e);
    map.setPaintProperty("trains-arrow", "icon-color", e);
    renderLegend();
  }

  /* Stage line */
  function updateStage() {
    const z = map.getZoom();
    const el = $("#stage");
    if (z < 7.5) {
      el.textContent = "Germany, all trains";
      return;
    }
    const seen = new Set();
    const layer = z >= 10 ? "trains-arrow" : "trains-circle";
    map.queryRenderedFeatures({ layers: [layer] }).forEach((f) => seen.add(f.properties.id));
    const n = seen.size;
    el.textContent = `${fmt.format(n)} ${n === 1 ? "train" : "trains"} in view`;
  }

  /* Inspector */
  function stopRows() {
    const stops = ice.stops;
    const ahead = stops.map((s, i) => ({ s, i })).filter((x) => !x.s.passed);
    const passed = stops.filter((s) => s.passed);
    let html = "";
    if (passed.length) {
      if (S.passedOpen) {
        passed.forEach((s, j) => {
          html += stopRow(s, { passed: true, first: j === 0 });
        });
      } else {
        html += `<button type="button" class="passed-toggle" id="passed-toggle" aria-expanded="false"><span class="nd"></span><span>Show ${passed.length} stops passed, ${cleanName(passed[0].name)} to ${cleanName(passed[passed.length - 1].name)}</span></button>`;
      }
    }
    html += `<div class="now"><span class="nd">${icon("pos")}</span><span>Now, about one minute before arrival</span></div>`;
    ahead.forEach(({ s, i }, j) => {
      html += stopRow(s, { next: i === ice.nextStopIndex, last: j === ahead.length - 1 });
    });
    return html;
  }

  function stopRow(s, o) {
    const t = s.arr || s.dep;
    return `<div class="stop${o.passed ? " passed" : ""}${o.next ? " next-stop" : ""}${o.first ? " first" : ""}${o.last ? " last" : ""}">
      <span class="nd"><i></i></span><span class="nm">${cleanName(s.name)}${o.next ? `<small>Platform ${ice.vehicle.platformAtFrankfurt.actual}, was ${ice.vehicle.platformAtFrankfurt.scheduled}</small>` : ""}</span>
      <span class="tm">${t}</span><span class="dl${!o.passed && s.delay >= 30 ? " big" : ""}">${deltaText(s.delay)}</span></div>`;
  }

  function renderInspector() {
    const el = $("#inspector");
    if (!S.selectedId) {
      el.hidden = true;
      document.body.classList.remove("has-inspector");
      setSheetVar();
      return;
    }
    const isIce = S.selectedId === S.iceKey;
    const t = trainsById.get(S.selectedId);
    const k = t.foreign ? "foreign" : t.cat;
    const next = ice.stops[ice.nextStopIndex];
    const late = t.rt ? deltaText(t.delay) : "No realtime";
    const dataTime = meta.capturedLocal.replace(/^[A-Za-z]+ /, "").replace(/, (\d\d:\d\d)$/, "");
    const clock = (meta.capturedLocal.match(/(\d\d:\d\d)$/) || [])[1];

    const head = `
      <div class="ins-grab"><button type="button" id="grab" aria-label="${S.expanded ? "Collapse card" : "Expand card"}" aria-expanded="${S.expanded}"></button></div>
      <header class="ins-head">
        <div class="ins-top">
          <span class="badge" style="--sw:var(--c-${k})"><i></i>${CAT_LABEL[k]}</span>
          <span class="ins-tools">
            ${isIce ? `<button type="button" class="btn slim" id="more-toggle" aria-expanded="${S.expanded}">${S.expanded ? "Less" : "Details"}${icon("chev-down")}</button>` : ""}
            <button type="button" class="icon-btn" id="close-card" aria-label="Close train card">${icon("x")}</button>
          </span>
        </div>
        <h2 class="ins-title">${t.line}</h2>
        <div class="ins-dest">
          <div>
            <p class="dest">${isIce ? "Basel SBB" : cleanName(t.to)}</p>
            <p class="from muted">${isIce ? "From " + cleanName(ice.origin) + ". " + ice.operator : "Next stop " + cleanName(t.to)}</p>
          </div>
          <div class="delay${t.rt ? "" : " nort"}"><strong style="${t.rt && t.delay < 30 ? "color:var(--ink)" : ""}">${late}</strong><span>${t.rt ? "Realtime" : "Timetable only"}</span></div>
        </div>
      </header>`;

    let body;
    if (isIce) {
      const p = ice.photo, v = ice.vehicle;
      body = `
        <section class="sec next" aria-label="Next stop">
          <span class="lbl">Next stop</span><span class="lbl" style="text-align:right">Arrives</span>
          <span class="nm">${cleanName(next.name)}</span><span class="tm">${next.arr}</span>
          <span class="plat">Platform ${v.platformAtFrankfurt.actual}, was ${v.platformAtFrankfurt.scheduled}</span><span class="was">was ${next.arrSched}</span>
        </section>
        <div class="details">
          <figure class="photo" id="photo">
            <img src="data/${p.file}" alt="${p.title}" width="330" height="186">
            <div class="missing" role="img" aria-label="Photo not available">Photo not available</div>
            <figcaption>${p.title} by <a href="${p.authorUrl}" target="_blank" rel="noopener">${p.author}</a>, <a href="${p.licenceUrl}" target="_blank" rel="noopener">${p.licence}</a>, via <a href="${p.source}" target="_blank" rel="noopener">Wikimedia Commons</a></figcaption>
          </figure>
          <section class="sec veh" aria-label="Vehicle">
            <div class="vrow"><p class="nm">${v.name}, ${v.series}</p><p class="conf">${icon("check")}${v.label}</p></div>
            <p class="sub">Set ${v.set}, ${v.cars} cars, ${v.lengthM} m, up to ${v.maxSpeedKmh} km/h</p>
          </section>
          <section class="sec stops" aria-label="Stops">
            <h3>Stops <span>${ice.stops.length} in total</span></h3>
            ${stopRows()}
          </section>
        </div>
        <section class="sec"><p class="prov">Position is estimated between reports. Data from ${clock} on ${dataTime}, Transitous and DELFI.</p></section>`;
    } else {
      body = `
        <section class="sec next" aria-label="Segment">
          <span class="lbl">Now between</span><span></span>
          <span class="nm">${cleanName(t.from)} and ${cleanName(t.to)}</span><span></span>
        </section>
        <section class="sec"><p class="prov">Position is estimated between reports. Data from ${clock} on ${dataTime}, Transitous and DELFI. Vehicle, photo and stops follow in the product.</p></section>`;
    }

    const actions = `
      <footer class="ins-actions">
        <button type="button" class="btn primary" id="act-follow" aria-pressed="${S.follow}">${icon("follow")}Follow</button>
        <button type="button" class="btn" id="act-route" aria-pressed="${S.routeVisible}" ${isIce ? "" : "disabled"}>${icon("route")}Route</button>
        <button type="button" class="btn" id="act-share">${icon("share")}Share</button>
      </footer>`;

    el.className = "inspector fit" + (S.expanded ? " is-expanded" : "");
    el.innerHTML = head + `<div class="ins-body" id="ins-body">${body}</div>` + actions;
    el.hidden = false;
    document.body.classList.add("has-inspector");
    setSheetVar();

    $("#close-card").onclick = () => deselect();
    const mt = $("#more-toggle");
    if (mt) mt.onclick = () => toggleExpanded();
    const gb = $("#grab");
    if (gb) gb.onclick = () => toggleExpanded();
    const pt = $("#passed-toggle");
    if (pt) pt.onclick = () => { S.passedOpen = true; renderInspector(); };
    const img = $("#photo img");
    if (img) img.addEventListener("error", () => $("#photo").classList.add("is-missing"));
    $("#act-follow").onclick = (e) => {
      S.follow = !S.follow;
      e.currentTarget.setAttribute("aria-pressed", S.follow);
      if (S.follow) map.easeTo({ center: [iceTrain.lon, iceTrain.lat], padding: currentPadding(), duration: reduced ? 0 : 600 });
    };
    $("#act-route").onclick = (e) => {
      S.routeVisible = !S.routeVisible;
      e.currentTarget.setAttribute("aria-pressed", S.routeVisible);
      ["route-past", "route-ahead", "route-ahead-casing"].forEach((l) => map.setLayoutProperty(l, "visibility", S.routeVisible ? "visible" : "none"));
    };
    $("#act-share").onclick = () => navigator.clipboard && navigator.clipboard.writeText(location.href).catch(() => {});
  }

  function toggleExpanded(v) {
    S.expanded = typeof v === "boolean" ? v : !S.expanded;
    renderInspector();
    if (isPhone()) map.easeTo({ padding: currentPadding(), duration: reduced ? 0 : 220 });
  }

  /* Selection, camera, animation */
  function selectTrain(id, opts = {}) {
    const t = trainsById.get(id);
    if (!t) return;
    S.selectedId = id;
    S.follow = false;
    const f = { type: "Feature", geometry: { type: "Point", coordinates: [t.lon, t.lat] }, properties: { line: t.line, bearing: t.bearing } };
    S.data.selected = { type: "FeatureCollection", features: [f] };
    map.getSource("selected").setData(S.data.selected);
    const isIce = id === S.iceKey;
    if (isIce) {
      S.data.routePast = line(routeSplit.past);
      map.getSource("route-past").setData(S.data.routePast);
    } else {
      S.data.routePast = empty();
      S.data.routeAhead = empty();
      map.getSource("route-past").setData(S.data.routePast);
      map.getSource("route-ahead").setData(S.data.routeAhead);
    }
    renderInspector();
    const target = { center: [t.lon, t.lat], zoom: opts.zoom != null ? opts.zoom : Math.max(map.getZoom(), 9.5), padding: currentPadding() };
    if (opts.noCamera) {
      afterFly(isIce, true);
    } else if (opts.jump || reduced) {
      map.jumpTo(target);
      afterFly(isIce, true);
    } else {
      anim.fly = true;
      map.flyTo(Object.assign({ duration: 1200, essential: true }, target));
      map.once("moveend", () => { anim.fly = false; afterFly(isIce, false); });
    }
  }

  function afterFly(isIce, instant) {
    if (isIce) drawRoute(instant);
    pulse(instant);
  }

  function cumulative(coords) {
    const d = [0];
    for (let i = 1; i < coords.length; i++) {
      d.push(d[i - 1] + Math.hypot((coords[i][0] - coords[i - 1][0]) * 0.64, coords[i][1] - coords[i - 1][1]));
    }
    return d;
  }

  function drawRoute(instant) {
    const full = routeSplit.ahead;
    if (instant) {
      S.data.routeAhead = line(full);
      map.getSource("route-ahead").setData(S.data.routeAhead);
      return;
    }
    const cum = cumulative(full), total = cum[cum.length - 1];
    anim.route = true;
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / 800);
      const e = 1 - Math.pow(1 - p, 3);
      const target = total * e;
      let i = 1;
      while (i < cum.length - 1 && cum[i] < target) i++;
      const seg = cum[i] - cum[i - 1] || 1;
      const f = Math.max(0, Math.min(1, (target - cum[i - 1]) / seg));
      const a = full[i - 1], b = full[i];
      const head = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
      S.data.routeAhead = line(full.slice(0, i).concat([head]));
      map.getSource("route-ahead").setData(S.data.routeAhead);
      if (p < 1) requestAnimationFrame(step);
      else {
        S.data.routeAhead = line(full);
        map.getSource("route-ahead").setData(S.data.routeAhead);
        anim.route = false;
      }
    };
    requestAnimationFrame(step);
  }

  function pulse(instant) {
    if (instant || reduced) return;
    anim.pulse = true;
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / 900);
      const e = 1 - Math.pow(1 - p, 2);
      if (!map.getLayer("sel-pulse")) { anim.pulse = false; return; }
      map.setPaintProperty("sel-pulse", "circle-radius", 9 + 26 * e);
      map.setPaintProperty("sel-pulse", "circle-stroke-opacity", 0.9 * (1 - p));
      if (p < 1) requestAnimationFrame(step);
      else {
        map.setPaintProperty("sel-pulse", "circle-stroke-opacity", 0);
        anim.pulse = false;
      }
    };
    requestAnimationFrame(step);
  }

  function deselect() {
    S.selectedId = null;
    S.follow = false;
    S.data.selected = empty();
    S.data.routePast = empty();
    S.data.routeAhead = empty();
    ["selected", "route-past", "route-ahead"].forEach((s, i) =>
      map.getSource(s).setData([S.data.selected, S.data.routePast, S.data.routeAhead][i]));
    renderInspector();
    map.easeTo({ padding: currentPadding(), duration: reduced ? 0 : 300 });
  }

  /* Theme */
  function setTheme(t) {
    S.theme = t;
    document.documentElement.dataset.theme = t;
    $$("#style-seg button[data-style]").forEach((b) => b.setAttribute("aria-checked", b.dataset.style === t));
    map.setStyle(NF.buildStyle(styleState()), { diff: false });
  }

  /* Palette */
  function setupPalette() {
    const wrap = $("#palette-wrap"), input = $("#palette-input"), list = $("#palette-list"), hint = $("#palette-hint");
    let results = [], active = 0, returnFocus = null;
    const open = () => {
      returnFocus = document.activeElement;
      wrap.hidden = false;
      input.value = "";
      render();
      input.focus();
    };
    const close = () => {
      wrap.hidden = true;
      if (returnFocus && returnFocus.focus) returnFocus.focus();
    };
    function search(q) {
      q = q.trim().toLowerCase();
      if (!q) {
        const pick = trains.filter((t) => t.line === "ICE 379" || (t.cat === "hsr" && !t.foreign && t.rt));
        return pick.slice(0, 7);
      }
      return trains.filter((t) => (t.line + " " + t.from + " " + t.to).toLowerCase().includes(q)).slice(0, 7);
    }
    function render() {
      results = search(input.value);
      active = 0;
      hint.textContent = input.value ? `${results.length} shown` : "Suggested trains";
      if (!results.length) {
        list.innerHTML = `<li class="empty">No train matches this search.</li>`;
        return;
      }
      list.innerHTML = results.map((t, i) => {
        const k = t.foreign ? "foreign" : t.cat;
        return `<li><button type="button" role="option" aria-selected="${i === active}" data-i="${i}">
          <span class="sw" style="--sw:var(--c-${k})"></span><span class="ln">${t.line}</span>
          <span class="sg">${cleanName(t.from)} to ${cleanName(t.to)}</span>
          <span class="dl">${t.rt ? deltaText(t.delay) : "No realtime"}</span></button></li>`;
      }).join("");
    }
    function mark() {
      $$("#palette-list button").forEach((b, i) => b.setAttribute("aria-selected", i === active));
    }
    function go(i) {
      const t = results[i];
      if (!t) return;
      close();
      selectTrain(t.id, { zoom: 11.5 });
    }
    $("#open-search").addEventListener("click", open);
    input.addEventListener("input", render);
    list.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-i]");
      if (b) go(+b.dataset.i);
    });
    wrap.addEventListener("mousedown", (e) => { if (e.target === wrap) close(); });
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        wrap.hidden ? open() : close();
        return;
      }
      if (wrap.hidden) return;
      if (e.key === "Escape") close();
      else if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(results.length - 1, active + 1); mark(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(0, active - 1); mark(); }
      else if (e.key === "Enter") { e.preventDefault(); go(active); }
      else if (e.key === "Tab") { e.preventDefault(); input.focus(); }
    });
  }

  /* UI wiring */
  function setupUi() {
    $("#count-total").textContent = `${fmt.format(meta.trainsTotal)} trains`;
    $("#count-live").append(document.createTextNode(`${fmt.format(meta.trainsRealtime)} live`));
    $("#zoom-in").onclick = () => map.zoomIn({ duration: reduced ? 0 : 250 });
    $("#zoom-out").onclick = () => map.zoomOut({ duration: reduced ? 0 : 250 });
    const lb = $("#layers-btn"), pop = $("#layers-pop");
    lb.onclick = () => {
      pop.hidden = !pop.hidden;
      lb.setAttribute("aria-expanded", !pop.hidden);
    };
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !pop.hidden) { pop.hidden = true; lb.setAttribute("aria-expanded", "false"); lb.focus(); }
    });
    $$("#mode-seg button[data-mode]").forEach((b) => b.addEventListener("click", () => {
      S.mode = b.dataset.mode;
      $$("#mode-seg button").forEach((x) => x.setAttribute("aria-checked", x === b));
      applyMode();
    }));
    $$("#style-seg button[data-style]").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.style !== S.theme) setTheme(b.dataset.style);
    }));
    const ab = $("#attrib-btn"), at = $("#attrib");
    ab.onclick = () => {
      at.classList.toggle("open");
      ab.setAttribute("aria-expanded", at.classList.contains("open"));
    };
    renderLegend();
  }

  function applyView(name) {
    const jump = (o) => map.jumpTo(Object.assign({ pitch: 0, bearing: 0 }, o));
    if (name === "city") {
      S.expanded = true;
      selectTrain(S.iceKey, { jump: true, zoom: 12.5 });
      jump({ center: FRANKFURT, zoom: 12.5, padding: currentPadding() });
      S.follow = false;
      renderInspector();
    } else if (name === "phone") {
      S.expanded = false;
      selectTrain(S.iceKey, { jump: true, zoom: 8.2 });
    } else {
      S.expanded = false;
      selectTrain(S.iceKey, { noCamera: true });
      map.fitBounds(GERMANY, { padding: currentPadding(), duration: 0 });
    }
  }

  async function boot() {
    document.documentElement.dataset.theme = S.theme;
    await loadData();
    $$("#style-seg button[data-style]").forEach((b) => b.setAttribute("aria-checked", b.dataset.style === S.theme));
    map = new maplibregl.Map({
      container: "map",
      style: NF.buildStyle(styleState()),
      center: [10.4, 51.2],
      zoom: 5.4,
      maxZoom: 17,
      minZoom: 3,
      attributionControl: false,
      fadeDuration: 0,
      dragRotate: true,
      pitchWithRotate: false
    });
    map.on("styleimagemissing", (e) => { if (e.id === "arrow") addArrow(); });
    setupUi();
    setupPalette();
    window.__map = map;

    map.on("load", () => {
      addArrow();
      const view = params.get("view");
      if (view) applyView(view);
      else if (params.get("fresh")) { map.fitBounds(GERMANY, { padding: currentPadding(), duration: 0 }); }
      else applyView("national");
      updateStage();
      let settled = 0;
      const finish = () => {
        const ready = () => !anim.route && !anim.pulse && !anim.fly && !anim.net;
        const tick = () => {
          if (!ready()) return setTimeout(tick, 100);
          document.fonts.ready.then(() => {
            document.body.dataset.ready = "1";
            $("#boot").classList.add("done");
          });
        };
        tick();
      };
      loadNetwork().then(() => map.once("idle", finish));
    });
    map.on("moveend", updateStage);
    map.on("idle", updateStage);

    ["trains-circle", "trains-arrow"].forEach((l) => {
      map.on("click", l, (e) => {
        const f = e.features && e.features[0];
        if (f) selectTrain(f.properties.id);
      });
      map.on("mouseenter", l, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", l, () => (map.getCanvas().style.cursor = ""));
    });

    matchMedia("(max-width: 640px)").addEventListener("change", () => {
      renderInspector();
      if (map) map.resize();
    });
  }

  boot().catch((err) => {
    console.error(err);
    $("#boot").textContent = "Could not load the map data.";
  });
})();
