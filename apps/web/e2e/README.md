# End-to-end and visual regression suite (WP-9.3)

`pnpm --filter @gerlines/web e2e` builds the web app (without 3D car models) and runs Playwright against it. It needs
no database, router, network or the private `data/` folder.

| Project | Viewport | Specs |
| --- | --- | --- |
| phone | 390x844 | select, shell, visual |
| tablet-portrait | 834x1194 | select, visual |
| tablet-landscape | 1194x834 | select |
| desktop | 1440x900 | select, shell, visual, deep-link, journeys, modes, terrain |
| large | 2560x1440 | select |

## What it runs against

One origin, `e2e/server/fixture-server.ts` (port 8818, `E2E_PORT`), serves the production build, the live objects, the
API answers and the basemap from `e2e/fixture/data`. `GET /__e2e/info` names the `dist` it serves (the fixture checks it,
so a stale server of another worktree fails the test) and `GET /__e2e/unmatched` lists the requests it had no answer for
(a missing glyph range or API route fails the test; a tile outside the extract only adds an annotation, since a wide window asks for tiles beyond it).

| Part | Content | Source |
| --- | --- | --- |
| `live/` | one keyframe of the trains within 20 km of Frankfurt (plus two long-distance trips), its head and their shape packs, replay of 2026-10-25T15:00:02Z | `services/live` render, cut by `fixture/build-live.ts` |
| `api/trains`, `api/keys` | train details of three of those trains and the key lookups | `services/live` detail render on the replay database, paired by `fixture/build-details.ts` |
| `api/search` | the search answers for the Land test | our API run in process, `fixture/build-search.ts` |
| `basemap/` | OpenFreeMap vector tiles (z4 to z6 Germany, z10 to z12 Frankfurt) and Noto Sans glyphs | `fixture/build-basemap.ts` |

`fixture/rebuild.sh` holds the literal commands and the input versions. Licences are in `REUSE.toml`.

Test doubles, not recordings: the station records and the earlier page of the journeys test, and the stats answers
(503). Everything else under `api/` is a recorded answer of our own API.

## How the page is frozen and kept hermetic

- A page opens with `?probe=1&replay=0.0001&tier=high`. The live worker's clock cannot be mocked from the page, so the
  replay clock at 0.0001 plan seconds per second freezes the trains, and `page.clock.setFixedTime` freezes the page's
  own clock. `tier=high` (a `?probe` override of the GPU classifier) gives every machine the same app state; without
  it the software GL of a CI runner counts as a low tier and turns relief and buildings off.
- The build leaves the 3D car models out (`GERLINES_TRAIN_MODELS=off`), so cars are drawn the same wherever the suite
  runs.
- Requests to other hosts are routed to the fixture or fail the test; Chromium is started with a proxy at a dead port
  (bypass for 127.0.0.1), so anything that is not routed, a worker's request included, fails loudly. WebSockets are
  refused and recorded. A console error fails a test.

Limits: every page is a replay, so the production live path (push notices, polling, the "Live" state) is not covered;
satellite and terrain tiles are not in the fixture (404); device scale 2 and 3, touch gestures and VoiceOver are not
covered; reduced motion is on (the signature fly is a cut).

## Running like the CI runner

The CI runner has two cores and no GPU, so Chromium draws WebGL with SwiftShader. Locally: `E2E_SOFTWARE_GL=1` forces it
(`--use-gl=angle --use-angle=swiftshader`), `E2E_WORKERS` sets the workers (1 in CI, 2 locally), `E2E_CPU_THROTTLE=4` throttles the
page's main thread, and `E2E_FULL_MAP=1` turns the lean basemap off. On Apple silicon `taskpolicy -b` in front of the
command keeps the whole run on the two efficiency cores, which gave the CI run times (a shell test 26 to 34 s, as in CI).

The flow specs run on a lean basemap (`leanMap`, on by default): vector tiles are answered empty and the national mask and
outline with no features, because the software GL draws about 7 frames a second at 1440x900 with the full basemap and the
page redraws all the time (0.6 against 2.7 frames a second on the efficiency cores). Only the map shots in `visual.spec.ts` use the real basemap.

## Visual baselines

Linux only, made in the Playwright container image the CI job runs in (`e2e/tests/__screenshots__/<project>/…-linux.webp`,
lossless WebP). Fonts and the software GL differ between macOS and Linux, so no macOS baseline is committed and on macOS
the screenshot assertions are ignored. Two kinds of shot:

- Chrome shots: the cards and bars of the page (`search-card`, `live-bar`, `legend-card`, `style-picker`,
  `layers-button`) with the map hidden by `support/hide-map.css`, compared with `threshold` 0.05 and `maxDiffPixels` 50,
  so a restyle of a card fails.
- Map shots: the whole page, compared with `maxDiffPixelRatio` 0.004 and `threshold` 0.2 (software GL varies).

Make or refresh the baselines with the CI workflow's dispatch input (it uploads only the `-linux.webp` files; review them
and commit), or locally in the same image: `docker run --rm --ipc=host -v "$PWD":/work -w /work
mcr.microsoft.com/playwright:v1.65.0-noble pnpm --filter @gerlines/web e2e:update`. To compare on macOS, set
`E2E_LOCAL_BASELINES=1`; the `-darwin.webp` files it writes are ignored by git.

## Stack scripts

`playback.mjs` and `terrain.mjs` need a rendered playback window and elevation tiles, so they stay as `playwright-cli`
scripts against the full stack (`docs/screenshots.md`).

CI timeouts are four times the local ones (test 240 s, expect 60 s): on the efficiency-core emulation a page boot takes
12 to 18 s, a settle 5 to 50 s and a click 6 to 30 s, and the journeys test loads the page five times.
