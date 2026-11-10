# GerLines

A live 3D map of every passenger train in Germany. Trains move along the real track, computed from the national
timetable and realtime delays. Click one to see where it is going, how late it is, what kind of vehicle it probably
is and where each number comes from. There is also history, statistics, a delay forecast and a journey planner.
The interface is in English, German and Polish.

GerLines is a non-commercial, open source project (AGPL-3.0-or-later). It is under active development and runs
locally only: there is no public website yet.

![Three hours of train traffic in Germany played back in thirteen seconds](docs/images/timelapse-germany.gif)

Three hours of a Sunday afternoon in thirteen seconds. Every dot is a train on its own track.

![All of Germany on the dark map, every running train as a dot coloured by category](docs/images/overview-dark.png)

| | |
| --- | --- |
| ![A selected high speed train with its whole route drawn along the track](docs/images/selected-train-route.png) | ![The train card of a delayed ICE near Köln, in German](docs/images/train-card-german.png) |
| A selected train: the route ahead is drawn along the track it will use. | The train card in German: delay, next stop, speed estimate, Follow and Share. |
| ![Trains around Frankfurt drawn as arrows and coloured by delay](docs/images/delay-mode-frankfurt.png) | ![The Moselle valley at Cochem with 3D relief](docs/images/terrain-moselle.png) |
| Colour by delay around Frankfurt. The same switch colours by category or operator group. | The terrain style with 3D relief in the Moselle valley. |
| ![The statistics panel for Germany](docs/images/statistics.png) | ![A journey from Berlin to München drawn on the map](docs/images/journey-planner.png) |
| Punctuality and delay statistics for Germany, a Land, a station, a line or a train. | The journey planner: Berlin Hbf to München Hbf, with the legs on the map. |

| | |
| --- | --- |
| ![One continuous zoom from the whole country into Köln Hbf](docs/images/zoom-levels.gif) | ![Selecting a train: the camera flies to it and the route draws itself](docs/images/select-flight.gif) |
| One zoom from the whole country into Köln Hbf: dots become arrows, then 3D cars at the platforms. | Selecting a train: the camera flies to it and tilts, and the route ahead draws itself along the track. |
| ![Köln Hbf and the Hohenzollern bridge in the satellite style](docs/images/satellite-koeln.png) | ![Focus on Bavaria with the Polish interface](docs/images/land-focus-polish.png) |
| The satellite style: Köln Hbf, the cathedral and the Hohenzollern bridge, with trains as 3D cars on the tracks. | The Polish interface with the focus on one Land, here Bavaria. |
| ![Trains around Frankfurt coloured by operator group](docs/images/operator-mode-frankfurt.png) | ![Playback of a past hour in the light style](docs/images/playback-light.png) |
| Colour by operator group around Frankfurt. | The light style, here with the playback of a past hour: a scrubber and speeds from 1x to 60x. |
| ![The card of Wuppertal Hbf in German](docs/images/station-card-german.png) | ![Delay distribution and punctuality charts of the statistics panel](docs/images/statistics-charts.png) |
| A station card in German: the lines that call there and today's trains. | The statistics panel up close: delay distribution, punctuality by category, by hour and by day, in both themes. |

All images and animations come from the development build replaying recorded data on a laptop. The clock in each
image is the replay's clock.

## Contents

- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Data sources](#data-sources)
- [Tech stack](#tech-stack)
- [Repository layout](#repository-layout)
- [Quick start](#quick-start)
- [Status and known limitations](#status-and-known-limitations)
- [Next steps](#next-steps)
- [Ideas for later](#ideas-for-later)
- [Contributing, security and licence](#contributing-security-and-licence)

## What it does

**The map**

- Germany in four styles: dark, light, satellite and terrain. Everything outside Germany is greyed out, and you can
  focus on one Land.
- 3D relief in the terrain style. Trains sit at the height of their track, a train hidden behind a ridge or a
  building is drawn as a faint ghost, and bridges get a deck line where the track is above the ground.
- Three levels of detail. Zoomed out, a train is a dot. From about zoom 10 it is an arrow that points where it is heading.
  From about zoom 16 it becomes a 3D model of its cars, with every bogie on the track.
- Trains can be coloured by category, by delay or by operator group. The legend counts what is on screen and can hide
  any group.

**Trains and stations**

- A train card with the product and number, the destination, every stop with planned and expected times, platforms,
  cancelled stops, the vehicle series with how sure the guess is, a speed estimate, and the source of each value.
- Follow keeps the camera on a train. Route draws its whole path. Share gives a link to the train.
- Search for a train, a line or a station. A station has its own card.
- A segment profile shows where a train usually gains or loses time, leg by leg, against all trains on the same track.

**History and planning**

- Statistics for Germany, a Land, a station, a line or a train over a day, a week, a month or a custom period, using
  the punctuality rule Deutsche Bahn publishes (an arrival less than 6 minutes late counts as punctual).
- A delay forecast for the stops ahead, always labelled as a forecast.
- Playback of a past hour at 1x to 60x speed with a scrubber.
- A journey planner from station to station with filters for train categories and operators. It shows how punctual
  the trains of each journey were over the last 30 days.

**Across the app**

- English, German and Polish, including the map labels.
- Layouts for phones, tablets and desktops.
- Accessibility to WCAG 2.2 AA as the target: keyboard use, a text list of the trains in view, reduced motion,
  200 % zoom. Automated checks pass in Chromium. Screen readers are not checked yet, so there is no conformance
  statement.
- A data status view that says how fresh each source is. Missing data is shown as missing, and every estimate is
  labelled as one.

### 3D trains

| | | |
| --- | --- | --- |
| ![Trains drawn as 3D cars at Köln Hbf](docs/images/cars-koeln-hbf.png) | ![The procedural model of an ICE 4](docs/images/model-ice4.png) | ![The procedural model of a Talent 2 regional train](docs/images/model-talent2.png) |
| Close to a station, each train is drawn as its cars on the platform track. | ICE 4, generated from its measurements. | Talent 2 regional unit. |

| | |
| --- | --- |
| ![Trains as 3D cars leaving Köln Hbf, animated](docs/images/cars-3d.gif) | ![An S-Bahn drawn as 3D cars on its track, seen from close up](docs/images/cars-closeup-1.png) |
| Köln Hbf: one train pulls out while others stand at their platforms. | An S-Bahn on the map at zoom 18, every car on the matched track. |

![A regional train drawn as 3D cars in the light style](docs/images/cars-closeup-2.png)

The train models are not drawn by hand. A generator (`tools/trainforge`) builds them from a catalogue of
measurements: car lengths, bogie positions, cross-sections, nose shapes fitted to photos, and a livery per operator.
The catalogue holds 56 models today (49 vehicle series and 7 generic ones for trains whose series is unknown), each
in three levels of detail.

### Model gallery

A few of the generated models, at their highest level of detail. The colours come from the livery rules of each
operator.

| | |
| --- | --- |
| ![S-Bahn class 423](docs/images/model-sbahn-423.png) | ![S-Bahn class 422 in the green of the Rhine-Ruhr network](docs/images/model-sbahn-422-vrr.png) |
| S-Bahn class 423 | S-Bahn class 422 in the green of the Rhine-Ruhr network |
| ![Berlin S-Bahn class 481](docs/images/model-sbahn-berlin-481.png) | ![FLIRT 3, class 428](docs/images/model-flirt-428-db.png) |
| Berlin S-Bahn class 481 | FLIRT 3 (class 428) |
| ![FLIRT 3 in vlexx colours](docs/images/model-flirt-vlexx.png) | ![Coradia Continental, class 440](docs/images/model-coradia-440.png) |
| FLIRT 3 in vlexx colours | Coradia Continental (class 440) |
| ![RegioShuttle RS1 in Erfurter Bahn colours](docs/images/model-regioshuttle-650-erfurter.png) | ![Mireo, class 463, in bwegt colours](docs/images/model-mireo-463-bwegt.png) |
| RegioShuttle RS1 (class 650) in Erfurter Bahn colours | Mireo (class 463) in bwegt colours |
| ![Class 146 locomotive with double-deck coaches](docs/images/model-doppelstock-146.png) | ![Intercity 2 with double-deck coaches](docs/images/model-intercity-2.png) |
| Class 146 locomotive with double-deck coaches | Intercity 2: a class 146.5 locomotive with Twindexx double-deck coaches |
| ![ICE 3, class 403](docs/images/model-ice3-403.png) | ![ICE T, class 411](docs/images/model-ice-t-411.png) |
| ICE 3 (class 403) | ICE T (class 411) |
| ![TGV Euroduplex](docs/images/model-tgv-euroduplex.png) | ![Desiro Classic, class 642, from the side](docs/images/model-side-desiro-642-neb.png) |
| TGV Euroduplex, which reaches Germany from France | Desiro Classic (class 642) from the side |

![Four regional trains at the same scale](docs/images/model-lineup-regional.png)

Four trains at the same scale, from the top: Berlin S-Bahn class 481, Desiro Classic, Mireo and FLIRT 3.

## How it works

No open data source in Germany publishes measured train positions. The realtime feeds only say how late a train is
at its stops. So GerLines computes the positions:

1. Every trip pattern in the timetable gets a **shape**: a line matched to the OpenStreetMap rail network, with the
   distance along the track and the height stored for every point.
2. The server turns the timetable and the latest realtime predictions into a **motion plan** per train: where its
   stops are along the shape and when it will reach and leave each one.
3. The browser evaluates each plan as a single number, the **distance along the shape**. A train can therefore never
   leave its shape. When a new prediction arrives, the train changes its speed. It does not jump, and it never moves
   backwards.

```mermaid
flowchart LR
  subgraph sources[Open data]
    delfi[DELFI timetable and realtime]
    more[gtfs.de, VBB, VBN, DB, neighbours]
    osm[OpenStreetMap rail]
  end
  subgraph pipelines[Python pipelines]
    static[static_import]
    rail[rail_graph: shapes]
    geo[geo_base: mask and Länder]
  end
  subgraph services[TypeScript services]
    rec[ingest: recorder]
    proc[ingest: realtime processor]
    live[live: motion plans, frames, train detail]
    router[router: MOTIS 2]
  end
  db[(Postgres, TimescaleDB, PostGIS)]
  valkey[(Valkey)]
  api[apps/api]
  web[apps/web: MapLibre, deck.gl, worker]

  delfi --> static --> db
  osm --> rail --> db
  delfi & more --> rec --> proc --> db
  static --> router --> api
  db --> live --> valkey --> api --> web
  live --> web
  geo --> web
```

### The parts in more detail

**Timetable import.** Once a week the national DELFI timetable (GTFS) is downloaded, validated and loaded into
Postgres. Route types and names are mapped to a small set of categories (high speed, long distance, night, fast
regional, regional, S-Bahn), operators are attached, and stations get their EVA numbers and a name that includes the
town.

**Shapes.** Two matchers propose a path for every trip pattern: MOTIS on a rail-only OpenStreetMap extract, and
pfaedle on the full extract. A quality gate then rejects a shape that runs backwards, cuts a corner with a long
straight line, strays from the track, takes a detour or misses a stop. The better candidate wins. A pattern that
fails with both is drawn as straight lines and flagged as low quality. Heights come from an elevation model, with
straight grades across bridges and through tunnels.

**Recorder.** A recorder fetches 20 feeds on their own schedules and stores every answer byte for byte, with gaps
tracked per source. Everything downstream can therefore be replayed and checked against the original data.

**Realtime processor.** It reads the recordings, matches each realtime record to a trip of the timetable and writes
stop events, forecasts and one observation per leg. A record that cannot be matched is kept with the reason. It is
never dropped silently.

**Live engine.** It holds a motion plan for every running train. Between two stops a train follows a simple speed
profile: accelerate, cruise, brake. The engine publishes a full **keyframe** every 30 seconds and a small **delta**
with only the changed plans every few seconds, in a compact binary format (`packages/live-frame/FORMAT.md`). The
geometry travels separately as **shape packs**, which a client downloads once. A national keyframe of 3,000 trains is
about 50 KB compressed. A push notice tells clients when a new frame is ready.

**Browser.** A web worker keeps every train on its shape and steers the displayed position towards the plan with
limits on acceleration and braking, so the motion stays smooth when a delay changes. A continuity meter counts
jumps, stalls and backward steps. The replays checked so far show none. Rendering is MapLibre GL JS with deck.gl
layers on top.

**Which vehicle is it?** The feeds do not say which vehicle runs a train, so the answer comes in layers, from most
to least certain: the coach sequence of the train where one is available, what the same train number usually ran as,
a rule for the line, the operator's most common series, and last a generic model for the category. The card always
says which layer the answer came from.

**History and forecasts.** Final stop times, every change of a prediction and one row per leg are kept in
TimescaleDB, with rollups for the statistics. The history before the project's own recordings comes from a public
archive of Deutsche Bahn station data. The forecast has two baselines: B0 assumes the current delay stays as it is,
and B1 adds how the delay usually changes for this train and stop. In a backtest over about one billion stop pairs,
B1 was off by 1.65 minutes on average and B0 by 1.87. Where the live feed has its own prediction, the card shows
that one, because it was the better of the two in a live check.

**Journeys.** A self-hosted MOTIS 2 instance plans station to station journeys on the same timetable. It does not use
realtime data yet. The GerLines API adds the filters, the paging and the punctuality of each train.

More detail: [docs/architecture.md](docs/architecture.md) for the whole system, [docs/adr/](docs/adr/) for the
reasons behind each major decision, [docs/statistics.md](docs/statistics.md),
[docs/history.md](docs/history.md) and [docs/predictions.md](docs/predictions.md) for the numbers.

## Data sources

GerLines uses open data only. Every number, photo and name on screen comes from a named source with its licence.

| Source | Used for | Licence |
| --- | --- | --- |
| DELFI e.V. | national timetable, realtime delays and cancellations | CC BY 4.0 (timetable), CC BY-SA (realtime) |
| gtfs.de, VBB, VBN | additional realtime and timetable data | CC BY 4.0, CC BY-SA 4.0 |
| Deutsche Bahn open data | station boards (Timetables), station data, lifts and escalators | CC BY 4.0 |
| Feeds of the Netherlands, Czechia, Poland, Belgium, France and Switzerland | trains near and across the border | per feed |
| OpenStreetMap contributors | the rail network for the shapes and, through OpenFreeMap and OpenMapTiles, the basemap | ODbL |
| GeoBasis-DE / BKG | outlines of Germany and the Länder | DL-DE BY 2.0 |
| Mapterhorn, VersaTiles | elevation for the terrain style, imagery for the satellite style | per source |
| piebro/deutsche-bahn-data | history before the project's own recordings | CC BY 4.0 |
| Wikidata, Wikipedia, Wikimedia Commons | operators, vehicle series, line rules, photos with credits | CC0, CC BY-SA, per file |
| Natural Earth | neighbouring countries and town names | public domain |

Some feeds need a free key or account (the DB APIs, the official DELFI realtime delivery, the Swiss and Belgian
feeds). [docs/KEYS.md](docs/KEYS.md) explains how to get each one. The map and most of the pipeline work without
them. The full list with access rules and attribution texts is in [docs/data-sources.md](docs/data-sources.md) and
[NOTICE.md](NOTICE.md). Data that GerLines derives from share-alike sources keeps their licence.

GerLines is not affiliated with, endorsed by or connected to Deutsche Bahn, DELFI e.V., any railway operator or any
transport association. Operator names, product names and logos are used only to describe the trains they run, and
remain trademarks of their owners.

## Tech stack

| Layer | Technology |
| --- | --- |
| Web client | TypeScript, React 19, MapLibre GL JS 6, deck.gl 9, Vite, Tailwind CSS, Zustand |
| API | Node 24, Hono, zod, an OpenAPI 3.1 document for every route |
| Services | TypeScript on Node 24: recorder, realtime processor, live engine; MOTIS 2 for journeys |
| Pipelines | Python 3.13 with uv, polars, shapely, pyproj; pfaedle and MOTIS for the shapes |
| Storage | PostgreSQL 18 with TimescaleDB and PostGIS, Valkey, Centrifugo for push |
| 3D models | a procedural generator that writes glTF with meshopt compression |
| Tooling | pnpm workspaces, Turborepo, Biome, Vitest, Playwright, axe-core, pytest, k6, REUSE, gitleaks |
| Infrastructure | Docker Compose for local use, and a hardened production overlay with Caddy that is prepared but not deployed |

## Repository layout

| Path | Contents |
| --- | --- |
| `apps/web` | web client: map, live worker, 3D car layer, panels |
| `apps/api` | HTTP API: journeys, search, statistics, train detail, photos, data status |
| `services/ingest` | recorder, realtime processor, adapters for each feed |
| `services/live` | live engine: motion plans, frames, shape packs, train detail |
| `services/router` | MOTIS 2 configuration and category rules |
| `pipelines/*` | Python: timetable import, rail graph and shapes, geo base, catalogue, rollups, backfill, forecasts |
| `packages/*` | shared TypeScript: schema, migrations, motion kernel, frame codec, translations, design system |
| `catalog/` | categories, operators, transport associations, vehicle series and measurements, liveries, line colours |
| `infra/` | Docker Compose stack and the production overlay |
| `tools/` | the train model generator, the photo review tool, load tests |
| `spikes/` | time-boxed experiments kept for their measurements |
| `docs/` | architecture, decisions, data sources, development guide, runbooks ([index](docs/README.md)) |

## Quick start

You need Node 24 (`.nvmrc`), pnpm 11 (pinned in `package.json`) and [uv](https://docs.astral.sh/uv/). Docker is
needed only for the database, the recorder, the realtime processor, the live engine and the router.

```bash
git clone https://github.com/Kacper0199/gerlines-map.git
cd gerlines-map
nvm use
pnpm install
uv sync
pnpm --filter @gerlines/i18n compile
```

The last line compiles the translations, which the web client imports.

Run the map:

```bash
pnpm --filter @gerlines/web dev
```

Open `http://127.0.0.1:5173/` (the port Vite prints). Add `?theme=light`, `?lang=de` or `?lang=pl` to the address.

A fresh clone shows the map, the styles and the interface in three languages, but **no trains**: the page says
"No live server is running". The repository holds the code, not the data. To see trains you first build a timetable,
the shapes, the shape packs and a render, and then serve them with the live engine. The steps are in
[docs/development.md](docs/development.md) (section Live engine) and in `apps/web/README.md`. They need Docker, the
DELFI download and an OpenStreetMap extract, and the shape matching takes several hours and several GB of memory.
The 3D cars need the models built once with `pnpm --filter @gerlines/trainforge build`.

The checks of the main CI job, which need no database:

```bash
pnpm turbo run lint typecheck test
uv run pytest -m "not db" --ignore=pipelines/rail_graph
```

The end-to-end suite (`pnpm --filter @gerlines/web e2e`) runs against a small recorded fixture of the trains around
Frankfurt and needs neither a database nor a network connection. The tests that need a database run in their own
workflow (`.github/workflows/db.yml`).

## Status and known limitations

Status as of November 2026. Everything listed under [What it does](#what-it-does) is built and runs on a development
machine. Nothing is deployed.

| Area | State |
| --- | --- |
| Data core: timetable import, shapes, recorder, realtime processing, router | built |
| Live engine, frame format, browser worker | built; the planned track slices between arrows and 3D cars are missing |
| Map, train card, search, colour modes, translations | built |
| 3D: train models, car layer, terrain, camera moves | built; measured in Chromium only |
| Catalogue: categories, operators, vehicle identification, photos | built; operator logos and the final photo review are open |
| History, statistics, segment profile, forecasts B0 and B1, playback | built |
| Journey planner | built; checked on scripted station pairs against DB's station plans |
| Hardening: accessibility, end-to-end tests, security review, legal pages | first pass done; screen readers and real phones are open |
| Public deployment | prepared, not started |
| Machine learning: a better delay model, reliability of connections | planned |

What you should know before relying on anything here:

- **Positions are computed, not measured.** A train on the map is where the timetable and the latest delay say it
  should be. Between two reports it is an estimate.
- **The history is not yet the project's own.** Statistics, the segment profile and the forecasts were computed from
  the public archive and from replays on test databases. The project's own recordings have gaps, because the recorder
  ran on a laptop.
- **Some shapes are still straight lines**, mostly on legs across the border.
- **Two trains standing at the same platform are drawn on the same spot.**
- **A train waiting at its first or last stop stays an arrow** and becomes 3D cars only once its whole length is on
  its shape.
- **Nothing was measured on a real phone, in Safari or in Firefox.** The frame rates come from a phone emulation in
  Chromium on a laptop (about 60 frames per second with about 2,360 trains drawn).
- **The vehicle series is often a guess.** Only long distance trains are identified reliably. Regional fleets rest on
  rules that have to be rebuilt at every timetable change.
- **The legal pages are not finished.** The imprint and the privacy controller are marked as missing.

## Next steps

In rough order of how much they block a public launch:

1. **An always-on recorder and processor.** Move the recorder and the realtime processor from a laptop to a small
   server, so the history, the statistics and the forecasts come from the project's own continuous recording.
2. **A first deployment.** Try the prepared production stack on a real server: the API image, the firewall, the CDN
   rules, backups and restore. [docs/deployment-options.md](docs/deployment-options.md) compares the routes (one
   server behind a CDN for a few tens of euros a month, AWS, others) and lists the gaps found in the prepared stack.
   [docs/runbooks/deploy.md](docs/runbooks/deploy.md) has the steps.
3. **Own basemap tiles.** Development uses public tile servers. Production should serve its own tiles and fonts.
4. **Legal pages.** Imprint, privacy policy, a link to the source in the app (as the AGPL expects of a public
   service), and a licence check for operator logos.
5. **Real devices.** Phones, Safari, Firefox, and screen readers (VoiceOver, NVDA, TalkBack).
6. **Rendering gaps.** Track slices as a level of detail between arrows and 3D cars, 3D cars that stay visible in
   tunnels as ghosts, trains at the same platform side by side, 3D cars at a terminus.
7. **Shapes across borders.** Extend the rail graph so the remaining straight legs follow the track.
8. **Catalogue upkeep.** Review the photos, add operator logos where the licence allows it, rebuild the fleet rules
   for the new timetable year.
9. **Better forecasts.** A learned delay model (gradient boosting on the stored forecast history) that has to beat
   both baselines, and a reliability score for a connection: how often the change actually worked.

## Ideas for later

None of this is built. These are directions that fit the data the project already has.

**A natural-language assistant.** A question box that answers questions such as "where is ICE 705 now and how late
is it", "how punctual was the RE1 last month" or "what is a class 442", in English, German and Polish. The proposed
design is a tool-calling loop over the existing read-only API, so every live number comes from the same routes the
map uses, with its source and data time. Retrieval (pgvector plus full-text and trigram search in the existing
Postgres) covers only the slow-changing text: the documentation, the catalogue and the data sources. Live numbers
never come from a vector index. Conversations are not stored. The first step would be a published tool layer that
works with any model, which costs the project nothing to run. The full proposal, with the schema, the safety rules,
the evaluation plan and the open questions, is in [docs/assistant.md](docs/assistant.md).

**More ideas**

- City transport: buses, trams and U-Bahn from a closer zoom level. The DELFI timetable already contains them,
  although the import loads only trains today.
- Disruption messages on the map. The recorder already stores the alert feeds.
- Alerts for a followed train: a notification when its delay or platform changes.
- Open data exports of the derived data (matched shapes, delay statistics) under their share-alike licences.
- Full history for trains of the neighbouring countries.
- An overlay of railway infrastructure (signals, speed limits, electrification) from OpenRailwayMap.
- Lighting by time of day, and a WebGPU renderer once browser support is broad enough.
- An embeddable map for one line or one station.

## Contributing, security and licence

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md) and the [code of conduct](CODE_OF_CONDUCT.md).
A wrong train, a wrong name or a wrong colour is worth an issue. Report security problems privately as described in
[SECURITY.md](SECURITY.md), not in a public issue.

Code: [AGPL-3.0-or-later](LICENSE). The repository follows the [REUSE](https://reuse.software) specification:
`REUSE.toml` names the licence of every file, including the data fixtures and catalogue files under CC0, CC BY,
CC BY-SA, ODbL and DL-DE BY. If you run a modified version of GerLines as a public service, the AGPL requires you to
offer its source to the users of that service.
