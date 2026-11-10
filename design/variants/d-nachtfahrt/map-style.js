(function () {
  const VARS = [
    "land", "water", "wood", "resid", "build", "road-minor", "road-major", "road-motor",
    "rail", "rail-far", "label", "halo", "boundary", "state", "mask", "mask-a", "past", "stop-past"
  ];
  const CATS = ["hsr", "ld", "night", "rfast", "reg", "sbahn", "foreign"];

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function readPalette() {
    const p = { map: {}, cat: {}, delay: {} };
    VARS.forEach((v) => (p.map[v] = cssVar("--m-" + v)));
    CATS.forEach((c) => (p.cat[c] = cssVar("--c-" + c)));
    ["0", "1", "2", "3", "n"].forEach((d) => (p.delay[d] = cssVar("--d-" + d)));
    p.accent = cssVar("--accent");
    p.ink = cssVar("--ink");
    p.foreignA = parseFloat(cssVar("--foreign-a"));
    p.maskA = parseFloat(p.map["mask-a"]);
    return p;
  }

  function colorExpr(P, mode) {
    if (mode === "delay") {
      return ["match", ["get", "dc"], "b0", P.delay[0], "b1", P.delay[1], "b2", P.delay[2], "b3", P.delay[3], P.delay.n];
    }
    const m = ["match", ["get", "k"]];
    CATS.forEach((c) => m.push(c, P.cat[c]));
    m.push(P.cat.foreign);
    return m;
  }

  const SORT = ["match", ["get", "k"], "foreign", 0, "reg", 1, "sbahn", 2, "rfast", 3, "ld", 4, "night", 5, "hsr", 6, 0];

  function trainFilter(enabled) {
    return ["in", ["get", "k"], ["literal", enabled]];
  }

  function buildStyle(S) {
    const P = readPalette();
    const M = P.map;
    const NAME = ["coalesce", ["get", "name_en"], ["get", "name"]];
    const LINE = ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false];
    const POLY = ["match", ["geometry-type"], ["MultiPolygon", "Polygon"], true, false];
    const POINT = ["match", ["geometry-type"], ["MultiPoint", "Point"], true, false];
    const FONT = ["Noto Sans Regular"];
    const cls = (...v) => ["match", ["get", "class"], v, true, false];
    const labelPaint = { "text-color": M.label, "text-halo-color": M["halo"], "text-halo-width": 1.5, "text-halo-blur": 0 };

    const layers = [
      { id: "background", type: "background", paint: { "background-color": M.land } },
      {
        id: "wood", type: "fill", source: "omt", "source-layer": "landcover", minzoom: 7,
        filter: ["all", POLY, ["==", ["get", "class"], "wood"]],
        paint: { "fill-color": M.wood, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 7, 0, 10, 1] }
      },
      {
        id: "park", type: "fill", source: "omt", "source-layer": "landuse", minzoom: 9,
        filter: ["all", POLY, cls("park", "cemetery", "pitch")],
        paint: { "fill-color": M.wood }
      },
      {
        id: "residential", type: "fill", source: "omt", "source-layer": "landuse", maxzoom: 13,
        filter: ["all", POLY, ["==", ["get", "class"], "residential"]],
        paint: { "fill-color": M.resid, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 4, 0.5, 12, 1] }
      },
      { id: "water", type: "fill", source: "omt", "source-layer": "water", paint: { "fill-color": M.water, "fill-antialias": true } },
      {
        id: "waterway", type: "line", source: "omt", "source-layer": "waterway", minzoom: 8, filter: LINE,
        paint: { "line-color": M.water, "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.6, 14, 2.4] }
      },
      {
        id: "building", type: "fill", source: "omt", "source-layer": "building", minzoom: 13, filter: POLY,
        paint: { "fill-color": M.build, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0, 14, 1] }
      },
      {
        id: "road-minor", type: "line", source: "omt", "source-layer": "transportation", minzoom: 10,
        filter: ["all", LINE, cls("minor", "service", "track")],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": M["road-minor"], "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 10, 0.4, 14, 1.4, 18, 8] }
      },
      {
        id: "road-major", type: "line", source: "omt", "source-layer": "transportation", minzoom: 7,
        filter: ["all", LINE, cls("primary", "secondary", "tertiary", "trunk")],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": M["road-major"], "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 7, 0.4, 12, 1.2, 18, 10] }
      },
      {
        id: "road-motorway", type: "line", source: "omt", "source-layer": "transportation", minzoom: 5,
        filter: ["all", LINE, ["==", ["get", "class"], "motorway"]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": M["road-motor"], "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 5, 0.4, 9, 1, 12, 1.8, 18, 12] }
      },
      {
        id: "mask", type: "fill", source: "mask",
        paint: { "fill-color": M.mask, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 8, P.maskA, 9.5, 0] }
      },
      {
        id: "boundary-state", type: "line", source: "omt", "source-layer": "boundary", minzoom: 4,
        filter: ["==", ["get", "admin_level"], 4],
        paint: { "line-color": M.state, "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.5, 12, 1.2], "line-dasharray": [3, 3] }
      },
      {
        id: "boundary-country", type: "line", source: "omt", "source-layer": "boundary",
        filter: ["all", ["==", ["get", "admin_level"], 2], ["!=", ["get", "maritime"], 1]],
        paint: { "line-color": M.boundary, "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.6, 12, 1.6] }
      },
      {
        id: "transit", type: "line", source: "omt", "source-layer": "transportation", minzoom: 10,
        filter: ["all", LINE, ["==", ["get", "class"], "transit"], ["!=", ["get", "brunnel"], "tunnel"]],
        paint: { "line-color": M.rail, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.6, 14, 1.1, 18, 2.4] }
      },
      {
        id: "rail-service", type: "line", source: "omt", "source-layer": "transportation", minzoom: 12.5,
        filter: ["all", LINE, ["==", ["get", "class"], "rail"], ["has", "service"]],
        paint: { "line-color": M.rail, "line-width": ["interpolate", ["linear"], ["zoom"], 12.5, 0.4, 16, 1] }
      },
      {
        id: "rail-low", type: "line", source: "network", maxzoom: 9,
        layout: { "line-join": "round" },
        paint: {
          "line-color": ["interpolate", ["linear"], ["zoom"], 5, M["rail-far"], 9, M.rail],
          "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.55, 6, 0.75, 9, 1]
        }
      },
      {
        id: "rail", type: "line", source: "omt", "source-layer": "transportation", minzoom: 9,
        filter: ["all", LINE, ["==", ["get", "class"], "rail"], ["!", ["has", "service"]]],
        layout: { "line-join": "round" },
        paint: {
          "line-color": ["interpolate", ["linear"], ["zoom"], 5, M["rail-far"], 11, M.rail],
          "line-width": ["interpolate", ["exponential", 1.3], ["zoom"], 9, 0.9, 12, 1.4, 16, 2.6, 19, 5]
        }
      },
      {
        id: "water-name", type: "symbol", source: "omt", "source-layer": "water_name", minzoom: 6, filter: LINE,
        layout: { "symbol-placement": "line", "text-field": NAME, "text-font": FONT, "text-size": 11, "symbol-spacing": 500 },
        paint: labelPaint
      },
      {
        id: "road-ref", type: "symbol", source: "omt", "source-layer": "transportation_name", minzoom: 9,
        filter: ["all", LINE, ["==", ["get", "class"], "motorway"]],
        layout: { "symbol-placement": "line", "text-field": ["to-string", ["get", "ref"]], "text-font": FONT, "text-size": 10, "symbol-spacing": 400, "text-rotation-alignment": "viewport" },
        paint: labelPaint
      },
      {
        id: "poi-station", type: "symbol", source: "omt", "source-layer": "poi", minzoom: 11.5,
        filter: ["all", POINT, ["==", ["get", "class"], "railway"], ["==", ["get", "subclass"], "station"]],
        layout: { "text-field": NAME, "text-font": FONT, "text-size": 11, "text-anchor": "top", "text-offset": [0, 0.6], "text-max-width": 8 },
        paint: labelPaint
      },
      {
        id: "place-other", type: "symbol", source: "omt", "source-layer": "place", minzoom: 11, maxzoom: 15,
        filter: ["all", POINT, cls("suburb", "neighbourhood", "hamlet", "village")],
        layout: { "text-field": NAME, "text-font": FONT, "text-size": 11, "text-max-width": 8 },
        paint: labelPaint
      },
      {
        id: "place-town", type: "symbol", source: "omt", "source-layer": "place", minzoom: 7, maxzoom: 14,
        filter: ["all", POINT, ["==", ["get", "class"], "town"]],
        layout: { "text-field": NAME, "text-font": FONT, "text-size": ["interpolate", ["linear"], ["zoom"], 7, 10, 12, 13], "text-max-width": 8 },
        paint: labelPaint
      },
      {
        id: "place-city", type: "symbol", source: "omt", "source-layer": "place", minzoom: 4, maxzoom: 15,
        filter: ["all", POINT, ["==", ["get", "class"], "city"]],
        layout: {
          "text-field": NAME, "text-font": FONT, "text-max-width": 8,
          "text-size": ["interpolate", ["linear"], ["zoom"], 4, 10, 8, 13, 12, 16],
          "symbol-sort-key": ["get", "rank"]
        },
        paint: Object.assign({}, labelPaint, { "text-color": M.label })
      },
      {
        id: "place-state", type: "symbol", source: "omt", "source-layer": "place", minzoom: 6.4, maxzoom: 9,
        filter: ["all", POINT, ["==", ["get", "class"], "state"]],
        layout: { "text-field": NAME, "text-font": FONT, "text-size": 11, "text-max-width": 7, "text-letter-spacing": 0.04 },
        paint: Object.assign({}, labelPaint, { "text-color": M.label, "text-opacity": 0.7 })
      },
      {
        id: "place-country", type: "symbol", source: "omt", "source-layer": "place", maxzoom: 7,
        filter: ["all", POINT, ["==", ["get", "class"], "country"]],
        layout: { "text-field": NAME, "text-font": FONT, "text-size": ["interpolate", ["linear"], ["zoom"], 2, 11, 6, 14], "text-letter-spacing": 0.06 },
        paint: Object.assign({}, labelPaint, { "text-color": M.label })
      },

      {
        id: "route-past", type: "line", source: "route-past",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": M.past, "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1.5, 12, 3] }
      },
      {
        id: "route-ahead-casing", type: "line", source: "route-ahead",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": M.land, "line-width": ["interpolate", ["linear"], ["zoom"], 4, 4.5, 12, 8], "line-opacity": 0.9 }
      },
      {
        id: "route-ahead", type: "line", source: "route-ahead",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": P.accent, "line-width": ["interpolate", ["linear"], ["zoom"], 4, 2, 12, 4] }
      },
      {
        id: "stops-circle", type: "circle", source: "stops", minzoom: 4,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 2, 12, 5],
          "circle-color": ["case", ["get", "passed"], M["stop-past"], P.accent],
          "circle-stroke-color": M.land,
          "circle-stroke-width": 1.5
        }
      },
      {
        id: "stops-label", type: "symbol", source: "stops", minzoom: 6.8,
        layout: {
          "text-field": ["get", "short"], "text-font": FONT, "text-size": 12, "text-anchor": "left",
          "text-offset": [0.9, 0], "text-optional": true
        },
        paint: { "text-color": P.ink, "text-halo-color": M.land, "text-halo-width": 2, "text-halo-blur": 0 }
      },

      {
        id: "trains-circle", type: "circle", source: "trains", maxzoom: 10.6,
        filter: trainFilter(S.enabled),
        layout: { "circle-sort-key": SORT },
        paint: {
          "circle-radius": [
            "interpolate", ["linear"], ["zoom"],
            4, ["match", ["get", "k"], ["hsr", "ld", "night"], 1.7, 1.3],
            6, ["match", ["get", "k"], ["hsr", "ld", "night"], 2.9, 2.2],
            9, ["match", ["get", "k"], ["hsr", "ld", "night"], 3.6, 3]
          ],
          "circle-color": colorExpr(P, S.mode),
          "circle-opacity": ["interpolate", ["linear"], ["zoom"], 9.6, ["case", ["get", "foreign"], P.foreignA, 1], 10.6, 0],
          "circle-stroke-color": M.land,
          "circle-stroke-width": 0.6,
          "circle-stroke-opacity": ["interpolate", ["linear"], ["zoom"], 9.6, 1, 10.6, 0]
        }
      },
      {
        id: "trains-arrow", type: "symbol", source: "trains", minzoom: 9.6,
        filter: trainFilter(S.enabled),
        layout: {
          "icon-image": "arrow",
          "icon-size": ["interpolate", ["linear"], ["zoom"], 9.6, 0.32, 12, 0.6, 15, 0.85],
          "icon-rotate": ["get", "bearing"],
          "icon-rotation-alignment": "map",
          "icon-pitch-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "symbol-sort-key": SORT
        },
        paint: {
          "icon-color": colorExpr(P, S.mode),
          "icon-opacity": ["interpolate", ["linear"], ["zoom"], 9.6, 0, 10.6, ["case", ["get", "foreign"], P.foreignA, 1]],
          "icon-halo-color": M.land,
          "icon-halo-width": 1.2,
          "icon-halo-blur": 0
        }
      },

      {
        id: "sel-pulse", type: "circle", source: "selected",
        paint: { "circle-radius": 8, "circle-color": P.accent, "circle-opacity": 0, "circle-stroke-color": P.accent, "circle-stroke-width": 2, "circle-stroke-opacity": 0 }
      },
      {
        id: "sel-ring", type: "circle", source: "selected",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 8, 10, 12, 13, 19],
          "circle-color": M.land, "circle-opacity": 0,
          "circle-stroke-color": P.accent, "circle-stroke-width": 1.5
        }
      },
      {
        id: "sel-dot", type: "circle", source: "selected", maxzoom: 11,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 4, 10, 5.5],
          "circle-color": P.accent,
          "circle-stroke-color": P.ink, "circle-stroke-width": 1.5,
          "circle-opacity": ["interpolate", ["linear"], ["zoom"], 10, 1, 11, 0],
          "circle-stroke-opacity": ["interpolate", ["linear"], ["zoom"], 10, 1, 11, 0]
        }
      },
      {
        id: "sel-arrow", type: "symbol", source: "selected", minzoom: 10,
        layout: {
          "icon-image": "arrow", "icon-size": ["interpolate", ["linear"], ["zoom"], 10, 0.5, 13, 0.85, 16, 1.1],
          "icon-rotate": ["get", "bearing"], "icon-rotation-alignment": "map", "icon-pitch-alignment": "map",
          "icon-allow-overlap": true, "icon-ignore-placement": true
        },
        paint: {
          "icon-color": P.accent, "icon-halo-color": P.ink, "icon-halo-width": 1.2, "icon-halo-blur": 0,
          "icon-opacity": ["interpolate", ["linear"], ["zoom"], 10, 0, 11, 1]
        }
      },
      {
        id: "sel-label", type: "symbol", source: "selected", minzoom: 3,
        layout: {
          "text-field": ["get", "line"], "text-font": FONT, "text-size": 13, "text-anchor": "left",
          "text-offset": ["interpolate", ["linear"], ["zoom"], 3, ["literal", [1.1, -0.9]], 13, ["literal", [1.9, -1.2]]],
          "text-allow-overlap": true, "text-ignore-placement": true
        },
        paint: { "text-color": P.accent, "text-halo-color": M.land, "text-halo-width": 2.2, "text-halo-blur": 0 }
      }
    ];

    return {
      version: 8,
      glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
      sources: {
        omt: { type: "vector", url: "https://tiles.openfreemap.org/planet" },
        mask: { type: "geojson", data: S.data.mask },
        trains: { type: "geojson", data: S.data.trains },
        selected: { type: "geojson", data: S.data.selected },
        "route-past": { type: "geojson", data: S.data.routePast },
        "route-ahead": { type: "geojson", data: S.data.routeAhead },
        stops: { type: "geojson", data: S.data.stops },
        network: { type: "geojson", data: S.data.network }
      },
      layers
    };
  }

  window.NF = { buildStyle, readPalette, colorExpr, trainFilter, CATS };
})();
