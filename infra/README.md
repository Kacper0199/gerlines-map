# Local infrastructure

`compose.yaml` is the local data stack (Compose project `gerlines`). Every port is bound to `127.0.0.1` only.
`compose.production.yaml` with `production/` is the production overlay for one server behind Cloudflare, prepared
and not deployed (below, Production overlay).

| Service | Image | Host port | Data | Started by |
| --- | --- | --- | --- | --- |
| `db` | `timescale/timescaledb-ha:pg18.6-ts2.31.0` (PostgreSQL 18.6, TimescaleDB 2.31.0, PostGIS 3.6.4) | `POSTGRES_PORT`, default 5433 | volume `gerlines_db-data` | `pnpm infra:up` |
| `valkey` | `valkey/valkey:9.1.3-alpine` | `VALKEY_PORT`, default 6379 | volume `gerlines_valkey-data` | `pnpm infra:up` |
| `centrifugo` | `centrifugo/centrifugo:v6.10.2` | `CENTRIFUGO_PORT`, default 8000 | none | `pnpm infra:up:live` (profile `live`) |
| `live` | built from `services/live/Dockerfile` | `LIVE_PORT`, default 8790 (the API uses 8787) | `LIVE_DIR`, default `../data/live/run` | `pnpm live:up` (profile `live`) |

A PostgreSQL already installed on the host usually listens on 5432. It is not part of this project and nothing here touches it.

Each image is pinned as `tag@sha256:<index digest>` in `compose.yaml` and in `.github/workflows/db.yml` (the
digest of the multi-platform index, so the same pin serves arm64 laptops and amd64 runners). To update one,
change the tag, read the new digest with `docker buildx imagetools inspect <image>:<tag>` (first `Digest:` line),
and update both files together; `src/infra.test.ts` in `@gerlines/db` checks the pins and that CI uses the same
database image.

## Commands

Run from the repository root. `infra/compose.sh` wraps `docker compose`: it reads the root `.env` for the
variable values when that file exists and otherwise uses the defaults, which match `.env.example`.

| Command | What it does |
| --- | --- |
| `pnpm infra:up` | start `db` and `valkey`, wait until both are healthy |
| `pnpm infra:up:live` | the same plus `centrifugo`; it does not start the `live` engine (below) |
| `pnpm live:packs` | build the shape packs the `live` engine needs (below); add `--timetable-version <feed_version_id>` |
| `pnpm live:up` | start the `live` engine on `127.0.0.1:${LIVE_PORT:-8790}` without waiting for its health check, which fails until the packs exist |
| `pnpm infra:ps` | container state and health, every profile |
| `pnpm infra:logs` | follow the logs of every service, every profile |
| `pnpm infra:psql` | `psql` inside the `db` container as `POSTGRES_USER` on `POSTGRES_DB` |
| `pnpm infra:down` | stop and remove the containers of every profile (`live`, `realtime`, `recorder`, `router` too); the named volumes and their data stay |
| `pnpm db:migrate`, `db:rollback`, `db:status`, `db:reset` | migrations, see [packages/db](../packages/db/README.md) |
| `pnpm db:test` | migration integration tests against a throwaway database on `db` |

Plain Compose works too: `docker compose -f infra/compose.yaml up -d` (defaults only, the root `.env` is not read
because Compose looks for `.env` next to the Compose file).

### Live engine: packs first

The `live` service (profile `live`) serves frames that name shape packs of the current shape epoch
(`shape_registry`). Until `LIVE_DIR/s/<epoch>/complete.json` marks them complete it does not tick: it logs "waiting for
packs" once a minute with the missing path and answers 503 on `/healthz` and every other path, so its health check
stays failing. That is why `pnpm infra:up:live` waits only for
`centrifugo` and `pnpm live:up` does not wait at all: check `pnpm infra:ps` and `pnpm infra:logs` instead. Build the
packs into the same directory first, as the container's user (`LIVE_UID`, default 1000, must own `LIVE_DIR`):

```
pnpm live:packs --timetable-version <feed_version_id>
pnpm live:up
```

The build takes about 10 minutes for a national timetable, skips packs already present, and exits 1 when the
geometry gate fails or no shape is linked to the version; the packs are written anyway, but `complete.json` marks
the version only after a full build that passed (a new build drops the mark first), so `live` keeps waiting. `live`
waits for the newest loaded timetable version. Shapes the gate may accept are named by number (`--allow-u-turn-shapes <no>,<no>`, repeated options merge). Build
again for every new shape epoch; `live` reads the epoch when it starts (docs/development.md, Shape epochs and packs).

### Reset

- Schema only: `pnpm db:reset` reverts every migration and applies them again (it refuses any host that is not
  `127.0.0.1`, `localhost` or `::1`).
- Everything, including data: `pnpm infra:down`, then `docker volume rm gerlines_db-data gerlines_valkey-data`,
  then `pnpm infra:up`. This deletes every recording in the database.

`POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB` (default `gerlines`, `change-me-locally`, `gerlines`;
an empty value counts as unset) take effect only when the `db` volume is first created.
After changing them in `.env`, either reset the volume or change the role with `ALTER ROLE` in `psql`.

## Resource limits

Sized for a 16 GB laptop whose Docker VM has 8 to 12 GB:

| Service | Memory limit | Settings |
| --- | --- | --- |
| `db` | 2 GB, `/dev/shm` 256 MB | `shared_buffers` 512 MB, `effective_cache_size` 1536 MB, `work_mem` 16 MB, `maintenance_work_mem` 256 MB, `max_wal_size` 4 GB (rollup refresh cycles, `pipelines/rollups/README.md`), `min_wal_size` 256 MB, `checkpoint_timeout` 15 min, `wal_compression` zstd, `max_connections` 60, 4 parallel workers, 8 TimescaleDB background workers, `random_page_cost` 1.1, statements over 1 s logged |
| `valkey` | 512 MB | `maxmemory` 256 MB with `noeviction` (a full cache fails writes loudly instead of dropping live state), append-only file with `everysec` fsync plus RDB snapshots, so state survives a restart |
| `centrifugo` | 256 MB | in-memory engine |

All settings are visible in `compose.yaml`; `timescaledb-tune` is disabled (`NO_TS_TUNE`) so nothing is changed
behind them. TimescaleDB telemetry is off. On first start the image creates the `timescaledb` and
`timescaledb_toolkit` extensions in `template1` and `POSTGRES_DB`; the migrations manage `timescaledb` and
`postgis` themselves, and tests create their databases from `template0`.

## Centrifugo

`centrifugo/config.json` holds the non-secret settings: anonymous connections without a token (the public map
has no accounts), the namespaces `live` (frame notices) and `train` (per-train detail), clients may subscribe but
never publish, and allowed origins for the Vite dev server on port 5173. The HMAC token key, HTTP API key and
admin credentials come from the environment (`CENTRIFUGO_*` in `.env`) and default to `change-me-locally`, which
is only acceptable because every port is bound to `127.0.0.1`. The production overlay replaces this file with
`production/centrifugo.json` (connect by token only, admin off) and requires real keys.

## Valkey

No password, protected mode off: the port is published on `127.0.0.1` only. The production overlay publishes no
port, turns protected mode on and sets `requirepass` from `VALKEY_PASSWORD` (read from stdin, never in argv).

## Production overlay

Prepared for milestone M10, nothing deployed. `docker compose -f infra/compose.yaml -f infra/compose.production.yaml
--env-file /etc/gerlines/production.env …` adds the `edge` (Caddy, the only published port, 443 on IPv4) and the `api`
(`production/api.Dockerfile`), removes every other published port, puts only the edge on the routed `edge` network, the edge, api, live and
centrifugo on the internal `front` network and the stores on the internal `backend` network, and requires every secret (`${VAR:?}`). Never run it against a local development stack: it uses
the same project name.

| File | What |
| --- | --- |
| `compose.production.yaml` | the overlay (Compose 2.24 or newer for `!reset` and `!override`) |
| `production/Caddyfile` | the edge: Cloudflare as the only trusted proxy, per-hostname Authenticated Origin Pulls with our own CA, forwarding headers stripped from any other peer, `/api/dev/*` 404, security headers |
| `production/centrifugo.json` | Centrifugo: token connect only, admin off, API and health on internal port 9000 |
| `production/api.Dockerfile` | the API image (not built yet) |
| `production/cloudflare-ips.txt`, `cloudflare-ranges.sh` | the Cloudflare ranges and the two env lines made from them, `refresh` to update |
| `production/firewall.sh`, `gerlines-firewall.service` | the origin firewall (nftables, its own table), `print`, `apply` with a 60 s rollback until `confirm`, and its boot unit; never run on a laptop |
| `production/production.env.example` | every variable the overlay requires |

Check it with `bash scripts/check-deploy.sh` (renders with dummy values, starts no service); steps and what is left
to the user in [docs/runbooks/deploy.md](../docs/runbooks/deploy.md).
