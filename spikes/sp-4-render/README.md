# SP-4 render performance spike

Measures whether MapLibre GL JS 6.15 plus deck.gl 9.4 with a motion worker holds the frame budgets of
`docs/architecture.md` section 11 with 15,000 trains and all four levels of detail of section 8.2. It is a
spike, not product code: private workspace member, not part of the app. CI lints, type-checks and tests it
(`turbo run lint typecheck test`), which catches deck.gl and MapLibre API drift; CI does not build it, and the
measurements are manual.

Raw per-scenario results are in `results/`.

## What it renders

- Basemap: the dark style of design direction B (`src/basemap-style.json`, OpenFreeMap vector tiles, Germany
  mask) plus optional Mapterhorn terrain, hillshade and a `fill-extrusion` building layer from zoom 14.5.
- 15,000 synthetic trains on 1,852 real rail segment polylines (`fixtures/rail-segments.json.gz`, built from the
  Transitous `map/trips` snapshot of 2026-10-23 with `scripts/build-fixture.mjs`). Each train shuttles along its
  segment (forward shape, dwell, reversed shape) with a trapezoid speed profile fitted to the realtime duration
  and the catch-up controller of architecture section 8.1. Phases are random, so 15,000 trains share 1,852 shapes.
  The fixture has 114,465 points, 61.8 per shape on average (median 25). **Known limit:** 30 of the 1,852 segments are
  two-point chords and 27 are three-point chords (`build-fixture.mjs` keeps polylines of two or more points), so trains on
  those segments run on straight lines, which ADR-0001 forbids in the product; the product must reject such shapes.
- **Fixture change after the spike (2026-11-05):** the results in `results/` were measured on the first
  fixture of 2,654 segments (195,300 points, 73.6 per shape, median 27), which also held 802 segments of neighbouring
  countries' feeds whose licences could not be confirmed. The committed fixture keeps only the DELFI, VBB, KVV and VBN
  feeds, so a rerun is not directly comparable with the committed results.
- Worker (`src/worker/motion.worker.ts`, kernel in `src/scene.ts`): advances every train each frame, culls to the
  viewport plus 20 percent and writes transferable typed arrays, recycled between frames.
- Four tiers, all fed with binary attributes: `dots` (ScatterplotLayer), `icons` (IconLayer), `slices` (PathLayer in
  metres, 250 m of track behind the train), `cars` (SimpleMeshLayer, 10 box cars per train placed by two bogie
  points, one 12 float model matrix per car computed in the worker).

## Run it

```bash
export PATH="$HOME/.nvm/versions/node/v24.22.1/bin:$PATH"
pnpm install
pnpm --filter @gerlines/sp-4-render dev          # then open /?zoom=16&tiers=cars&trains=15000&focus=300
```

Query parameters of the manual view: `zoom`, `lon`, `lat`, `pitch`, `bearing`, `tiers` (comma list of `dots`,
`icons`, `slices`, `cars`), `trains`, `focus` (trains forced through the view centre), `terrain=1`, `buildings=1`.

## Reproduce the numbers

One command per matrix group, run from this folder (needs `playwright-cli` on the PATH and network access to
`tiles.openfreemap.org` and `tiles.mapterhorn.com`). `scripts/measure.sh` has not been run end to end; the
same steps were run by hand, see below. `pnpm measure <group>` should pass the group through but is unverified.
`measure.sh` builds the app, starts `vite preview` on 127.0.0.1 with the results sink enabled and a fresh random
token, and passes the token to the page:

```bash
bash scripts/measure.sh main        # 16 scenarios, desktop and phone
bash scripts/measure.sh map-only    # the same 16 without trains, map repainting every frame
bash scripts/measure.sh sweep       # tier against zoom, 30 scenarios
bash scripts/measure.sh dense       # 300 trains forced into the close view
bash scripts/measure.sh stress      # 30k to 120k dots, up to 24,000 cars
bash scripts/measure.sh zoom-sweep  # zoom 6 to 17 in 66 s with automatic tiers and crossfade
```

`SP4_REPS` (repetitions per scenario), `SP4_FIRST` (first repetition number), `SP4_ENV` (`desktop` or `phone`),
`SP4_ONLY` (substring of the scenario id) and `SP4_SESSION` narrow or repeat a run. Each scenario writes
`results/<group>.<env>.<scenario>.r<n>.ndjson`; `node scripts/summarize.mjs <group>` prints the table with map draws per second, data updates per second, round trip, advance and emit time and upload size per frame. Results recorded before the draw counter existed show GPU timer samples per second in the draws column, which equal map draws.

The script opens the page in a playwright-cli session and runs `scripts/run-scenarios.js` through `run-code`.
The same steps, one by one:

```bash
export SP4_RESULTS_SINK=1 SP4_SINK_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
pnpm build
pnpm exec vite preview --host 127.0.0.1 --port 0 --strictPort      # in the background, read the port from its first line
playwright-cli -s=sp-4 open "http://127.0.0.1:<port>/?run=main&reps=1&first=1&tag=main&sinkToken=$SP4_SINK_TOKEN"
playwright-cli -s=sp-4 --raw run-code --filename=scripts/run-scenarios.js
```

### Results sink

The runner saves each result through `POST /__results/<name>` on the dev or preview server. The route exists only
when `SP4_RESULTS_SINK=1`; without the flag it answers 404. With the flag it requires the token in the
`x-sp4-token` header (`SP4_SINK_TOKEN`, at least 32 characters; a random one is printed when the variable is unset),
rejects any `Sec-Fetch-Site` other than `same-origin`, accepts only names matching
`^[A-Za-z0-9][A-Za-z0-9._-]*\.ndjson$`, caps a body at 1 MB (413) and never overwrites an existing file (409), so
a rerun needs a new `tag` or `first`. The runner throws and stops when a save fails. Keep the server on `127.0.0.1`:
never combine `--host 0.0.0.0` (or any LAN address) with the sink enabled. For a real phone over the LAN, run the
server without `SP4_RESULTS_SINK`; the sink then does not exist and the phone only displays the scene.

## How a scenario is measured

`scripts/run-scenarios.js` sets the environment through CDP (`Emulation.setDeviceMetricsOverride`, and for the
phone profile 390 by 844 at device pixel ratio 3 with `Emulation.setCPUThrottlingRate` 4) and reloads the page when
the environment changes (not before every scenario, so the worker, the tile cache and the heap carry over from one
scenario to the next). CDP throttling does not reach the motion worker, so in the phone profile the worker
busy-waits `(slowdown - 1)` times its measured first pass, which makes the phone worker time a lower bound. Each
scenario then calls `window.sp4.prepare(spec)` (camera, terrain, buildings, worker, tile wait, 8 s warm-up), collects garbage,
reads CDP `Performance.getMetrics` and `SystemInfo.getProcessInfo`, calls `window.sp4.measure(30000)` and reads
the same counters again.

| Metric | Source |
| --- | --- |
| frame time p50, p95, p99, max, frames over 20, 34 and 50 ms | rAF delta probe (`src/probe.ts`); Chromium locks rAF at 60 Hz, so this is not the draw rate |
| map draws per second | MapLibre `render` events counted in the window (`src/draws.ts`); with a static camera this equals the rate at which trains move |
| long tasks | `PerformanceObserver` type `longtask` |
| main thread busy, script, layout and style share | CDP `Performance.getMetrics` deltas |
| GPU time per map draw | `EXT_disjoint_timer_query_webgl2` from the first style layer to the last (`src/gpu-timer.ts`): the translucent pass of the draw, which includes the deck.gl train layers; it misses the clear, the sky, terrain depth and the offscreen pass, and the opaque pass on flat maps, so basemap baselines read low |
| GPU, renderer and browser process CPU | CDP `SystemInfo.getProcessInfo` deltas |
| worker time per frame (advance, select, emit), data updates per second, round trip, upload size per frame | `performance.now()` inside the worker and in `src/train-renderer.ts`; advance, select and emit are scaled by the slowdown factor, the total is measured |
| JS heap (live after GC) | CDP `Runtime.getHeapUsage` |

GPU memory is not exposed by Chromium; per-frame upload size is reported instead.

## Development

```bash
pnpm --filter @gerlines/sp-4-render lint
pnpm --filter @gerlines/sp-4-render typecheck
pnpm --filter @gerlines/sp-4-render test      # polyline, statistics, motion kernel, draw counter, sink, GPU timer, tier plan
node scripts/build-fixture.mjs <absolute path to map-trips-de.json.gz>   # rebuild the fixture
```

## Data and licences

`fixtures/rail-segments.json.gz` is derived from Transitous (MOTIS) responses over the DELFI (timetable CC BY 4.0,
realtime CC BY-SA 4.0), VBB (CC BY 4.0), KVV (CC0 1.0) and VBN (CC BY-SA 4.0) feeds, with segment geometry that MOTIS
routes on OpenStreetMap (ODbL 1.0); the exact labels are in `REUSE.toml`. It is used as test input for this spike only.
`public/geo/germany-*.geojson` is Natural Earth (public domain). The basemap style derives from the OpenFreeMap styles (MIT) over OpenMapTiles and OpenStreetMap data (ODbL).
