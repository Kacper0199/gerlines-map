# Screenshots

How the screenshots in the README and the docs are planned, captured and licensed. The capture script is
`scripts/screenshots/capture.sh`; it drives `playwright-cli` (the Playwright command line client) against a
local dev server and never touches a public site.

## Capture

Prerequisites: the setup in [development.md](development.md) and `playwright-cli` on `PATH`.

1. Start a replay of a render and the dev server in front of it (`live replay` in
   [development.md](development.md), section Live engine):

   ```bash
   LIVE_PROXY_TARGET=http://127.0.0.1:8788 pnpm --filter @gerlines/web dev --port 5191 --strictPort
   ```

   To check the train card, search or journeys too, point `DETAIL_PROXY_TARGET` at a server that answers `/api/v1`
   (`apps/api` with the live engine, or `tools/load/api-replay.ts` over a replay database):

   ```bash
   DETAIL_PROXY_TARGET=http://127.0.0.1:8815 LIVE_PROXY_TARGET=http://127.0.0.1:8788 pnpm --filter @gerlines/web dev --port 5191 --strictPort
   ```

   While `DETAIL_PROXY_TARGET` is set, the dev server forwards every `/api/v1` request to it and its own `/api/` plugin
   answers only the paths outside `/api/v1`. Unset, the plugin answers all of `/api/` from the environment, and the
   detail and status routes report not configured (503).

   Without a live engine the map draws no trains. The shots 09 and 10 select the train whose frame key is in
   `TRAIN_KEY`, through the dev hook `window.gerlinesCheck.showTrain` (section Photographing one train) at zoom 11;
   find a key alive at the replay time with `node apps/web/scripts/find-trips.ts` (step 2 there). Without `TRAIN_KEY`,
   or when the train is not in the frames, the two shots are taken with no train selected and the shot line says why.

2. Run the script from any folder (playwright-cli writes its `.playwright-cli/` log folder there):

   ```bash
   BASE_URL=http://127.0.0.1:5191 OUT_DIR="$PWD/shots" bash scripts/screenshots/capture.sh all
   TRAIN_KEY=25279342 BASE_URL=http://127.0.0.1:5191 OUT_DIR="$PWD/shots" bash scripts/screenshots/capture.sh 09,10
   ```

   The script prints one JSON line per shot with its file, address, the selected train and any console errors.

| Variable | Default | Meaning |
| --- | --- | --- |
| first argument | `all` | shot ids or id prefixes, comma separated |
| `BASE_URL` | `http://127.0.0.1:5173` | the dev server; only `127.0.0.1` and `localhost` are accepted |
| `OUT_DIR` | `raw/screenshots/docs` | output folder, created when missing |
| `PREFIX` | `docs` | file name prefix: `<PREFIX>-<shot id>.png` |
| `SETTLE_MS` | `6000` | wait after the view is set, before the tiles are awaited |
| `SESSION` | `docs-shots` | playwright-cli session name |
| `TRAIN_KEY` | none | frame key of the train the shots 09 and 10 select |

Each shot opens a fresh browser context with its own viewport, device scale and touch setting, so no theme or
language stored by one shot leaks into the next. Reduced motion is on, so camera moves are instant. The map shots use
the development hooks `window.gerlines` (`select`, `focusLand`, `mapStyle`, `terrain3d`) and `window.gerlinesMap`,
which exist only in the dev server. To add a shot, add a row to `SHOTS` in `scripts/screenshots/capture.js`.
`node --test scripts/screenshots/capture.test.mjs` runs the script against a fake browser: every shot is taken, with
or without a train.

## Photographing one train (dev only)

`window.gerlinesStore` (the app store, to read the route stops and the profile in a check) is installed in the same place, under
`import.meta.env.DEV`, and a test (`apps/web/test/production-bundle.test.ts`) fails when a production bundle of `MapView`
contains it or `gerlinesCheck`. `gerlinesMap` and `gerlinesLive` stay behind `?probe`.

For a visual review of a train's cars and livery the dev server has `window.gerlinesCheck.showTrain(trip, view)`
(`apps/web/src/map/check-hook.ts`, installed in `MapView.tsx` under `import.meta.env.DEV`, so it is not in any
production build and not behind `?probe`). It works without the detail API and does what the card's Follow does, but
from the trip key:

1. Start a replay and the dev server (`pnpm --filter @gerlines/web dev --port <port>` with the live proxy pointed at the
   replay, as in [development.md](development.md)); the forge build must exist (`pnpm --filter @gerlines/trainforge build`).
2. Find a trip alive at the replay time: `node apps/web/scripts/find-trips.ts data/live/<run> --series 422 --operator nrw
   --line '^S1$' --sequence <keyframe near the replay time>` prints key, line, train number, series, operator, units and
   category of each match (no `--sequence`: the newest keyframe of the run, where most trips of the hour have ended).
3. In the browser session (`playwright-cli -s=<name> run-code`), call the hook and then take the picture:

   ```js
   await page.evaluate(() => window.gerlinesCheck.showTrain(25279342, { zoom: 17, pitch: 0, bearing: 0 }));
   ```

   `view` is `{ zoom = 17, pitch = 0, bearing = 0, timeoutMs = 15000, release = false }`; the selected train's roof band is
   drawn amber, so pass `release: true` to drop the selection after framing (the band then shows the colour mode, follow
   ends and the train drifts out of the view within seconds, so take the picture at once); pitch above 0 needs the Terrain style with 3D
   terrain. The call selects the train again (so the camera flies even when it was selected before), follows it, waits
   for the flight to end, jumps to the view and returns `{ found, key, lon, lat, zoom, cars }` after the 0.3 s blend.
   `cars` is `drawn` (cars on screen), `placed` (cars placed, a mesh still loading) or `chevron`; `found: false` means
   the train never appeared in a frame (its trip ended or is not in the replay). A train is a chevron at z17 while it
   waits at its first stop or has not yet moved one consist length (ADR-0012), so a `chevron` result there is the rule
   and not a missing model.
4. Clip the screenshot around the viewport centre, where follow keeps the train.

## Licences of what a screenshot shows

A screenshot of the map is a produced work of several sources. Keep the attribution box visible in every map shot,
never crop it out, and annotate committed images in `REUSE.toml`.

| Layer in the image | Source | What the image needs |
| --- | --- | --- |
| Basemap vectors (roads, places, water, landuse) | OpenStreetMap via OpenFreeMap tiles, OpenMapTiles schema | "© OpenStreetMap contributors" (ODbL produced work), OpenFreeMap and OpenMapTiles credit |
| Map style | GerLines style built on OpenFreeMap and Positron work | covered by the style annotation in `REUSE.toml` (AGPL-3.0, MIT, BSD-3-Clause, CC BY 4.0) |
| Satellite imagery | VersaTiles: orthophotos of the Land survey offices, modified Copernicus Sentinel data | credit each provider as the attribution box does; check the VersaTiles sources page before publishing shot 10 |
| Terrain and hillshade | Mapterhorn | CC BY 4.0 and the source licences from mapterhorn.com/attribution |
| Germany mask, Länder borders | BKG VG250 | DL-DE BY 2.0 "© GeoBasis-DE / BKG (2026)", changed |
| Trains and timetable text | DELFI through Transitous, the traines mirror and gtfs.de | CC BY 4.0 (timetable) and CC BY-SA 4.0 (realtime): images with trains are CC BY-SA 4.0 AND ODbL-1.0 |
| Vehicle photos, operator logos | Wikimedia Commons, operators | the photo credit must stay in the image, and logos stay out of the README hero (trademarks) |

Images for the repository: PNG at 1440 by 900 (the two model images are cropped to 1008 by 630) with every metadata
chunk stripped. Animations are GIF files of at most 8 MB.
The PNGs of a capture run stay in `raw/` (git-ignored).

## Images in the README

The images and animations in `docs/images/` were taken on the development server in front of a replay of recorded
feeds, not on a public deployment. The clock in the live bar is the replay's clock. Each map image keeps its
attribution box.

| File | What it shows | Theme, locale |
| --- | --- | --- |
| `overview-dark.png` | all of Germany, every train coloured by category, legend with counts | dark, EN |
| `land-focus-polish.png` | focus on Bavaria, every train still drawn | dark, PL |
| `selected-train-route.png` | a selected high speed train with its whole route drawn along the track | dark, EN |
| `train-card-german.png` | the train card of a delayed ICE near Köln with its next stop and speed estimate | dark, DE |
| `station-card-german.png` | the card of Wuppertal Hbf with its lines | light, DE |
| `delay-mode-frankfurt.png` | trains around Frankfurt as heading arrows, coloured by delay | dark, EN |
| `operator-mode-frankfurt.png` | the same view coloured by operator group | dark, EN |
| `playback-light.png` | playback of a past hour with the scrubber open | light, EN |
| `satellite-koeln.png` | Köln Hbf and the Hohenzollern bridge in the satellite style with 3D cars | satellite, EN |
| `cars-koeln-hbf.png` | trains drawn as 3D cars on their platform tracks at Köln Hbf | dark, EN |
| `cars-closeup-1.png`, `cars-closeup-2.png` | one train as 3D cars at zoom 18, captured at twice the pixel density | dark and light, EN |
| `terrain-moselle.png` | the Moselle valley at Cochem in the terrain style with 3D relief, delay colours | terrain, EN |
| `statistics.png` | the statistics panel for Germany on one day | dark, EN |
| `statistics-charts.png` | three crops of the statistics panel side by side: the charts for Germany, one train, and the light theme | dark and light, EN |
| `journey-planner.png` | a journey from Berlin Hbf to München Hbf drawn on the map | dark, EN |
| `timelapse-germany.gif` | about three hours of a Sunday afternoon at 120 times the speed, one screenshot per 56 s of replay time | dark, EN |
| `zoom-levels.gif` | one zoom from the national view into Köln Hbf, captured frame by frame | dark, EN |
| `select-flight.gif` | a train is clicked, the camera flies to it and the route ahead is drawn | dark, EN |
| `cars-3d.gif` | 3D cars at Köln Hbf at three times the speed, the camera following a departing train | dark, EN |
| `model-*.png` | renders of single train models in the model preview (`pnpm --filter @gerlines/trainforge preview`) | dark and light |

The model images show no map and no timetable data. They carry the lettering and logos the livery rules give a
train; those are trademarks of their owners and are shown only to describe the train (see the notice in
the README). The preview draws a logo with every livery, while the map hides it for operators outside the group it
belongs to.
