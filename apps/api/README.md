# apps/api

HTTP API of GerLines (Hono on Node 24). Run with `pnpm --filter @gerlines/api dev`; it listens on
`127.0.0.1:${API_PORT:-8787}`.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /api/health` | liveness of the API itself |
| `GET /api/v1/journeys` | journeys between two stops from MOTIS, with category, product and operator filters, ranking and paging (WP-8.1); `geometry=true` adds each leg's route line (WP-8.2) |
| `GET /api/v1/journeys/reliability` | punctuality of up to 30 trains (`train=<category>~<number>[~<operator>]`, repeated) over the last 30 Berlin days from the statistics rollups: the share of arrivals less than 6 minutes late with the arrivals, runs and first recorded day, or the reason it is missing; cached 5 minutes; one punctuality lookup per uncached train against the client's 60 a minute (WP-8.2) |
| `GET /api/v1/router/health` | whether MOTIS answers its health endpoint, with the latency; MOTIS is asked at most once per 5 s and every request in that time gets the same answer |
| `GET /api/v1/trains/{id}` | the train detail the live engine keeps in Valkey for a running or recent trip instance (UUID): 404 when unknown, 503 when `VALKEY_URL` is not set or the engine has not confirmed for 30 s; cached 5 s with a strong ETag; 120 a minute per client; `vehicle` and `photo` from the catalogue database within 150 ms each, else null; with `PREDICTION_TABLE` (absolute path to the B1 table of `gerlines-predict table`) and the search index, `forecast` holds the forecast of the stops ahead (the feed's predicted delay with B1's spread where the feed has one, `basis: feed_plus_spread`, else B1, `basis: b1`; D-065), else null ([docs/predictions.md](../../docs/predictions.md), WP-7.5) |
| `GET /api/v1/live/keys/{key}` | the trip instance a live frame key (0 to 4294967295) stands for; cached for an hour; 120 a minute per client |
| `GET /api/v1/search` | stations, trains, lines of today's timetable and places for a typed text (WP-4.7); each station has a `stopId` for the journeys route: its DHID, else the newest `stop_place` key of the timetable source in `id_map` (DHID-shaped keys first), null when it has none or the key breaks the contract; the index of a new day or timetable version is checked and built in slices of 1,000 records with a turn of the event loop between them (about 6 ms a slice and 0.3 s in all on 56,000 records, so other routes keep answering) |
| `GET /api/v1/stations/{id}` | one station of the search index by its stop place id, for a link that names it |
| `GET /api/v1/stats/today`, `/period`, `/trains/{number}`, `/lines/{line}`, `/stations/{id}`, `/lands/{code}` | punctuality, cancellations and delays from the rollups for today, a period of up to 366 days, a train, a line, a station and a Land; 60 a minute per client, 10 for periods over 31 days; [docs/statistics.md](../../docs/statistics.md) (WP-7.2) |
| `GET /api/v1/stats/trains/{number}/segments` | the segment profile of a train number against every train on each segment (R-09, WP-7.4a, [docs/statistics.md](../../docs/statistics.md), Segment profile) |
| `GET /api/v1/photos` | every approved vehicle photo with its credit, for the credits page; cached an hour (WP-6.3) |
| `GET /api/v1/photos/{file}` | one stored photo copy by its immutable name (photo id, width class, start of its SHA-256), looked up in the catalogue and never joined into a path; cached a year; 300 a minute per client |
| `GET /api/v1/status` | how fresh each data source of the map is (WP-9.7a): per source its newest recorded payload, the newest payload the live engine folded, the recorder's staleness threshold and a state, and the live engine's frame age (Data status below); one answer per 30 s for all clients; 60 a minute per client |
| `GET /api/v1/openapi.json` | OpenAPI 3.1 of every route in this table, with the answers built from their zod schemas; cached 5 minutes. `src/search/openapi.test.ts` fails when the app registers a route the document lacks, or the document names a route the app does not register |

### Data status

`GET /api/v1/status`, behind the live bar's status dot (`src/status/`, schema `@gerlines/schema/status`).

- **Sources.** One entry per source of the map as a viewer sees it (`src/status/feeds.ts`): the DELFI timetable,
  DELFI realtime (Mobilithek and the traines.eu mirror together), gtfs.de realtime, DB IRIS (every
  `db-iris-fchg-*` station source) and the neighbours (OVapi, NMBS SNCB, SNCF, opentransportdata.swiss, CZPTT,
  PKP Intercity, mkuran.pl), each with the provider's name, the country and a kind (`timetable`, `realtime`,
  `iris`, `neighbours`).
- **Source of truth.** The rows the recorder writes, read only: `recordedAt` is the newest `raw_object.observed_at`
  of the entry's recorder sources (an unchanged or not modified answer stores no row, so it can trail the
  recorder's last success by one period; a timetable by days), and a running `record` run in `ingest_run` says
  the recorder fetches it now. From Valkey: `dataTime` is the newest payload of those sources the live engine
  folded (`live:detail:feeds`, as on the train card), the frame age is the age of its last confirmed tick
  (`live:detail:confirmed`). Recorder status files are not read: the API does not have the recordings in
  production.
- **States.** `ok` within the threshold; `stale` past it, or when the map's payload is older than it; `down` after
  an hour without a new payload (or three thresholds, if longer) or without a running record run; `not_recorded`
  without any stored payload (DB IRIS while the recorder's lane is off). Thresholds are the recorder's
  (`recorder status`, 300 to 1200 s; DB IRIS 540 s); timetables have none and are `ok` while they are fetched. The
  live engine is stale after 30 s, down after 15 min or without a confirmation, `not_recorded` when Valkey is not
  set or does not answer. A crashed recorder leaves its run `running` (no heartbeat, `finished_at` stays null), so
  its feeds read stale past their threshold and down after an hour without a stored payload; a timetable, which has
  no threshold, stays `ok`.
- **The popover** (`apps/web/src/status/`) measures the live line from the viewer's own map first: the wall time of
  the newest live head that moved the time on, from the live worker. So it holds with `LIVE_DETAIL=0`, when the
  engine writes no `live:detail:confirmed` and this route says the engine is down, and it is as old as the frame now.
  Without such a head (a replay, none yet) it takes `frameAgeSeconds` plus the answer's age, 30 s less `max-age`
  plus a CDN's `Age`, plus the time since it arrived; the request skips the browser cache. Map times per source need
  the engine's details: without a confirmation the rows leave them out instead of saying Not on the map.
- **Caching and errors.** One read per 30 s shared by all requests (`Cache-Control: public, max-age` with the
  seconds left), about 8 ms on `gerlines` (11 source rows by the `(source_id, observed_at)` index). 503
  `not_configured` without a database; 503 `status_unavailable` while the rows cannot be read: a failed read is held
  for its 30 s like an answer, so a slow or stopped database gets one read per 30 s, and `Retry-After` names the
  seconds left; a Valkey failure only empties the live fields. Answers and logs carry no address,
  path or key of a store (logs name the error class only).

### `GET /api/v1/journeys`

| Parameter | Meaning |
| --- | --- |
| `from`, `to` | DELFI stop ids without the dataset tag, the `stopId` of a search answer: a DHID such as `de:11000:900003201`, or the feed's own id of a station without one such as `ch:1:sloid:10` |
| `time` | ISO 8601 with an offset, `Z` (`2026-10-27T06:00:00Z`) or a numeric one with the plus encoded as `%2B` (`2026-10-27T07:00:00%2B01:00`); a plus sent unencoded arrives as a space and is read back as the offset sign; now when left out |
| `arriveBy` | `true` or `false` (default) |
| `categories` | comma list of `hsr`, `ld`, `night`, `rfast`, `reg`, `sbahn`, `urban`, `bus`, `other`; all when left out |
| `exclude` | comma list of `ic`, `flx`: long-distance products to leave out |
| `operators` | comma list of up to 5 operator names; every leg must run with one of them |
| `avoidOperators` | comma list of up to 5 operator names no leg may run with |
| `maxChanges` | 0 to 8, sent to MOTIS as `maxTransfers`; 0 means direct trains only |
| `sort` | `fastest`, `fewestChanges`, `earliestArrival` (default) or `latestDeparture` (default with `arriveBy=true`) |
| `results` | 1 to 10 (default 5): at least this many journeys wanted after the filters, when the router has them; a minimum, not a cap: the answer holds every journey of the pages searched that passes the filters, so a filtered search can answer a dozen journeys for `results=1` |
| `cursor` | `earlierCursor` or `laterCursor` of a previous answer (`EARLIER\|<digits>` or `LATER\|<digits>`), with the same other parameters |

The categories become MOTIS `transitModes`; without `categories`, or with all nine, the API sends no
`transitModes` and MOTIS searches every mode. `FUNICULAR` is asked for with `urban` (route type 7) and with `other`
(route types 1400 and up); the deprecated `METRO` is never sent. The API asks with `joinInterlinedLegs=false`, so each
trip of a stay-seated run is its own leg with its own route type, and a later leg of the run has `staySeated: true`.
Every leg's category comes from its GTFS route type in the enriched
feed (our own rules, D-025) and, for route type 106, the line name (`rfast` for RE, IRE, MEX, FEX and the other
prefixes of `pipelines/static_import`), never from the MOTIS mode alone: MOTIS reports one class for a whole
stay-seated run. A journey with any leg outside the chosen categories or products is removed and counted in
`removedByFilter`. When `rfast` and `reg` are split, or a product is excluded while `ld` is chosen, the API asks MOTIS for 12
instead of 5 itineraries first. With a `cursor`, `query.time` is `null` (MOTIS pages from the cursor, not a time).
A transit leg's `run` names the train's trip instance (the id of `GET /api/v1/trains/{id}`) with its planned first
departure and last arrival, read from the MOTIS trip id (service date and DELFI trip key) through the search index;
it is null when the index does not hold that service day, and when the index's run under that trip key does not start
at the trip id's first departure, does not hold the leg's planned departure or carries another train number:
DELFI trip ids belong to one feed version, and after a rollover the index may load a newer version than MOTIS routes
on until MOTIS is reimported, so a reused id must not link another train.

An operator name matches when a word of the operator's name starts with it, ignoring case and accents (`DB` matches
`DB Regio AG Bayern` but not `ODEG`, `Flix` matches `FlixTrain-de` and `FlixBus-de`, `Osterreichische` matches
`Österreichische Bundesbahnen`). A leg without an operator fails `operators` and passes `avoidOperators`. Operator
filters, like the RE against RB split, are post-filters: MOTIS cannot apply them, so the API asks for 12 itineraries.
They only see the journeys MOTIS finds optimal for the chosen categories: between München and Augsburg with all
categories MOTIS answers ICE and IC only, so `operators=Arverio` finds nothing there unless `categories` is narrowed to
regional trains.

Fill-up: when fewer than `results` journeys pass the filters, the API follows `laterCursor` (or `earlierCursor` with
`arriveBy=true` or an `EARLIER` cursor) and searches the next page with the same query, at most three MOTIS calls per
request and none started after 4 s. Each fill-up page may take only what is left of the 4 s (at least 1 s, never more
than the 20 s plan timeout), so a late page cannot hold one of the six router slots for long; a page that runs out of
time counts like a failing one. Journeys seen on an earlier page are dropped. The answer's cursors are those of
the outermost pages searched, so the next request continues where this one stopped. A failing later page (busy,
unavailable, rejected, timed out) ends the search with what was found and `partial: true`.

Ranking: the journeys are ordered by `sort`, each order breaking ties by the other criteria and finally by `id`, so it
is total. `tags` names the criteria on which a journey is the best of the answer (each criterion tags one journey).
`id` is 16 hex digits of a SHA-256 over the trips, stops and times of the legs: the same journey keeps its id across
pages and sorts.

Answers: 200 with the `JourneysResponse` contract of `@gerlines/schema/journeys`: `query` (the parsed query, `time`
`null` with a cursor), `journeys` (id, times, transfers, categories, operators, tags, legs with category, line, trip
number, operator, stop ids, times, realtime flag, `staySeated`), `removedByFilter` with `removedBy` per reason
(`category`, `product`, `operator`; a journey counts once, by the first reason in that order), `routerCalls`, `partial`,
`earlierCursor` and `laterCursor`. Errors: 400 `invalid_request` with `issues`; 404 `stop_not_found`; 422
`router_rejected` (for example a time outside the timetable); 429 `rate_limited` with `Retry-After` after 30 requests per
client and minute (client address as in [Clients and limits](#clients-and-limits)); 503 `router_unavailable` or `not_configured`;
503 `router_busy` with `Retry-After: 1` when 6 MOTIS calls are already in flight (each page of a fill-up is one call).
When MOTIS answers 404 naming the origin or destination (a station the importer built from platform ids, without a
stops.txt row), the request is asked again once per side with a platform row of that station, and those calls count
toward the three; `stop_not_found` comes only after that retry, and the retry can answer `router_busy`.
404 and 422 carry a fixed `message` per code; the router's own text goes only to the server log. Every answer is
`Cache-Control: no-store`.

## Configuration

Each part of the API starts only with its settings; without them its routes answer 503 `not_configured` (or the
detail keeps the field null) and the server says so once at start.

| Variable | Enables |
| --- | --- |
| `ROUTER_BASE_URL` (`ROUTER_DATASET_TAG`, default `de-DELFI`), `APP_NAME`, `APP_CONTACT` | journeys and router health |
| `SEARCH_DATABASE_URL`, `SEARCH_PLACES_FILE` | search and stations; the forecast reads stop names and EVA numbers from this index |
| `STATS_DATABASE_URL` (falls back to `SEARCH_DATABASE_URL`) | statistics, the segment profile and journey punctuality |
| `STATUS_DATABASE_URL` (falls back to `STATS_DATABASE_URL`, then `SEARCH_DATABASE_URL`) | the data status; a read-only role on the database the recorder writes is enough, and its connections open with `default_transaction_read_only=on` whichever role they use |
| `VALKEY_URL` | the train detail and live keys the engine writes; the live engine's frame age and map times in the data status |
| `VEHICLE_DATABASE_URL` (`VEHICLE_SEQUENCE_ENABLED=1` for the bahn.de coach sequence) | `vehicle` in the train detail |
| `PHOTO_DIR` (absolute path) with `VEHICLE_DATABASE_URL` | the photo routes and `photo` in the train detail |
| `PREDICTION_TABLE` (absolute path) | `forecast` in the train detail |
| `API_TRUSTED_PROXIES`, `API_CLOUDFLARE_RANGES` | the client address behind a proxy (Clients and limits) |
| `API_HOST`, `API_PORT` | listening address (default `127.0.0.1`, `0.0.0.0` in the production container), port |

`.env.example` (root) lists most of them; `VALKEY_URL`, `VEHICLE_DATABASE_URL`, `VEHICLE_SEQUENCE_ENABLED`,
`PHOTO_DIR` and `ROUTER_DATASET_TAG` are read by the code but not listed there yet.

## Clients and limits

Every limit counts per client in the memory of one API process (`src/limits.ts`, `src/client-limit.ts`); the per-IP
limit at the edge stays the outer guard.

- **Client address.** A socket peer outside `API_TRUSTED_PROXIES` is the client. Behind a trusted peer (Caddy) the
  rightmost `X-Forwarded-For` hop that is not itself a trusted proxy is the client. `CF-Connecting-IP` counts only when
  that hop, or the socket peer, is in `API_CLOUDFLARE_RANGES` (the ranges of https://www.cloudflare.com/ips/), so a
  visitor who reaches the origin directly cannot pick its own key by sending the header.
- **Key.** An IPv4 address as it is, an IPv6 address by its /64. When a limiter holds 50,000 keys, a new key is counted
  in an overflow table by its /48 (IPv4 as it is) under four times the limit, so one network that fills the table
  locks out only itself. When the overflow table holds 50,000 keys too, a newcomer is counted in a network table by
  its IPv6 /32 or IPv4 /16 under four times the limit, so one provider that fills both tables locks out only itself;
  only when the network table holds 10,000 keys as well do newcomers share one window. A full limiter (110,000
  windows) holds about 16 MB of heap and drops them in about 15 ms once they expire (measured on an M1 Pro with
  Node 24), so the ten limiters of one process hold at most about 165 MB; the edge limit keeps them far
  from full.
- **Per minute.** Search and stations 120, statistics 60 (10 more for periods over 31 days), journeys 30, punctuality
  lookups 60 (one per uncached train number), train details 120, live keys 120, data status 60, photo files 300.
- **Gates.** At most 6 statistics queries at once over the statistics and punctuality routes, as many as the pool has
  connections: each read takes the queries it runs at once (network 6, Land 5, station 4, train and line 3), a
  punctuality request reads one train at a time and so holds at most 3 (503 `stats_unavailable` with
  `Retry-After: 5` past them; the pool waits at most 2 s for a connection; a failing read is logged at most once a
  minute with the count of the lines held back), 6 MOTIS calls, 4 vehicle identity reads (a detail past them answers
  with `vehicle: null`). Each client, an IPv6 /48 or an IPv4 address, may cause at most 30 bahn.de coach sequence
  calls an hour (`VEHICLE_SEQUENCE_ENABLED=1` only).
- With `NODE_ENV=production` the server refuses to start unless `APP_NAME`, `APP_CONTACT`, `API_TRUSTED_PROXIES` and
  `API_CLOUDFLARE_RANGES` are set, and refuses an entry of either list with a prefix shorter than /8 (IPv4) or /16
  (IPv6): without them every visitor would share the edge's limiter key, or could forge `X-Forwarded-For` or
  `CF-Connecting-IP` (`checkProductionSettings`
  in `src/config.ts`; the production stack in [docs/runbooks/deploy.md](../../docs/runbooks/deploy.md)).

## Tests

`pnpm --filter @gerlines/api test` runs over recorded MOTIS answers in `test/fixtures/motis-plan-*.json` (made with
`scripts/record-router-fixture.mjs`, geometry dropped). `src/journeys/live.integration.test.ts` (12 tests: every filter, each sort, paging, fill-up, `maxChanges`, `arriveBy`) runs only when
`ROUTER_BASE_URL`, `APP_NAME` and `APP_CONTACT` are set and the router is up; it asks for the next Tuesday 07:00
Berlin time and skips with a reason when that day is outside the loaded timetable.
