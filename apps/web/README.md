# @gerlines/web

The web client of GerLines: the Fahrplan shell from `DESIGN.md` built on `@gerlines/ui` (tokens, fonts, components) and
`@gerlines/i18n` (messages), a MapLibre GL JS 6 basemap with deck.gl 9.4 train layers in interleaved mode, and a Web Worker that
moves every train of our live engine along its own track shape (section Our own trains). The map stack loads lazily: the shell
(React, the design system, the entry messages) is the initial JavaScript and `components/MapView.tsx` pulls MapLibre, deck.gl
and the worker in right after it; the statistics panel, the planner, the legal pages and their messages load on first use
(initial scripts 228 kB gzip; tooltips, popovers and the schema library load on first use, so the 12 files of the shell are 185.7 kB gzip with the style, `node scripts/entry-size.mjs` after a build prints them).

## Run it

```bash
pnpm --filter @gerlines/web dev            # one Vite server, the API runs inside it under /api
```

The dev server mounts `@gerlines/api` (Hono) as middleware, so the browser talks to one origin; the trains come from our
live engine through `/live/v1` (section Our own trains). Without a live engine behind the page the map draws no trains and
the live bar says No live server is running.

| Variable | Meaning |
| --- | --- |
| `APP_NAME`, `APP_CONTACT` | build the `User-Agent` of the API's outbound requests (`gerlines/<version> (+<contact>)`) |
| `LIVE_PROXY_TARGET` | a `live run` or `live replay` server that `/live`, `/replay` and `/playback` are forwarded to |
| `VITE_USE_POLLING` | `1` makes Vite poll files; needed where file events are not delivered (some sandboxes and network drives) |

The dev server reads `.env` from the repository root when it exists and hands the API only `APP_NAME`, `APP_CONTACT` and the
`SEARCH_`, `ROUTER_`, `STATS_`, `PHOTO_DIR` and `VEHICLE_DATABASE_URL` settings; nothing else from the file reaches the Vite
process.

Add `?theme=light` to the address for the light theme (dark is the default); the choice made with the style picker is kept in local
storage (`gerlines-theme`) and the address wins over it. `?lang=de` or `?lang=pl` starts in that language. Both address parameters apply to that visit only and
never overwrite what the visitor stored; only the language switch and the style picker store a choice. In the dev server
`window.gerlines.select(id)` selects a train by its frame key (`live:<key>`) or its trip instance from the console or a
playwright script.

## Search and links (WP-4.7)

The search field of the shell asks `GET /api/v1/search` (the Vite dev server mounts it when `SEARCH_DATABASE_URL` is set,
also `SEARCH_PLACES_FILE`; see `apps/api`). It is a combobox: arrow keys move through the grouped results, Enter picks
the active one or the first, Escape closes the list and then clears the field, `/` focuses it from anywhere. A train
opens its card, a station its station card with an amber pin and a flight, a line fits its stops, a Land takes the Land
focus (with a chip under the search card to leave it) and a town flies to its centre.

The address holds the view: `train=<trip instance>` or `station=<stop place>`, `land=DE-XX` and `map=<zoom>,<lat>,<lon>`,
next to the visit settings (`lang`, `theme` and the development parameters), which it leaves alone. A new selection is a
new history entry, so Back returns to the one before; camera moves replace the current entry once the map rests. A link
or Back and Forward restore the entry: a train opens its card, a station loads from `GET /api/v1/stations/{id}`, the
camera jumps on load and eases on Back. A train picked on the map is written by its trip instance, looked up from its
frame key through `GET /api/v1/live/keys/{key}`.

End-to-end check (dev server on 5847 with search configured):

```bash
node e2e/deep-link.mjs http://127.0.0.1:5847 4eda9b92-2ddf-5610-b59b-ed665a8b2610 /tmp/deep-link.js
playwright-cli -s=e2e run-code --filename=/tmp/deep-link.js   # returns passed and failed checks as JSON
```

`vite build` writes source maps on purpose: the repository is AGPL-3.0 and its sources are public.

## Colour modes

Train colours, in the search card, has three tabs: Category (the default), Delay and Operator, kept in local
storage and written by the worker into each train's colour (`modes/`, `live/frame-writer.ts`). The legend follows the
mode: category rows, six delay classes, or the operator groups with their counts and hide toggles; in the Delay and
Operator modes the category toggles sit under Show on the map. The Operator mode reads each train's catalogue operator from the frame and
its group from `modes/operator-groups.generated.ts`, built from `catalog/operators.yaml` by
`pnpm --filter @gerlines/web operator-groups` (the rule in `modes/operator-group-rules.ts`, the coloured groups in
`modes/operator-group-list.ts`, the colours in `modes/operator-colours.ts`); `modes/operator-groups.test.ts` fails when
the table is stale. Hiding a group acts only in the Operator mode and is not stored.

## Journey planner (WP-8.2)

Plan a journey (route icon) and Statistics (column chart icon) are a pair of icon buttons at the end of the search row
(`components/shell/PanelButtons.tsx`), on desktop and phone; they share one card slot (`state/panel-store.ts`), so at most
one is pressed, and a train or station picked on the map takes the slot until its card closes. Plan a journey opens the
planner (`src/journeys`): from and to through the station search, which answers each station's `stopId` (the DHID,
else the feed's own stop id) for the planner to send; a station without one is greyed out in the list,
depart at or arrive by a Berlin time, the kinds of trains and an operator, then five journeys with Earlier and Later.
The chosen journey's legs are drawn as their MOTIS route lines in the category colours, below the trains, and the camera
fits them; each journey shows the punctuality of its weakest train over the last 30 days
(`GET /api/v1/journeys/reliability`) or why it is missing. The Vite dev server mounts journeys when `ROUTER_BASE_URL`
is set and the punctuality when `STATS_DATABASE_URL` is set (both read only), as it does search.

The address holds the planner next to the view: `plan=1`, `jfrom` and `jto` (stop place ids), `jtime` (Berlin wall clock,
`2026-11-10T07:00`), `jarr=1`, `jcat` (a comma list when not every kind is chosen), `jop` and `jsel` (the shown journey).
Opening, closing and each search are history entries, picking another journey replaces the entry; a link runs the
search again and shows the named journey when it is still found. A planner set aside by the statistics keeps its `j`
parameters without `plan=1` and comes back with its results; closing it with its own button forgets them. The
punctuality shows a share only from 5 recorded runs, else the run count and that it is too few to rate.

## Our own trains (live frames)

The live worker starts as soon as the shell is up (`live/early-start.ts`, called from `main.tsx`), before the map code has arrived: it reads the head and the keyframe while the map stack downloads and holds the shape packs (`holdPacks`, `ShapeStore.resume()`). `TrainMap` takes that worker over, and when the map has loaded it sends `release-packs`. Without an early worker (the hook is not called in a test, or the device has no WebGL 2) `TrainMap` creates its own and starts it as before. The early worker follows the tab's visibility until the map takes it, is stopped when the map fails to start (`abandonEarlyWorker`, from the map's error boundary and the `TrainMap` construction) and after 60 s if nobody took it. Messages the worker posts before the map attaches its listener (the first statuses) are dropped, since worker events are not queued; the next poll sends them again.

The map draws the trains of our live engine (`services/live`, WP-3.2) by default: `live/live.worker.ts` follows the head
(`/live/v1/head`, polled every second), loads keyframes, deltas and shape packs (`/live/v1/k/<n>.bin`, `d/<n>.bin`,
`s/<epoch>/<id>.bin`), keeps every train in a `MotionFleet` of `@gerlines/geo` on its own shape and writes longitude and
latitude (Float64) per frame, so a train is always on its track.

| Address parameter | Meaning |
| --- | --- |
| `?live=<path or url>` | base of the live objects, default `/live/v1` (another server needs CORS; the live app sends `*`) |
| `?replay=<speed>` | the server replays recorded frames at that many plan seconds per second (data shows as recorded) |
| `?probe=1` | in a build, expose `window.gerlinesMap`, `window.gerlines` and `window.gerlinesLive` as the dev server does |

`window.gerlinesLive.continuity("start", share)` starts the server's continuity metric (jumps, stalls, backward steps,
swaps drawn visible, overspeed, off-track) on the frames the worker really draws, for a share of the trains;
`continuity("report")` returns the counts and `continuity("stop")` ends it. `window.gerlinesLive.diagnostics()` returns the
worker counters (trains, shapes, bytes, tick and follow times).

Local replay with no database, over a render of `services/live` (see its `replay` command):

```bash
cd services/live && node src/cli.ts replay --out ../../data/live/r2x --packs ../../data/live/packs-t102/v1 \
  --report ../../data/live/evidence-s11/r2x.json --speed 10 --start 2026-10-25T16:00:00Z --loop --port 5822
cd apps/web && LIVE_PROXY_TARGET=http://127.0.0.1:5822 npx vite --host 127.0.0.1 --port 5821   # then open /?replay=10
```

The packs must be those of the render's shape epoch (`shapeEpoch` in its report): `r2x` is a render of epoch 3 and
goes with `packs-t102`; a render of epoch 4 goes with `packs-t116` (`services/live` part of
`docs/development.md`, Shape epochs and packs).

`LIVE_PROXY_TARGET` makes the dev and preview servers forward `/live` and `/replay` to that server, so the page stays on one
origin. The replay serves no detail API: `DETAIL_PROXY_TARGET` forwards `/api/v1` to a server that answers
`/api/v1/live/keys/{key}` and `/api/v1/trains/{id}` (`apps/api` with the live engine behind it). The dev server's own `/api/`
plugin (search, journeys, photos and statistics from the environment) stands aside for `/api/v1` while
`DETAIL_PROXY_TARGET` is set, so `pnpm dev` and `vite preview` both reach that server.

A selected train looks its trip instance up by frame key and shows the train detail card: product and number from
`productName` (ICE 597), destination, next stop with time and delay, and Follow (the camera keeps the train until the map
is dragged), Route (the camera fits the route ahead) and Share (a link with `?train=<trip instance>` that selects the train
again on load). Without the detail (the lookup fails, retried every 5 s doubling to 1 min) the card shows what a frame
knows and says the stops are not available.

A head answered with a web page (`text/html`, Vite's fallback when no `LIVE_PROXY_TARGET` is set) means no live
server is behind the page: the map draws no trains and the live bar says No live server is running beside the zoom stage
line. A head answered 404 or 503 still means the server is there without
data (The data source does not answer).

## Playback of a past hour (WP-7.6b)

History in the live bar opens the timeline (`src/playback`, loaded on the first press): a day and an hour from the
windows `GET /playback/v1/windows` lists (hours it has not rendered are listed as no data and cannot be picked), then
play and pause, a speed of 1x, 2x, 5x, 10x, 30x or 60x, and a scrubber over the hour that seeks when released or after
a key press. While a playback runs the bar says Playback with the playback time and offers Back to live; the address
carries the moment as `?at=2026-10-25T12:20:00Z` (UTC to the second): a new history entry when a playback starts and
when it ends, the position replaced every three seconds, a link starts it, Back and Forward start, seek or stop it
(`playback-sync.ts`, D-057).

The worker plays it (`live/playback`): `PlaybackClock` is the virtual time and replaces the live plan clock while it
runs, live polling pauses, `driver.ts` takes the heads from the window's index (`headAt`, no head requests), follows the
head `max(15 s, 4 wall seconds)` of plan time ahead of the clock on the window's revision path with the frames warmed in
parallel, and `ScheduledChanges` applies each frame at its own time (no 5 s hold: a paused playback keeps its queue). A
seek or Back to live fades the trains out (160 ms, `dip.ts`), clears them, loads the keyframe and deltas to the instant
and fades them in; under reduced motion the fades and the fleet's own blends are cut. At the end of an hour the next
window's index (fetched 5 min or 20 wall seconds ahead, its first frames warmed) starts a new chain as a reload and the
fleet blends or crossfades the corrections of the cold engine start; with no next hour the clock stops at the end. A window
is refused (`epoch_mismatch`) when its shape epoch differs from its frames or its first shape's pack is not at
`/live/v1/s/<epoch>/`. A train picked in a playback gets the frame card (what the frames of that moment knew), not
today's detail. `status.dataTimeMs`, which the card and the bar read, is the playback time.

Development: serve rendered hours and their packs with `node src/cli.ts playback serve --cache DIR --packs DIR --now ISO`
(services/live) and start Vite with `LIVE_PROXY_TARGET` at it (`/playback` is proxied beside `/live`). End-to-end check:

```bash
node e2e/playback.mjs http://127.0.0.1:5817 /tmp/playback.js 2026-10-25T12:00:00Z
playwright-cli -s=e2e run-code --filename=/tmp/playback.js   # passed and failed checks as JSON
```

## Layout of `src`

| Folder | Role |
| --- | --- |
| `live/` | the live worker: plan clock, chain follower (keyframes and deltas), shape pack cache, the trains in a `MotionFleet`, the runtime, the continuity probe, the address parameters |
| `motion/` | pure motion code: polyline decoding, arc length tracks, the per trip controller, the engine that writes typed array frames (and leaves out the categories the legend hides), the worker runtime and client |
| `map/` | the basemap style builder (from the `@gerlines/ui` map tokens), the deck.gl layers, the imperative `TrainMap` (theme and category switches included) |
| `components/shell/` | the layout: desktop grid (search card, legend, style picker, language, live bar, zoom, attribution), phone shell with the layers popover, and their parts |
| `components/train/` | the train card (desktop card, phone bottom sheet), its route strip, the vehicle block with the photo, the forecast block (`forecast/`) and the speed row (`SpeedRow.tsx`: the selected train's plan speed from the worker) |
| `profile/` | the segment profile of the selected train (WP-7.4b): its legs on the map, the curtain in pitched views, the block and leg list in the card, the tooltip |
| `status/` | the data status popover of the live bar's status dot (WP-9.7a), loaded on the first press |
| `a11y/` | the skip link, focus return when a card or panel closes, the map canvas name, and the accessibility tests (WP-9.2, [docs/accessibility.md](../../docs/accessibility.md)) |
| `components/station/` | the station card |
| `cars/` | the 3D car layer: placement in the worker, the merged fleet layer, model choice by series (`catalog.ts`), livery per operator (`livery.ts`), model loading with retries |
| `map/terrain/` | the 3D relief: elevation factor, bridge deck line, deck windows, GPU tier and the stored 3D switches |
| `state/` | the selection and place stores, and the shared card slot of the panels (`panel-store.ts`, `panel-cards.ts`) |
| `stats/` | the statistics panel (WP-7.3), loaded on first press |
| `journeys/` | the journey planner (WP-8.2) and the journey layer on the map |
| `search/` | the search field, its client and result views (WP-4.7) |
| `legal/`, `credits/` | the pages `/sources`, `/privacy`, `/impressum` and `/credits`, each mounted from `main.tsx` without the map |
| `playback/` | the History control and timeline panel, the store, the hour list and the `?at=` address sync (WP-7.6b); the worker side is `live/playback/` |
| `modes/`, `url/` | colour modes (category, delay, operator group) and label modes with their stored choice, address parameters |
| `components/MapView.tsx`, `map-loader.ts`, `MapErrorBoundary.tsx` | the lazy map, and the boundary that keeps the shell and offers a reload when the map chunk or WebGL fails; React never sees per frame data |
| `startup.ts` | applies `?lang` (session only) and returns the starting theme before the first render |
| `theme/` | the train palette from the ui tokens and the stored theme choice; `styles/app.css` imports `@gerlines/ui/styles.css` |
| `hooks/` | `useMediaQuery` and the breakpoints (phone 640, compact 1100 wide or 860 high) |

## Checks

```bash
pnpm turbo run lint typecheck test --filter=@gerlines/web
```

Component tests run axe-core through `test/helpers/axe.ts`, with the rules that need a rendered page (colour contrast,
target size, links in text, scrollable regions, orientation lock) switched off, so a green run there is no contrast or target size result; the browser checks are in
[docs/accessibility.md](../../docs/accessibility.md).

The browser probes are `playwright-cli run-code` scripts in `scripts/` (`live-continuity-probe.js` runs the continuity metric on a 10x replay, see above); start the dev server, open its address (any port) in
the session, and the probes reload that same address.

```bash
playwright-cli -s=probe open http://127.0.0.1:5173/       # the address the dev server printed
playwright-cli -s=probe run-code --filename=apps/web/scripts/fps-probe.js         # 60 s of rAF frame times, long tasks, heap
playwright-cli -s=probe run-code --filename=apps/web/scripts/fps-probe-phone.js   # same, 390 by 844, DPR 3, CPU 4x slower
playwright-cli -s=probe run-code --filename=apps/web/scripts/motion-probe.js      # per frame displacement of every train
playwright-cli -s=probe run-code --filename=apps/web/scripts/fps-probe-pan.js     # 20 s of steady panning with 300 cars (settings at the top), main thread time
```

Run each emulating script in a fresh session: a device override from one run stays in the browser session.

`scripts/lcp-probe.js` measures the Largest Contentful Paint and the first drawn train on a throttled link (Slow 4G of the Lighthouse mobile profile or Fast 4G, CPU 4x, 412 by 915 at DPR 2.625, a new browser context per run). It needs no database: `scripts/delivery-server.mjs` serves a production build over HTTP/2 with the compression of the edge and answers the live objects, the API and the basemap from the WP-9.3 fixture.

```bash
GERLINES_TRAIN_MODELS=off pnpm --filter @gerlines/web exec vite build
ENCODING=precompressed node apps/web/scripts/delivery-server.mjs   # PORT 5193, FIXTURE_PORT 8813, PROTOCOL h2 or h1, ENCODING zstd3, zstd19, br11 or precompressed (the .br, .zst and .gz files of the build, as Caddy serves them)
playwright-cli -s=lcp open about:blank
playwright-cli -s=lcp run-code --filename=apps/web/scripts/lcp-probe.js   # profile, runs and wait at the top of the file
```
