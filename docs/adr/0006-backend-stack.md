# ADR-0006: TypeScript services, Python pipelines, Postgres with TimescaleDB and PostGIS

## Status
Accepted (2026-10-23)

## Context
The system ingests several feeds every few seconds, stores about 0.6 M stop events and 0.6 M segments per day,
serves an API and a live stream, and runs batch geometry, statistics and ML. It runs on a 16 GB MacBook first and
must deploy to one modest server later.

## Decision
- Node 24 LTS with TypeScript for ingest, live and API (Hono with OpenAPI from zod). One type system with the web
  client, including the binary frame codec.
- Python 3.13 with uv for pipelines (static import, rail graph, archive, statistics, ML): DuckDB, Polars, PyArrow.
- PostgreSQL 18 with TimescaleDB 2.31 (Community edition) and PostGIS 3.6 as the single system of record,
  `timescale/timescaledb-ha` image on port 5433 locally (the installed Postgres 16 stays untouched).
- Valkey for live state across restarts; Centrifugo for push notices; MOTIS 2 for journeys.
- Monorepo with pnpm workspaces and Turborepo plus a uv workspace; contracts schema-first (protobuf for events,
  zod to OpenAPI for HTTP, SQL migrations for the database).

## Consequences
### Positive
- No own Go or Rust code; every component has a proven open-source base.
### Negative
- Two languages; contracts must be generated, not hand-copied.
- TimescaleDB continuous aggregates are under the Timescale licence: free to self-host, not sellable as a service (irrelevant here).
### Alternatives considered
- **ClickHouse**: faster analytics but weak for frequent upserts; deferred until volume triggers it.
- **Python everywhere**: weaker sharing with the browser client.

## Date
2026-10-23
