# SP-2 Realtime coverage by source, category and operator

Spike (requirements R-01, R-07, R-10, R-11). It measures which share of the trains running in Germany has
live data in each realtime source GerLines can use, by category (`hsr`, `ld`, `night`, `rfast`, `reg`, `sbahn`), by
operator and for domestic against cross-border runs. The small result tables are in `results/`.

All outputs except `results/` go to `data/sp-2/` in the main checkout (git-ignored). Recordings under
`data/recordings/` are only read.

## Sources

| Name in tables | Source | How it was read |
| --- | --- | --- |
| `mirror` | DELFI GTFS-RT, community mirror (`delfi-gtfs-rt` recordings, 60 s) | recorder segments, payload every 5 min |
| `mobilithek` | DELFI GTFS-RT, official, Mobilithek subscription (K3) | `scripts/pull-mobilithek.sh`, every 60 s, payload every 5 min |
| `deincr` | hourly de-incremented copy of the mirror (`delfi-gtfs-rt-deincr`) | recorder segment, one payload per hour |
| `gtfsde` | gtfs.de realtime (`gtfsde-rt` recordings) with its fv and rv free static feeds | recorder segments, payload every 5 min |
| `iris` | DB Timetables (IRIS, K1), `plan` and `fchg` for the 20 WP-2.4 stations plus 8098160 | `scripts/iris_sampler.py`, at most 29 requests per rolling minute |

## Method

1. **Universe** (`scripts/universe.py`): DELFI feed of 2026-10-26, train categories and operators from
   `gerlines_static_import` (D-025), trips active on the service day and running at some moment of the window. EVA
   numbers come from the EVA mirror of 2026-10-19 through `EvaIndex`, countries from the national outline. Train-km in
   the window are straight lines between stops, prorated by scheduled time inside the window.
2. **Runs:** duplicates of one train run (same service date, category, train number, first departure and last arrival)
   collapse to one run.
3. **Matching:** DELFI sources by `trip_id` and start date. gtfs.de by its own static feeds, then by stops and times
   to DELFI (`scripts/gtfsde_match.py`, rule of WP-2.3: place within 400 m, minute plus or minus one, at least two
   stops and 75 % of the shorter trip, unique best). The free gtfs.de feeds carry no train number, so the number step
   of the brief is not possible. IRIS by station EVA, train number and planned time within two minutes; trains without
   a DELFI number (FlixTrain) by category prefix and time within one minute. DELFI maps Berlin Hbf to 8011160, which IRIS
   answers with an empty timetable; the IRIS data of 8098160 (Berlin Hbf tief) stands in for it.
4. **Measures per run and source:** `live` (in a payload of the window with at least one stop time update, or
   cancelled), `delay` (a delay or time at a stop whose scheduled time is at or before the fetch time), `nonzero` (some
   delay value other than zero, which separates real data from schedule copies). IRIS: `live` when a fchg of the
   window names the stop with a changed time or a cancellation. Data age per payload is fetch time minus the feed
   header timestamp.

## Rerun

Node 24 on PATH and uv. From the worktree or repository root:

```sh
spikes/sp-2-coverage/scripts/pull-mobilithek.sh <main checkout>/data/sp-2/mobilithek 330
uv run --no-project python -I spikes/sp-2-coverage/scripts/iris_sampler.py <main checkout>/data/sp-2/iris 322
spikes/sp-2-coverage/scripts/analyse.sh 2026-10-29T13:35:00+00:00 2026-10-29T16:10:00+00:00 <main checkout>/data/sp-2/results
```

The IRIS station cover the recorder polls (`IRIS_LONG_DISTANCE_COVER`, D-041 item 1) first came from this 2.5-hour
window. Since 2026-11-08 it is the first 50 of the cover over the whole weekday 2026-11-06 of the DELFI feed of
2026-11-02 (`results/iris-station-cover-gap60-2026-11-06.txt`, the comparison with the window's cover in
`results/iris-cover-compare-2026-11-06.txt`): 44 stations kept, 6 swapped (Ingolstadt Hbf, Singen(Hohentwiel),
Augustfehn, Emmerich(Gr), Göttingen and Osnabrück Hbf in for Leer(Ostfriesl), Rostock Hbf, Kiel Hbf, Berlin Südkreuz,
Gelsenkirchen Hbf and Rheine), still 55 EVAs. Over that weekday the old 55 EVAs covered 82.2 % of the hsr, ld and
night run slots and saw 93.5 % of the runs, the new 55 cover 83.2 % and see 94.4 %.
To recompute it over a full weekday, with no IRIS call (heavy: it reads the whole DELFI feed, so run it alone):

```sh
spikes/sp-2-coverage/scripts/iris-cover-weekday.sh 2026-11-10 <main checkout>/data/inputs/delfi/<date>/delfi-gtfs.zip
```

It builds the universe of that local day (00:00 to 24:00 Europe/Berlin), runs `iris_station_cover.py` for hsr, ld and
night at a 60-minute gap and `iris_cover_compare.py` against the cover in `services/ingest/src/db-apis/stations.ts`
(kept, added and dropped stations among the first 50, the request rate), into `<main checkout>/data/iris-cover/<day>/`.
Added stations need their meta EVAs looked up (Bahn-Vorhersage `meta_evas`) before `stations.ts` changes; the budget
ceiling is about 117 EVAs at full changes every 3 minutes and one plan an hour (41 requests a minute).

The two samplers ran in the background during the window, and their outputs are inputs to `analyse.sh`. They need
`.env` in the main checkout (K1, K3); the scripts read it themselves and keep every secret out of argv and logs.
`analyse.sh` runs the universe, the gtfs.de match, the extraction of recorded payloads, the reduction of every source
and `scripts/coverage.py`, which prints the tables and writes them as CSV with `report.json`. `scripts/q.py` runs
ad hoc DuckDB queries. `scripts/profile_feed.py` lists the field usage of one GTFS-RT payload.

History side (no live calls): one day of the Bahn-Vorhersage parsed delays is read with
`tar -xOf data/inputs/bahn-vorhersage/2026-10-29/2025.tar 2025-10-30.parquet > data/sp-2/bv/2025-10-30.parquet`.

## Results

`results/` holds the tables of the window actually sampled, 2026-10-29 13:35 to 16:10Z (sampling stopped early): `by_category.csv`, `by_border.csv`, `by_operator.csv`, `iris_scope.csv`, `total.csv`, `report.json`
(data age, universe size), `universe-report.json`, `gtfsde_match_report.json`, `iris-station-cover-gap30.txt` and
`-gap60.txt` (greedy IRIS station choice for long distance, `scripts/iris_station_cover.py`) and
`coverage-by-category.png`.

## Licences of the data read

DELFI GTFS and GTFS-RT: DELFI e.V. (Mobilithek offer terms; the mirror per traines.eu). gtfs.de: CC BY-SA 4.0. DB
Timetables (IRIS): CC BY 4.0, Deutsche Bahn. Bahn-Vorhersage: ODbL. piebro/deutsche-bahn-data: data CC BY 4.0
(Deutsche Bahn), code MIT.
