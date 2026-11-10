# ADR-0011: Vehicle identity in confidence layers, with honest labels

## Status
Accepted (2026-10-23)

## Context
R-12 and R-13 ask for the correct vehicle photo and 3D model of each train. No feed carries vehicle data. The
official DB formation API (RIS::Transports) is limited to railway undertakings. The unofficial bahn.de
vehicle-sequence endpoint returns UIC vehicle numbers for DB long-distance and DB Regio trains, keyless, but not for
other operators (HLB tested: 404). Regional fleets change with every tender.

## Decision
Resolve each trip to `{series, variant, units, confidence, layer, source}` through five layers: L0 exact from
vehicle-sequence (lazy, cached per train and day, about one request per second overall, behind a feature flag), L1
learned from past L0 results, L2 operator and line rules seeded from Wikipedia line lists, L3 operator default, L4
generic model per category. The card always says which layer produced the answer ("Confirmed by coach sequence",
"Usually runs as", "Typical for this line", "Typical for this operator", "Generic model").

## Consequences
### Positive
- Every train gets a plausible model and photo; users see how certain we are.
- L1 improves with use without any new source.
### Negative
- Depends on an unofficial endpoint for the exact layer; if blocked, L1 freezes and L2 to L4 remain.
- Line rules need refreshing at each timetable change (mid-June, mid-December).
### Alternatives considered
- **Only exact data**: most regional trains would have no model.
- **Only rules**: wrong for coupled units and substitutions, and no way to learn.

## Date
2026-10-23
