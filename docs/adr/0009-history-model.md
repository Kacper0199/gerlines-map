# ADR-0009: History as stop events, forecast snapshots, segment observations and histogram rollups

## Status
Accepted (2026-10-23)

## Context
R-07, R-09 and R-16 need per-train, per-segment, per-station and per-Land history; R-18 needs data for delay
prediction. No source provides per-segment history. Public archives exist: piebro/deutsche-bahn-data (CC BY 4.0,
all DB stations since 2025-11, final values only) and Bahn-Vorhersage (ODbL, since 2021, with forecast evolution).

## Decision
- Record from the first wave: `stop_event` (final values), `stop_event_forecast` (every change of prediction),
  `segment_obs` (written when a train reaches the next stop), all TimescaleDB hypertables with columnstore
  compression after 7 days.
- Rollups as continuous aggregates per segment, train, line, station and Land and day, with fixed-bin delay
  histograms so any period merges exactly.
- Punctuality uses DB's definition and is validated against DB's monthly figures.
- Backfill from piebro first; Bahn-Vorhersage for ML training once Mobilithek access exists.
- Nightly Parquet archive for long-term storage and ML.

## Consequences
### Positive
- Statistics never scan raw rows; ML has forecast snapshots from day one.
### Negative
- Forecast table is large: kept 90 days in Postgres, then Parquet only.
### Alternatives considered
- **Derive everything from raw recordings on demand**: too slow for statistics.
- **Store only final delays**: blocks ML (no forecast evolution).

## Date
2026-10-23
