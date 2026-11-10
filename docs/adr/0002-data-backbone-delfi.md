# ADR-0002: DELFI GTFS and DELFI GTFS-RT as the data backbone

## Status
Accepted (2026-10-23)

## Context
We need the full national timetable with train numbers and route types, realtime delays and cancellations, and
licences that allow a public site. Options tested in the initial research: DELFI national GTFS (weekly, CC BY 4.0, keyless, train
numbers, extended route types, shapes), gtfs.de (daily, CC BY 4.0, no shapes, no train numbers, every rail route
typed as plain rail), DB API Marketplace (only Timetables, StaDa, FaSta free; RIS partner-only), bahn.de internal
APIs (unofficial, blocking), Transitous (non-commercial, light load, development only).

## Decision
- Static: DELFI GTFS, imported weekly, validated, enriched with canonical categories, operators and EVA numbers.
- Realtime: DELFI GTFS-RT through the de-incremented community mirror until Mobilithek access is granted; VBB and
  VBN realtime as regional supplements; keyless neighbour feeds (NL, CZ, PL, BE, FR) and CH with a key for foreign
  trains.
- Enrichment and validation: DB Timetables (IRIS) for selected DB stations within 60 calls per minute; StaDa and
  FaSta for stations.
- Fallback: the gtfs.de static and realtime pair, consistent with each other.
- Transitous only in development (first light, cross-checks).

## Consequences
### Positive
- One consistent id space for timetable and realtime; train numbers for search and history.
### Negative
- The realtime mirror has no service guarantee; Mobilithek access is pending (K3).
- DELFI realtime is CC BY-SA: published derived data must be share-alike (fits R-28).
- Long-distance realtime coverage must be verified (spike SP-2).
### Alternatives considered
- **gtfs.de as primary**: no train numbers or shapes, needs route-type rewriting.
- **DB RIS APIs**: partner-only or 4,200 EUR per year and up.
- **db-vendo-client**: unreliable, permission formally required.

## Date
2026-10-23
