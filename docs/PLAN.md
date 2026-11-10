# Plan

What gets built, in which order, and how each step is proven. How it works is in
[architecture.md](architecture.md); keys in [KEYS.md](KEYS.md). Requirement IDs (R-NN) are listed in section 1.

## 1. Goal and success criteria

A public, non-commercial, open-source website that shows every train in Germany moving live on a beautiful 3D
map, explains each train in depth, keeps its own history, answers journey questions and publishes statistics. It
runs locally first and deploys to a domain for many users without rework.

| ID | Success criterion | Requirements |
| --- | --- | --- |
| SC-1 | Every passenger train in Germany with timetable data appears on the map, coloured by category; foreign trains near the borders appear as display-only | R-01, R-11 |
| SC-2 | Motion is smooth and on the track: frame-continuity metric passes on a replayed day, no long tasks over 50 ms, no vehicle off its shape | R-04 |
| SC-3 | Map: dark default, light, satellite and terrain styles; 3D buildings only from zoom 14.5; terrain on demand; grey mask and soft bounds outside Germany; Land focus | R-05, R-16, R-17 |
| SC-4 | Clicking a train opens a card with category, operator and Verbund badges, the vehicle series with a confidence label, a licensed photo, delay, next stops, speed estimate, data provenance; the camera flies in and the route draws itself | R-09, R-10, R-12, R-13, R-14 |
| SC-5 | Own history from day one: stop events, forecast snapshots, segments, rollups; backfill from public archives | R-07 |
| SC-6 | Journey search A to B with category filters and ranked alternatives | R-08 |
| SC-7 | Statistics for today, a period, a train, a Land, validated against DB's monthly punctuality within 2 percentage points | R-16 |
| SC-8 | EN, DE, PL; phone, tablet, desktop and large screens; WCAG 2.2 AA; copy rule of R-15 enforced by a lint | R-02, R-03, R-15 |
| SC-9 | Design chosen by the maintainer from rendered variants, passes the design review, avoids every generic look listed in DESIGN.md | R-25 |
| SC-10 | Deployable with one command to one server behind a CDN; budgets met; legal pages present | R-19, R-28, R-29 |
| SC-11 | Information modes: trains coloured by category, delay or operator, label modes, category and foreign toggles that count and hide; the legend follows the mode | R-06 |
| SC-12 | Three audiences served at once: a visitor understands the map within 5 seconds, a rail expert finds series, number and formation of a chosen train, a traveller finds a connection and its delay; no mode hides what another audience needs | R-27 |

Requirements summary: R-01 all trains (urban transit optional), R-02 EN DE PL, R-03 responsive and fast, R-04 smooth
on-track motion, R-05 basemap quality and styles, R-06 information modes, R-07 history database, R-08 journey
search with filters, R-09 per-segment history profile, R-10 maximum information, R-11 foreign trains, R-12 photo,
logos, category, R-13 accurate 3D models, R-14 selection colour, R-15 professional panel and copy rule, R-16
statistics and Land focus, R-17 mask and soft bounds, R-18 ML-ready, R-19 deployable, R-22 key gating, R-25 design chosen from rendered
variants, R-27 three audiences, R-28 non-commercial open source, R-29 hosting that
is cheap, widely used and able to host further sites and apps later, chosen with the maintainer at M10.

## 2. Non-negotiables

1. **On the track or not at all.** Positions are evaluated along matched shapes in arc length. Nothing moves in a
   straight line between fixes, nothing reverses, nothing teleports.
2. **Record first.** The recorder starts in M1 and never stops; history cannot be recreated later.
3. **Real data only.** No invented numbers, photos without licence, or placeholder statistics presented as real.
   Missing data is shown as missing.
4. **Key gating.** Work against a keyed API starts only after the key is in `.env` and
   `scripts/check-keys.sh` passes for it.
5. **Design from DESIGN.md.** Every visual decision comes from DESIGN.md; changes to it are reviewed by the
   maintainer.
6. **Proven, not claimed.** A work package is done when its verification ran and its evidence is recorded.
7. **Licences respected.** Attribution for every source, share-alike for published derived data, no DB or operator
   branding as our identity.

## 3. Milestones and gates

| Milestone | Content | Gate (all must hold) |
| --- | --- | --- |
| M0 Plan and keys | research, plan, design brief, API keys | G0: required keys pass `check-keys.sh`; the maintainer accepted the plan |
| M1 Foundations | monorepo, local infra, recorder running, first light on the map, spikes, design direction chosen | G1: CI green; 24 h of recordings; first light visible on phone and desktop; spike reports with go or no-go; DESIGN.md tokens lint clean |
| M2 Data core | static import, rail graph and shapes, realtime ingest to stop events and segments, router, geo base, rollups | G2: a replayed day keeps all DB invariants; 95 % or more of rail trips matched; shape QA pass rate 97 % or more of patterns; router answers under 1 s |
| M3 Live engine | frame codec, live service, client worker, 2D levels of detail, selection | G3: replay at 10x passes the frame-continuity metric; budgets met on desktop and on the throttled phone profile; Transitous no longer used |
| M4 Product shell | design system, layout, cards, information modes, styles, mask and Land focus, i18n, search, deep links | G4: the design review loop passes at all viewports; design review PASS; core e2e journeys green |
| M5 3D | vehicle forge, 3D car layer, terrain and buildings policy, signature moment | G5: visual QA on steep and tunnel corridors; budgets with 3D on; models checked against reference photos |
| M6 Catalog | categories, operators, Verbünde, series, line colours, identification layers, photos and logos | G6: identification confidence reported on 200 sampled trains; every photo carries author, licence and link |
| M7 History and statistics | backfill, statistics API and views, segment profile, B0 and B1 predictions, playback | G7: punctuality within 2 pp of DB monthly figures; rollups equal recomputation |
| M8 Journeys | journeys API with filters and ranking, planner UI | G8: filter tests pass; 50 scripted origin-destination pairs plausible against bahn.de |
| M9 Hardening | real-phone performance, accessibility, e2e and visual suite, load test, security review, legal pages, data quality dashboards, final design review | G9: all budgets met; e2e green; no High or Blocker findings open |
| M10 Deployment | production stack, CDN, PMTiles self-hosting, CI/CD, backups, observability | G10: staging URL works for outside users; restore drill done (only when the maintainer decides to publish) |
| M11 ML | gradient boosting predictions, reliability ranking | G11: beats persistence at every horizon on a strict time split |

Later, outside this plan until the maintainer decides otherwise: urban transit layer (bus, tram, U-Bahn from zoom 11), full history for
foreign trains, time-of-day lighting, OpenRailwayMap infrastructure overlay, official basemap.de style, WebGPU.

## 4. Work packages

Keys: K1 = DB API
Marketplace, K2 = Swiss key, K3 = Mobilithek account, KD = deployment accounts ([KEYS.md](KEYS.md)).

### M1 Foundations

| WP | Work | Depends | Keys | Verify |
| --- | --- | --- | --- | --- |
| WP-1.1 | Monorepo: pnpm workspaces, Turborepo, Node 24 `.nvmrc`, TypeScript, Biome or Oxlint, Vitest, uv workspace with ruff and pytest, lefthook pre-commit with a secret scan, GitHub Actions CI, AGPL licence headers policy | none | none | `pnpm install && pnpm turbo run lint typecheck test` green; `uv run pytest` green; CI workflow lint passes |
| WP-1.2 | Local infra: `infra/compose.yaml` (Timescale image on 5433, Valkey, Centrifugo), `packages/db` migration runner and first schema (provenance, stops, ids) | 1.1 | none | `docker compose up -d` healthy; migrations up and down in a test |
| WP-1.3 | Recorder v1: scheduler and recorder for DELFI RT mirror, gtfs.de RT, VBB, VBN, neighbour feeds, weekly DELFI GTFS; runs as a Compose service with restart | 1.2 | none (User-Agent contact) | 24 h of recordings with sidecars; size and error report |
| WP-1.4 | First light: `apps/web` with MapLibre and deck.gl, dark OpenFreeMap style, all trains from Transitous map/trips through a caching dev proxy, motion along segment polylines in a worker, minimal card | 1.1 | none | screenshots desktop and phone; FPS probe; no console errors |
| WP-1.5 | Design directions and variants: 3 to 5 rendered variants of the map with panel and card, name proposals with free domains; the maintainer picks | DESIGN.md brief | none | DESIGN.md front matter lints clean; chosen direction recorded |
| SP-1 | MOTIS for Germany on a 16 GB machine: DELFI plus rail-only OSM with route_shapes; RAM, time, disk, query latency for plan and map/trips; reduced configurations | 1.2 | none | a measurement report with numbers and the chosen configuration |
| SP-2 | Realtime coverage: one recorded day of DELFI RT against IRIS for long-distance and non-DB operators; decide whether an IRIS crawler is needed for long-distance history | 1.3, K1 | K1 | coverage table per category and operator |
| SP-3 | Shapes: pfaedle against MOTIS route_shapes against DELFI shapes on 20 hard corridors (Köln Hbf, Hamburg Hbf, Frankfurt S-Bahn tunnel, Munich Stammstrecke, Berlin Stadtbahn, Geislinger Steige, Rhine valley, Schwarzwaldbahn, cross-border lines) | 1.1 | none | metrics table and overlay screenshots; chosen method |
| SP-4 | Render performance: 15,000 synthetic trains on real shapes with all four LOD tiers and worker motion; desktop, throttled phone profile, the maintainer's phone over LAN | 1.1 | none | frame-time p50 and p95, long tasks, heap, per device |
| SP-5 | i18n: Paraglide locale switch without reload while the map stays mounted; fallback i18next | 1.4 | none | short report and a working toggle |
| SP-6 | Motion kernel in `packages/geo`: trapezoid fit, catch-up, crossfade, bogie placement, property tests (never backwards, never off shape, bounded acceleration), replay against recorded RT | 1.1, 1.3 | none | property tests green; continuity metric defined and measured |

### M2 Data core

| WP | Work | Depends | Keys | Verify |
| --- | --- | --- | --- | --- |
| WP-2.1 | Static import: DELFI download, gtfs-validator, canonical categories, operators, EVA join, load, enriched GTFS for MOTIS | 1.2 | none | validator report; category mapping unit tests over all route names; row counts against the feed |
| WP-2.2 | Rail graph, shapes by the SP-3 method, QA gate, elevation bake, shape packs | SP-3, 2.1 | none | QA pass rate; overlay screenshots for the 20 corridors |
| WP-2.3 | Realtime adapters (DELFI RT, gtfs.de fallback, VBB, VBN, neighbours), matcher, writers for stop events, forecasts, segments, outbox | 2.1, 1.3 | none | contract tests on recordings; replay day invariants; match rate |
| WP-2.4 | DB adapters: IRIS for selected stations and validation, StaDa, FaSta | 2.1 | K1 | contract tests; rate limit respected in a 1 h run |
| WP-2.5 | Router: MOTIS service in Compose, our category Lua, health check, API wrapper skeleton | SP-1, 2.1 | none | sample queries with and without high-speed trains |
| WP-2.6 | Geo base: Germany mask, Länder, neighbour labels and cross-border hints | 1.1 | none | rendered check in the web app |
| WP-2.7 | Rollups: continuous aggregates with histogram bins, Land assignment | 2.3 | none | rollup equals recomputation on a replayed day |

### M3 Live engine

| WP | Work | Depends | Verify |
| --- | --- | --- | --- |
| WP-3.1 | `packages/live-frame` codec with golden vectors | 1.1 | round-trip and golden tests in Node and in the browser worker |
| WP-3.2 | `services/live`: motion plans, keyframes, deltas, head, push notices | 2.3, 3.1 | replay day produces frames; sizes within budget |
| WP-3.3 | Client worker on the SP-6 kernel, shape pack cache, transfer of buffers; Transitous path removed | 3.2, SP-6 | continuity metric at 10x replay; long tasks |
| WP-3.4 | 2D levels of detail, selection colour, route ahead drawing, dimming, provenance on the card | 3.3 | screenshots per tier; e2e select and deselect |

### M4 Product shell

| WP | Work | Depends | Verify |
| --- | --- | --- | --- |
| WP-4.1 | Design system in `packages/ui`: tokens from DESIGN.md, themed component library, icon set with custom category glyphs, self-hosted fonts | 1.5 | component sheet screenshots light and dark |
| WP-4.2 | Layout: desktop side panel, phone bottom sheet with peek, controls, context legend, attribution, zoom-stage line | 4.1 | screenshots at all viewports |
| WP-4.3 | Train card (collapsed and expanded with stop list and delay chips, actions Follow, Route, Share), station card | 4.2, 3.4 | states: loading, no realtime, cancelled, long names |
| WP-4.4 | Information modes: colour mode (category, delay, operator), label mode, category and foreign toggles, layer counts, zoom hints | 3.4 | e2e toggles; legend follows the mode |
| WP-4.5 | Styles from tokens (dark, light, satellite, terrain), label language switch, mask, soft bounds, Land focus | 2.6, 4.1 | screenshots per style; bounds behaviour test |
| WP-4.6 | EN, DE, PL messages complete; copy lint for R-15 | 4.2, SP-5 | lint green; screenshots per locale |
| WP-4.7 | Search (train number, line, station, place) and deep links in the URL | 3.4, 2.1 | e2e open by link |

### M5 3D

| WP | Work | Depends | Verify |
| --- | --- | --- | --- |
| WP-5.1 | `tools/trainforge`: parametric glTF generator, `catalog/vehicles.yaml` for the priority series, LODs, palette atlas, preview page | 1.1, rolling-stock catalogue | preview screenshots against reference photos; triangle budgets |
| WP-5.2 | 3D car layer: bogie placement, LOD tiers, liveries, picking, tunnel ghosts | 5.1, 3.3 | curve screenshots; frame budget with 300 trains in view |
| WP-5.3 | Terrain policy, buildings from zoom 14.5, GPU tier detection | 4.5 | budgets on throttled profile |
| WP-5.4 | Signature moment: fly, tilt, route draw, follow; reduced-motion version | 5.2, 4.3 | recorded clip frames; reduced-motion check |

### M6 Catalog

| WP | Work | Depends | Verify |
| --- | --- | --- | --- |
| WP-6.1 | Catalogue seeds: categories, operators, Verbünde, series, liveries, line colours (Träwelling CC0), operator to Wikidata (CC0) | 2.1 | schema validation; coverage report against operators in the feed |
| WP-6.2 | Identification layers: vehicle-sequence adapter behind a flag with caching, fleet rules, confidence | 6.1 | 200-train sample report |
| WP-6.3 | Photos from Wikimedia Commons via Wikidata with attribution, 330 and 960 px copies stored locally, a small approval tool (candidates, approve, reject); logos per the rules in data-sources.md; credits page | 6.1 | every image has author, licence, link and an approval record |

### M7 History and statistics

| WP | Work | Depends | Verify |
| --- | --- | --- | --- |
| WP-7.1 | Backfill from piebro monthly Parquet | 2.3 | row counts; spot checks against IRIS |
| WP-7.2 | Statistics API (today, period, train, line, station, Land) | 2.7 | punctuality against DB monthly figures |
| WP-7.3 | Statistics views | 7.2, 4.2 | loop screenshots; numbers match the API |
| WP-7.4a | Segment profile API: `GET /api/v1/stats/trains/{number}/segments`, this train number against every train on each leg, read from the leg rollups `stat_segment` and `segment_day` | 7.2, 2.7 | unit tests and an integration test on a throwaway database; latency on a bench copy of one month |
| WP-7.4b | Segment profile in the web app: each leg of the route coloured by this train's gain against all trains, missing legs dashed with the reason, a 3D profile curtain in pitched views, a card block with the legend and every leg | 7.4a, 5.2 | screenshots; tooltip values match the API |
| WP-7.5 | B0 and B1 predictions on the train card | 2.7 | backtest table |
| WP-7.6a | Playback server: hour windows of the last 7 days rendered from history in the live frame format by a separate job, served read only (ADR-0014) | 2.3, 3.2 | chain check with 40 clients and the continuity check over a rendered hour |
| WP-7.6b | Playback in the web app: History in the live bar, a day and an hour, 1x to 60x, seek, the moment in the address | 7.6a, 3.3 | e2e play and pause |

WP-7.4 and WP-7.6 were each built in two parts, the server first and the web app on its contract.

### M8 Journeys

| WP | Work | Depends | Verify |
| --- | --- | --- | --- |
| WP-8.1 | Journeys API: category filters, post-filters, ranking, alternatives, earlier and later | 2.5 | unit and integration tests per filter |
| WP-8.2 | Planner UI: from and to, filters, results, legs on the map, reliability hint | 8.1, 4.2 | e2e; 50 scripted pairs |

### M9 Hardening, M10 Deployment, M11 ML

| WP | Work |
| --- | --- |
| WP-9.1 | Real-phone performance pass |
| WP-9.2 | Accessibility WCAG 2.2 AA |
| WP-9.3 | E2E and visual regression suite with frozen clock and fixed replay frame, five viewports |
| WP-9.4 | Load test with k6 (3,000 push clients, API p95) |
| WP-9.5 | Security review, dependency audit, secret scan |
| WP-9.6 | Legal: Impressum, privacy policy, sources and licences page, photo credits, not-affiliated notice |
| WP-9.7 | Data quality dashboards and an in-app data status indicator |
| WP-9.8 | Final design review, with the three audience tasks of SC-12 scripted and walked at phone and desktop size, and the information modes of SC-11 checked against the legend |
| WP-10.1 | Production Compose, Caddy, Cloudflare, Planetiler PMTiles and glyphs on R2, CI/CD, backups, observability (KD keys) |
| WP-11.1 | B2 gradient boosting per downstream stop, reliability ranking for journeys |

## 5. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| No measured positions in German open data | trains stopped between stations look wrong | motion plans with dwell detection; provenance on the card; foreign GPS feeds where available |
| DELFI realtime only through a community mirror | live outage | gtfs.de pair as fallback; Mobilithek access (K3); stale-data banner |
| Long-distance realtime coverage in DELFI unclear | weaker ICE and IC history | SP-2 decides; IRIS crawler with K1 if needed |
| MOTIS needs more than 16 GB for Germany | no journey search locally | SP-1: rail-only OSM, fewer days, no geocoding; import on a rented VM as a last resort with the maintainer's approval |
| Shape matching errors in big stations and on four-track lines | trains on the wrong track | SP-3 picks the method; QA gate; corridor screenshots in G2 |
| Phone frame budget with terrain, buildings and thousands of trains | jank on phones | SP-4 early; GPU tiers; terrain and buildings off on low tiers |
| Unofficial vehicle-sequence endpoint gets blocked | no exact series for ICE | feature flag, cache, fleet rules fallback with confidence |
| Share-alike licences on derived data | publishing duties | publish derived statistics and the rail graph under ODbL or CC BY-SA; sources page |
| Donation-run tile services | basemap outage after launch | self-host PMTiles, DEM and glyphs before launch (M10) |
