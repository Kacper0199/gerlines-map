# ADR-0005: AGPL-3.0 code, share-alike derived data, full attribution

## Status
Accepted (2026-10-23); the code licence was chosen within the user's request and can change before
the first public push.

## Context
The user wants a non-commercial project with open code from the start (R-28). Inputs carry licences: OSM (ODbL),
DELFI GTFS and DB Timetables (CC BY 4.0), DELFI GTFS-RT and gtfs.de RT (CC BY-SA), BKG (DL-DE BY 2.0), Bahn-Vorhersage
data (ODbL), Wikimedia photos (mostly CC BY-SA). Useful reference code is AGPL (Transitous scripts) or GPL
(Bahn-Vorhersage, pfaedle as a tool).

## Decision
- Code: AGPL-3.0-or-later. A public service built from it must share its source, which matches a public good
  project and allows reuse of AGPL and GPL-3.0 code.
- Published derived data (rail graph from OSM, statistics and history built from share-alike feeds): ODbL or
  CC BY-SA, matching the strictest input.
- A sources and licences page lists every source, licence, change note and update time; photos carry author,
  licence and link; the map shows OSM attribution.
- No DB or operator branding as our identity; a note that the site is not affiliated with Deutsche Bahn.

Repository visibility (2026-10-24, user): the GitHub repository is private for now and becomes public when the user
decides; the licence applies from the first commit either way.

## Consequences
### Positive
- Transitous use in development is within its policy; reuse of open reference code is possible.
### Negative
- Any fork that runs a public service must publish its changes (intended).
### Alternatives considered
- **MIT**: simpler, but forbids nothing a closed fork might do and blocks copying AGPL code.

## Date
2026-10-23
