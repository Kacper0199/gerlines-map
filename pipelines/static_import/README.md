# gerlines-static-import

Weekly import of the national DELFI GTFS timetable (architecture §6.1): download, validate, map
routes to canonical categories (§9), attach operators and EVA numbers, load trains into the
database, and write an enriched GTFS for MOTIS.

## Commands

Run from the repository root. `--data` defaults to `<repository>/data`; a worktree passes the main
checkout's folder. `load` writes only to the database named by `DATABASE_URL`; there is no default,
so a forgotten variable can never reach the shared `gerlines` database.

| Command | What it does |
| --- | --- |
| `uv run gerlines-static-import download` | resolves the keyless DELFI sharing link (303 to the Monday file), fetches `data/inputs/delfi/<date>/delfi-gtfs.zip` and the EVA-enriched mirror copy with JSON sidecars; a file whose sha256 matches its sidecar is reused, a transfer cut short by a proxy is resumed with `Range`. Needs `APP_NAME` and `APP_CONTACT` for the User-Agent |
| `uv run gerlines-static-import inventory <zip> --out <csv>` | every rail (route_type, route_short_name, agency) combination with its category and rule; exits 1 when a combination falls back to its route type |
| `DATABASE_URL=… uv run gerlines-static-import load <zip> --eva <mirror zip>` | loads the trains of one feed version in one transaction and writes `data/static/<date>/load-report.json`, `eva-review.csv` and `place-identity.csv`; `--place-overrides` names the reviewed identity decisions (default `pipelines/static_import/place-identity-overrides.csv`); `--categories hsr,ld,night,rfast,reg,sbahn` (default) takes any set of category codes; `--outline` defaults to `apps/web/public/geo/germany-outline.geojson` |
| `DATABASE_URL=… uv run gerlines-static-import display-names --eva <mirror zip> --stada <StaDa json> --vg250 <VG250 zip> [--dry-run]` | after each `load`: a display name that names the town for every stop place whose shown name should differ from DELFI's ("Hauptbahnhof" to "Stuttgart Hbf", "S Ostkreuz Bhf (Berlin)" to "Berlin Ostkreuz", "Köln Ehrenfeld Bf Ehrenfeld" to "Köln Ehrenfeld", "Offenbach (Main)-Bieber Bieber Bahnhof" to "Offenbach (Main)-Bieber", "Witten Witten-Annen" to "Witten-Annen"; the town alone replaces a town and district only when a word follows it or StaDa or the EVA copy name the place so, a municipality's own compound name stays, "Brohl-Lützing Brohl", and a name the rule makes that another place already shows is not used). Rules in order: the normalised DELFI name when it names its VG250 municipality (StaDa's name instead when the town's short name is shared and StaDa adds its qualifier, "Mülheim (Ruhr) Hbf"), StaDa's name by IFOPT or EVA, the EVA mirror's name, StaDa's name as DB writes it, the town and the DELFI name; a town in parentheses is moved first only when it is a municipality's main word and the rest names no town, and areas without a municipality (VG250 IBZ 65) never name a town. Replaces `stop_place_display_name` and `stop_place_search_name` (the timetable name when it names a town, StaDa and EVA names search also finds a station by, scored below a whole word of the shown name); `--dry-run` reads only and reports the counts per rule |
| `DATABASE_URL=… uv run gerlines-static-import products --feed-version <id> [--gtfsde <fv zip>]` | after each `load`, for that feed version: the product (ICE, IC, RE, S ...) of every train, matched from the gtfs.de long-distance static zip and the DELFI route names; writes `trip_product` and prints the coverage per category |
| `uv run gerlines-static-import enrich <zip>` | writes `data/static/<date>/delfi-gtfs-enriched.zip` and `enrich-report.json` |
| `uv run gerlines-static-import subset <zip>` | writes a self-contained feed with only the chosen categories (`delfi-gtfs-trains.zip`); `--trips <file>` keeps only the listed trip ids (one per line), for pfaedle over a new version's new patterns |
| `uv run gerlines-static-import stage-recorded [--monday <date>]` | links the newest (or the named Monday's) DELFI feed the recorder stored (`data/recordings/delfi-gtfs/<fetch day>/`, described in `day.jsonl`) to `data/inputs/delfi/<Monday>/delfi-gtfs.zip` with the sidecar `download` writes, after checking its sha256; the weekly rollover starts here ([runbook](../../docs/runbooks/delfi-rollover.md)) |
| `uv run gerlines-static-import validate <zip> --out <dir>` | runs MobilityData gtfs-validator 8.0.1 in Docker (image pinned by digest) and writes `summary.md` next to the full report |

## Categories

`categories.py` applies, in order: rail replacement buses (`SEV…` on a rail route type) to `bus`,
night lines (`EN`, `NJ`, `<digits>N` such as `27N`) to `night`, the line name prefix (ICE, TGV,
THA, RJX to `hsr`; IC, EC, ECE, ECM, FLX, RJ to `ld`; RE, IRE, MEX, FEX, RX, REX, HBX to `rfast`;
S and RS to `sbahn`; RB and the heritage and narrow gauge lines to `reg`), agency rules for names
that say nothing (`DRF` of European Sleeper and Nachtzug to `night`, LEO Express and WESTbahn to
`ld`), then the extended route type (101 `hsr`, 102 `ld`, 105 `night`, 103 `rfast`, 106 `reg`,
109 `sbahn`, 2 and 100 `reg`). Numeric line names on route type 101 are ICE lines except the
EuroCity and Railjet lines DELFI also files as 101: every numeric ČD, ZSSK, ÖBB or MÁV line and DB
lines 27 (Hamburg, Berlin, Prague, Budapest) and 89 (Munich, Innsbruck, Verona, Venice) are `ld`.
The remaining DB Fernverkehr numeric lines on 101 and the SNCF lines 82 to 84 (TGV) stay `hsr` by
route type, an assumption to recheck when a train number list is at hand. A rail route that only its route type explains, with a name that is
neither empty nor numeric, is loaded with the rule `fallback:<type>` and listed in the load
report. `tests/fixtures/delfi-2026-10-19-rail-routes.csv` is a snapshot of every rail combination of the
2026-10-19 feed with the category and rule the classifier gave it, reviewed by hand once: its tests
catch regressions and fallbacks, they do not prove that a category is right.

`foreign` is set on a trip whose operator's country is known and not Germany (`operators.py`) and on
a trip that calls at no stop in Germany. A stop is in Germany when its id has the `de:` prefix or,
for an id without a country prefix (DELFI has rail stops such as `000010975601` Nordhausen Nord),
when its point lies in the national outline widened by 500 m for its 300 m simplification. The
same rule sets `country_code` on stop places and points; other prefixes give their country
(`at:` AT, `ch:` CH) and a stop without prefix outside the outline keeps no country.

## Stops and EVA numbers

Every stop a train calls at becomes a `stop_point`; its `stop_place` is the parent station, else
the stop place DHID of the stop id (`de:05916:7501:89` to `de:05916:7501`), with DELFI's generic
`_G` suffixes removed (`de:02000:10950_G_G` belongs to `de:02000:10950`). Canonical ids are
UUIDv5 over the GerLines namespace (`ids.py`) and the DHID, else the IFOPT-like id, else
`delfi-gtfs:<stop_id>`; ids already in `id_map` or found by DHID are kept. A place without DHID or
IFOPT is folded into the DHID place of the same station: by the EVA number its id carries
(`000008010191` is EVA 8010191), else by the nearest DHID place within 150 m whose name scores at
least 0.6 and does not differ only by a suffix. Its key stays in `id_map`, mapped to that place.

### One stop place per station across versions

DELFI sometimes gives a station another id from one week to the next. Measured between the
2026-10-19 and 2026-11-02 feeds: renumbered DHIDs at the same point (Karlsruhe
Westbahnhof `de:08212:6005` to `de:08212:6017`, Weißenstein `de:08231:3996` to `de:08231:332`),
reissued Swiss IFOPTs (`ch:23005:826` to `ch:1:sloid:16764` Riehen), DHIDs for places that had
none (five Bernburg halts, the Wipperliese halts whose 2026-10-19 ids carried only an EVA number),
one station whose platforms sat under two district keys in one feed (`de:03159:33817` and
`de:03152:33817` Göttingen, likewise Speele) and one station split into two places (Basel Bad Bf,
DB trains and FlixTrain). A new UUID for such a place splits realtime rows, statistics and history
at the rollover, so after the ids are assigned `identity.py` gives every place that is neither in
`id_map` nor found by DHID the stored identity of the same station:

1. places of one feed whose DHIDs differ only in the district key, with alike names within 300 m,
   fold into one place (the one with a stored identity, else with its own `stops.txt` row, else
   with more stops);
2. reviewed decisions in `place-identity-overrides.csv` (`key,stored,decision,reason`; `stored` is
   a DELFI key of the stored place, its DHID or IFOPT, or its `stop_place_id`): `same` gives the
   place that identity and folds the place of the feed that holds it into it, `separate` keeps a
   pair apart and gives a place an earlier load merged by mistake its own identity again: the key
   then maps to the new place in `id_map` (the one remap `load` makes) and the stored place gives
   up the DHID or IFOPT the new place carries. `separate` acts on one key; a later new key of the
   station, keys folded into the merged place before and history recorded before the split stay
   as they are (see the rollover runbook). A path given with `--place-overrides` must exist;
   overrides whose key is not in the feed are listed as `skipped`;
3. a stored place no other place of this feed holds, by the first rule that fits: a district twin
   (above), an EVA number both ids carry (`000008010204` and `de:15087:8010204`) within 1 km, the
   same name within 100 m (case, umlauts and Bahnhof or Bf ignored; S, U, ZOB, tief and other
   qualifiers kept). Each stored place goes to one place, best rule and shortest distance first.

Two places present in the same feed never merge without an override, so platform groups, S-Bahn
tunnel stations under a main station and neighbouring halts keep their own places. EVA numbers of
the spatial join are no key: it gives a bus station or a narrow gauge timing point next to a
station that station's number. Every reuse, fold and refused candidate (a stored place another
place of the feed holds) is listed in `data/static/<date>/place-identity.csv` and counted under
`stops.identity` in the load report; a place known by key keeps its id, so the rule never moves a
station that already has one. Places that end with one stop place id (an old key back next to the
key an earlier load gave its place) fold into one place (`folded`, kind `same_identity`).
`review` rows ask for a look: district twins that were both stored places (their points now share
one place while `id_map` keeps the folded key on the other) and name matches that agree only once
Bahnhof or Bf is set aside (a bus stop named X Bahnhof next to the railway station X Bf).

The EVA mirror adds DB stations to `stops.txt` as seven-digit stop ids without a link to DHIDs.
Two passes fill `stop_place.eva`. The exact pass takes the number a stop id carries (a DHID whose
station part is `80xxxxx`, such as `de:15002:8010159`, or `00000` and an EVA number) when the
mirror has that station within 2 km. The spatial pass matches the other places to the best EVA
station within 600 m: a name score (token overlap or sequence ratio after folding umlauts,
`Hauptbahnhof` to `hbf` and dropping `Bf`, `S`, `U`) of at least 0.5 within 150 m, at least 0.8
beyond, never a station whose name differs only by Nord, Süd, Ost, West, Mitte or Hbf. The spatial
pass also runs on the exactly matched places; its agreement with the exact numbers is reported as
`stops.eva_methods.spatial_precision`. Every match and miss is in `eva-review.csv` with its method. The closest place of each EVA number is written to `id_map` under the source
`traines-delfi-eva`; all matched places carry the number in `stop_place.eva`.

## Tables

One feed version is identified by `(source_id, sha256)` of the zip. Loading the same zip again
empties and refills that version under the same `feed_version_id`, so two runs give identical
rows. A transaction-scoped advisory lock per source refuses a second import while one runs. Before
the transaction commits, the counts read from the feed are reconciled with the stored counts per
category, and SQL checks that every trip has as many stop times as its pattern has stops, with
positions 0 to n−1, and that its first departure and last arrival equal its first and last stop
times; any difference rolls the version back.

| Table | Content |
| --- | --- |
| `feed_version` | one weekly DELFI zip: `published_on`, `feed_info` version and validity, sha256, the raw object, the category set, the stored counts, `status` |
| `route` | GTFS routes of the category set with operator, route type, category and the rule that chose it |
| `service_calendar`, `service_calendar_date` | GTFS calendar (weekdays as a bit mask, Monday = bit 0) and exceptions of the services the trips use |
| `trip_pattern`, `trip_pattern_stop` | distinct (route, stop sequence, DELFI shape_id) with the stop points in order |
| `trip` | one GTFS trip: pattern, service, DELFI `shape_key`, train number (`short_name`), category, `is_foreign`, first and last time |
| `stop_time` | times in seconds after noon minus 12 h of the service day, by position in the pattern |

Times are GTFS times: seconds after noon minus 12 h of the service day, which is midnight except on
the two daylight saving days. They pass 86,400 for trips that run after midnight: in the
2026-10-19 feed 4,907 train trips start 24 h or more after that reference (3,563 of them S-Bahn)
and the latest arrival is 38.97 h. A query for the trains of day D therefore reads the services of
days D and D−1, and the conversion to clock time needs a test on a DST day such as 2026-10-25.

## Enriched GTFS for MOTIS

`enrich` copies every member of the feed unchanged except `routes.txt`, where each rail route
gets the route type of its category (`hsr` 101, `ld` 102, `night` 105, `rfast` and `reg` 106,
`sbahn` 109; replacement buses 714, other buses 700) and a column `gerlines_category`. MOTIS
(nigiri `to_clasz`) maps 105 to its night class, 109 to suburban and 106 to regional; it has no
fast regional class, so `rfast` and `reg` stay apart only in our database.
