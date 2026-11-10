# ADR-0008: Journey planning with self-hosted MOTIS 2

## Status
Accepted (2026-10-23). Spike SP-1, the condition at the time, passed on 2026-10-25: MOTIS 2 imports DELFI with the
rail-only extract on a 16 GB development machine (figures under Negative); the journey API on top of it is built (WP-2.5).

## Context
R-08 asks for A to B search with suggestions and filters that exclude categories (no ICE, no IC). MOTIS 2 (MIT)
supports `transitModes` classes, via stops, transfer limits, alternatives and paging; a live test on Berlin to
Munich returned correct results in 0.19 to 0.28 s. OpenTripPlanner needs about 40 GB of heap for DELFI.

## Decision
Run MOTIS 2 in Compose with the enriched DELFI GTFS, DELFI GTFS-RT and a rail-only OSM extract for route shapes.
Transfers come from the GTFS and MOTIS's own footpaths (`osr_footpath` stays off), and the rail-only street graph
supports station to station search only, not addresses or coordinates. Categories come from the route types of our
enriched feed, so no Lua mapping is needed (WP-2.5: route type equals our category for every train route). Our API
asks MOTIS with `joinInterlinedLegs=false`, so a stay-seated run keeps one leg per trip and category filters see each
leg. Our API wraps MOTIS: post-filters for finer choices
(FlixTrain against IC, RE against RB, operator), ranking (fastest, fewest changes, earliest arrival, latest
departure, later most reliable), earlier and later paging, and a cap of six MOTIS calls in flight.

## Consequences
### Positive
- One open engine for journeys, boards and trip geometry cross-checks.
### Negative
- Memory: spike SP-1 (2026-10-25) measured MOTIS 2.11.4 with DELFI and the rail-only extract at 5.24 GiB peak RSS
  (7.45 GiB footprint) for a two-minute import and about 1.3 GB idle, 2.1 GB under load for the server. The launch
  server serves it; the weekly import runs off the box until a Linux test proves it fits beside the database.
  Street routing for all of Germany was not measured (no headroom on the 16 GB development machine).
### Alternatives considered
- **OpenTripPlanner 2**: heavier, no ready map-trips feed.
- **Transitous public API in production**: forbidden for heavy use.
- **bahn.de via db-vendo-client**: unofficial and unreliable.

## Date
2026-10-23, status updated 2026-11-06
