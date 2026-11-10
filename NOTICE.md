# Notice

GerLines is licensed under AGPL-3.0-or-later ([LICENSE](LICENSE)). This repository and the running application
also contain or use material of third parties under their own licences. This file summarises them; `REUSE.toml` is
the authoritative record per file, the licence texts are in `LICENSES/`, and
[docs/data-sources.md](docs/data-sources.md) gives the access terms and the exact attribution text of every source.

GerLines is not affiliated with, endorsed by or connected to any of the organisations named here.

## Data included in this repository

| Files | Holders | Licence |
| --- | --- | --- |
| `services/ingest/test/fixtures/delfi-*.pb`, `gtfsde-*.pb`, `vbn-*.pb`, `realtime/delfi-*`, `realtime/gtfsde-rt-*` | DELFI e.V. (via the traines mirror, gtfs.de and VBN) | CC BY-SA 4.0 |
| `services/ingest/test/fixtures/db-apis/*` | Deutsche Bahn AG (DB API Marketplace: Timetables, StaDa, FaSta) | CC BY 4.0 |
| `services/ingest/test/fixtures/realtime/fr-sncf-gtfs-rt-*` | SNCF (via transport.data.gouv.fr) | ODbL 1.0 |
| `services/ingest/test/fixtures/realtime/pl-pkpic-gtfs-rt-*` | PKP Intercity and PKP Polskie Linie Kolejowe S.A. (via gtfs.kasznia.net, built on mkuran.pl data) | CC BY 4.0 and the PKP PLK reuse terms |
| `services/ingest/test/fixtures/realtime/ch-otd-gtfs-rt-*` | opentransportdata.swiss | its terms of use |
| `services/ingest/test/fixtures/ovapi-*.pb` | OVapi | OVapi free use |
| `services/live/src/detail/fixtures/*.json` | DELFI e.V. (via the traines.eu mirror), gtfs.de, PKP Intercity and PKP PLK, traines.eu and OpenStreetMap contributors (station names with EVA numbers) | CC BY-SA 4.0, CC BY 4.0, ODbL 1.0, PKP PLK reuse terms |
| `apps/web/src/components/train/fixtures/*.json` | DELFI e.V. (via the traines.eu mirror and gtfs.de) | CC BY-SA 4.0, CC BY 4.0 |
| `spikes/sp-4-render/fixtures/rail-segments.json.gz`, `design/variants/data/*.json` | DELFI e.V. and the regional feeds served by Transitous, OpenStreetMap contributors (route geometry) | CC BY-SA 4.0, CC BY 4.0, ODbL 1.0, CC0 1.0 |
| `apps/api/test/fixtures/motis-plan-*.json` | DELFI e.V. (timetable) | CC BY 4.0 |
| `apps/web/public/geo/germany-*.geojson`, `laender.geojson`, `laender-masks/*.geojson` | © GeoBasis-DE / BKG (2026), changed; names from Natural Earth | DL-DE BY 2.0 |
| `apps/web/public/geo/neighbours.geojson`, `border-crossings.geojson` and the Germany outlines of the design variants and spike 4 | Natural Earth | public domain |
| `catalog/operators.yaml`, `catalog/line-colours.csv` | Wikidata contributors, Träwelling contributors, DELFI e.V. (agency names) | CC0 1.0 and CC BY 4.0 |
| `catalog/verbuende.yaml`, `vehicle-series.yaml`, `liveries.yaml` | Wikipedia contributors, Wikidata contributors | CC BY-SA 4.0 and CC0 1.0 |
| `spikes/sp-2-coverage/results/*` | statistics over DELFI, gtfs.de and Deutsche Bahn data | CC BY-SA 4.0 |
| `design/variants/data/ice4-9032-330.jpg` | NAC, via Wikimedia Commons | CC BY-SA 4.0 |
| Map style files under `apps/web/src/map/style/` and the design variants | Zsolt Ero (OpenFreeMap styles), OpenMapTiles contributors, CARTO (Positron design) | MIT, BSD-3-Clause, CC BY 4.0 |

## Services the application uses

The web client loads these at runtime and credits them on the map ("Data sources"):

| Service | Used for | Licence or terms |
| --- | --- | --- |
| OpenFreeMap, OpenMapTiles schema, OpenStreetMap contributors | vector basemap and fonts of the map labels | ODbL 1.0 (data), OpenFreeMap terms |
| VersaTiles | satellite imagery (orthophotos of the Land survey offices, modified Copernicus Sentinel data) | as listed at versatiles.org/sources |
| Mapterhorn | elevation tiles for the terrain style and 3D terrain | as listed at mapterhorn.com/attribution |

The server side reads the feeds listed in [docs/data-sources.md](docs/data-sources.md): DELFI (timetable CC BY 4.0,
realtime CC BY-SA 4.0), gtfs.de, VBB, VBN, Deutsche Bahn, and the feeds of the Netherlands, Czechia, Poland,
Belgium, France and Switzerland. Data that GerLines publishes and that derives from a share-alike source keeps that
licence (ODbL or CC BY-SA).

## Fonts

The web client bundles the Overpass and Overpass Mono typefaces (© The Overpass Project Authors) through the
`@fontsource` packages, under the SIL Open Font License 1.1.
