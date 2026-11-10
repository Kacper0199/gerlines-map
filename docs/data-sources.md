# Data sources and licences

Every source the product uses, its licence, the attribution it requires and how we access it. This file feeds the
public sources page (WP-9.6). Status as researched on 2026-10-23; recheck a source before relying on a
detail marked unverified.

## Rail data

| Source | Use | Access | Licence and attribution | Notes |
| --- | --- | --- | --- | --- |
| DELFI national GTFS | timetable, stops, train numbers, route types | keyless sharing link on opendata-oepnv.de, weekly (about 515 MB) | CC BY 4.0, "DELFI e.V." | `shapes.txt` exists (303 MB); quality checked in SP-3 |
| DELFI GTFS-RT | delays, cancellations, added trips, alerts | community mirror `stc.traines.eu/mirror/german-delfi-gtfs-rt/`: `latest.original.gtfs-rt.pbf` (as published, about 7 MB) and `latest.gtfs-rt.pbf` (de-incremented, 20 to 42 MB); official on Mobilithek offer 858688352316981248 (K3) | CC BY-SA, "DELFI e.V." | upstream sends partial updates, so the original feed is incremental and the mirror's de-incremented feed accumulates the last 6 h; the mirror keeps one original snapshot per minute (fetched at hh:mm:01) in day folders for the last 1 to 2 days, and older days as brotli tar archives `mirror.traines.eu/german-delfi-gtfs-rt/YYYY-MM-DD.tar.br` (about 2 GB per day, from 2025-03-09) for backfill (checked 2026-10-25) |
| DELFI GTFS extended with EVA numbers (community, traines) | EVA numbers for stop places (joined by position and name, then exactly where a DHID carries the EVA) | `mirror.traines.eu/german-delfi-gtfs/delfi-gtfs-extended-zhv-evaNr.zip` (530 MB, weekly) | CC BY 4.0 and ODbL (its EVA stations partly come from OpenStreetMap through db-hafas-stations) | no DHID to EVA link in the file itself; 87.6 percent of rail stop places matched on 2026-10-19 |
| gtfs.de static and RT | fallback pair | `download.gtfs.de`, `realtime.gtfs.de/realtime-free.pb` (every 10 s, beta) | static CC BY 4.0, RT CC BY-SA 4.0, "gtfs.de" | ids only match gtfs.de static; no shapes, no train numbers |
| VBB GTFS-RT | Berlin and Brandenburg supplement | `production.gtfsrt.vbb.de`, User-Agent required, 60 per minute | CC BY 4.0, "VBB" | partly degraded since 2026-06-04 |
| VBN GTFS-RT | Bremen and Lower Saxony supplement | `gtfsr.vbn.de/gtfsr_connect.bin` | CC BY-SA 4.0, "VBN" | |
| DB Timetables (IRIS) | DB station boards, platforms, messages; long-distance validation | DB API Marketplace (K1), plan Free, 60 per minute | CC BY 4.0, "Deutsche Bahn AG" | too slow to poll every station; selected stations |
| DB StaDa, FaSta | station master data, lifts and escalators; StaDa station names as display names of stop places whose DELFI name lacks the town (a full list in `data/inputs/stada/<date>/`) | DB API Marketplace (K1), Free4All (StaDa 10 calls per second, FaSta 60 per second) | CC BY 4.0, "Deutsche Bahn AG" | StaDa at most one call per day per key for full lists |
| DB OpenStation | station infrastructure (platforms, accessibility assets) as NeTEx and SIRI | DB API Marketplace (K1), plan Zugang, 7,500 calls per day; or Mobilithek offer 879076212433727488; docs at github.com/dbinfrago/openstation-docs | open data, see its licence tab | not all stations complete yet; candidate for station detail and platform positions |
| DB ISR Data Service | not used: infrastructure register (platforms, operating points, line sections, tunnels) | paid, 1,846 EUR per year, railway undertakings only | — | OSM covers our geometry needs |
| bahn.de vehicle-sequence | coach sequence, trainset and UIC numbers (DB long distance) | unofficial endpoint, keyless | no published licence | on demand, cached per train and day, behind a feature flag; may be blocked |

## Foreign trains

| Country | Source | Access | Licence |
| --- | --- | --- | --- |
| Netherlands | OVapi GTFS-RT (`gtfs.ovapi.nl/nl/trainUpdates.pb`) | keyless | free use, attribution "OVapi" |
| Czechia | CZPTT GTFS-RT (`motis.obehy.cz`), includes positions with bearing | keyless | static CC0, RT unstated |
| Poland | Polish trains GTFS-RT (`mkuran.pl`), PKP Intercity shim (`gtfs.kasznia.net`, built on the mkuran.pl data and Intercity announcements) | keyless | CC BY 4.0 for the processing (mkuran.pl, kasznia) over PKP PLK public-sector data, whose re-use terms (bip.plk-sa.pl/ponowne-wykorzystywanie, read 2026-11-05) require the exact source, the time the data was created and acquired, and informing PKP PLK of the processing; the static Polish Trains GTFS is also under the Koleje Mazowieckie public-sector terms |
| Belgium | SNCB GTFS-RT (trip updates and alerts), iRail composition | SNCB: member key in the header `bmc-partner-key` (`SNCB_API_KEY`); iRail keyless | SNCB CC BY 4.0, shown as Source: NMBS-SNCB, Open Data, with the data date added by the display layer; iRail open |
| France | SNCF GTFS-RT via transport.data.gouv.fr proxy | keyless | ODbL |
| Switzerland | opentransportdata.swiss GTFS-RT; Train Formation Service (`https://api.opentransportdata.swiss/formation/v1`, OpenAPI on the cookbook page) | key (K2): GTFS-RT five calls per minute; formation 20,000 calls per day and 50 per minute | terms of use with attribution |
| Austria, Luxembourg, Denmark | static timetables only | various | per portal |

## Map

| Source | Use | Licence and attribution |
| --- | --- | --- |
| OpenStreetMap via OpenFreeMap (development) | vector basemap, OpenMapTiles schema | ODbL, "© OpenStreetMap contributors", "OpenFreeMap © OpenMapTiles" |
| Own Planetiler PMTiles (production) | vector basemap | ODbL, "© OpenStreetMap contributors", "© OpenMapTiles" |
| VersaTiles satellite | satellite style (orthophotos of all 16 Länder, Sentinel-2) | per VersaTiles sources page; credit each provider listed there |
| Mapterhorn | terrain and hillshade | CC BY 4.0 and DL-DE BY or Zero 2.0 per source, credits from mapterhorn.com/attribution |
| BKG VG250 (edition 2026-01-01, folder `vg250_ebenen_0101/2026/`, sha256 pinned in `pipelines/geo_base`) | Germany outline and mask, 16 Länder with focus masks (`apps/web/public/geo/`, built by `pipelines/geo_base`) | DL-DE BY 2.0: "© GeoBasis-DE / BKG (2026)", the licence linked, and the note that we changed the data, wherever it is shown (the map attribution does) |
| Natural Earth | neighbour countries | public domain |
| BKG VG250 `vg250_pk` (same edition) | search places: one point per municipality at its seat, built into `data/search/places-de.tsv` by `apps/api/scripts/build_places.py` | DL-DE BY 2.0, the same notice as the Länder (the map attribution shows it) |
| BKG VG250 `vg250_gem` (same edition) | the town of each stop place for its display name (`gerlines-static-import display-names`): the municipality it lies in and those within 2 km | DL-DE BY 2.0, the same notice as the Länder |
| Natural Earth populated places 5.1.2 (`ne_10m_populated_places.zip`, URL and sha256 pinned in `apps/api/scripts/build_places.py`) | English and Polish names of 54 larger German towns in search | public domain |
| OSM rail (Geofabrik extracts) | track graph and matched shapes | ODbL; our derived rail graph is published under ODbL |
| OSM rail of the neighbouring regions (Geofabrik extracts) | track beyond the border for cross-border shapes and journeys: filtered to rail, clipped to the corridor of the feed's cross-border legs and merged with the German extract (`gerlines-rail-graph corridor`, `neighbours`, `merge-osm`); Geofabrik extracts fetched 2026-11-08, OSM data as of 2026-11-07T21Z: Czechia, Austria, Switzerland, Belgium, Luxembourg, Denmark, six Polish voivodeships, Lorraine, Alsace, Champagne-Ardenne, seven Dutch provinces, Italy Nord-Est; list in `services/router/config/neighbours.txt`, md5 and sha256 per file in `data/inputs/osm-neighbours/<date>/SOURCE.md`; the raw extracts of 2026-11-08 were deleted for disk the same day, their rail filters with sidecars naming each raw sha256 are kept in `data/router/osm/neighbours-2026-11-08b/` | ODbL, "© OpenStreetMap contributors"; extracts by Geofabrik GmbH |

## History and catalogue

| Source | Use | Licence |
| --- | --- | --- |
| piebro/deutsche-bahn-data (Hugging Face), `monthly_processed_data/data-YYYY-MM.parquet` at a pinned revision, sha256 per file in `data/inputs/piebro/<date>/SOURCE.md` | history backfill since 2025-11 (DB Timetables IRIS finals of every DB station), loaded as source `piebro-deutsche-bahn-data`, runs `backfill`, stops `final_only`; older months archived (raw rows dropped, rollups kept, the converted folder `data/backfill/piebro/<month>/` is the reload source) ([history](history.md)) | CC BY 4.0, "Deutsche Bahn train data, collected and processed by piebro, data from Deutsche Bahn" |
| Bahn-Vorhersage station list (`stations.parquet`, Mobilithek offer 940263406913355776) | coordinates of backfilled DB stations the static import does not know | ODbL, "Bahn-Vorhersage, Deutsche Bahn, Derf, Trainline, DELFI" |
| Bahn-Vorhersage dataset (Mobilithek offer 938616012299546624, K3) | ML training, long history with forecasts | ODbL |
| Träwelling line-colors | line badge colours | CC0 |
| transitous-wikidata-operator-matching | operator to Wikidata for names and logos | CC0 |
| Wikimedia Commons | vehicle photos, some logos | per file (often CC BY-SA): author, licence and link shown with each image |
| DB punctuality figures | validation of our statistics | DB website, figures cited, not republished as data |

## Vehicle catalogue and logos

| Source | Use | Access | Licence and rules |
| --- | --- | --- | --- |
| bahn.de vehicle-sequence | exact series, car count and coupled units for DB long-distance and DB Regio trains (layer L0) | keyless, unofficial, browser-like headers; lazy, cached per train and day, about one request per second overall, feature flag | no published terms; HLB and some second trains return 404 |
| Wikidata | series facts (P373 Commons category, P18 image, P2043 length, P2052 speed, P176 maker), operator ids | SPARQL, keyless | CC0 |
| Wikipedia (DE) line lists per Land | line to operator to series rules (layer L2) | keyless | CC BY-SA; rules labelled "Typical for this line", source kept per rule |
| Wikipedia (DE) series articles | dimensions for 3D models, cross-checked with manufacturer data sheets | keyless | facts, not copied text |
| Wikipedia (DE) series articles, table of identical bodies (`catalog/identical-bodies.yaml`) | which series may show the 3D model of another because the car bodies are the same; a pair is accepted only when an article revision says so, each row quotes the sentence and names the revision | keyless, by hand, article revision (`oldid`) in `sources.yaml` | CC BY-SA, one sentence quoted as evidence; the card names the true series and says the model is the related one |
| DELFI `agency.txt` | operator aliases | with the timetable | CC BY 4.0 |
| Wikimedia Commons | photos and logo SVGs | API with a descriptive User-Agent; standard thumbnail widths only (330 and 960 px stored locally) | photos: PD, CC0, CC BY, CC BY-SA only, approved by the user by hand (a pre-selection is published only after the user's review), full attribution; logos: often public domain but trademarked |
| vagonweb.cz, zugfinder.net | manual reference for formations | browsing only | no scraping |

Identity layers shown to the user: L0 Confirmed by coach sequence, L1 Usually runs as (learned from past L0 results
for the same train number), L2 Typical for this line, L3 Typical for this operator, L4 Generic model.

Logo rules: show logos unmodified and only to say who runs the train (referential use), never recoloured, animated
or used as our branding; fall back to a text badge in the brand colour; store the licence per logo file; footer
line "Logos and names are trademarks of their owners. No affiliation."; legal check before public launch (WP-9.6).

## Attribution rules

- The map shows "© OpenStreetMap contributors" linked to openstreetmap.org/copyright and the active style's
  providers.
- The sources page lists every row above with licence name and link, the change note ("processed, aggregated"),
  and the last update time.
- Every photo shows its title (the Commons file name, linked to its file page), author and licence, and says it is
  cropped to 3 by 2 and resized (CC BY 2.0 to 3.0 §4(b) ask for the title, CC 4.0 §3(a)(1)(B) for the change).
- The site states that it is not affiliated with Deutsche Bahn or any operator; names of operators are used
  descriptively.
