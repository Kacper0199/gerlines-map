# tools/load

Load test of the live push path and the API with [k6](https://grafana.com/docs/k6/) (WP-9.4). There is no server yet:
every number below was measured on the development laptop (M1 Pro, 16 GB, Docker Desktop), with k6, the services and
the database on the same machine. They show how the code behaves under load and where it breaks first; they are no
statement about the production server, its network or Cloudflare.

## What runs

| Part | How | Port |
| --- | --- | --- |
| Valkey, Centrifugo | `infra/compose.sh --profile live up -d valkey centrifugo`, by name only; stopped again only if this run started them | 6379, 8000 |
| Live engine | `node services/live/src/cli.ts run --clock replay:<ISO>:1` on a replay database, frames into `LOAD_DIR/live` with `s` linked to a packs directory | 8814 |
| API | `api-replay.ts`: the real `createApp` of `apps/api` on `@hono/node-server`, its clock moved onto the engine's replay clock (the train detail's 30 s confirmation check), `API_TRUSTED_PROXIES` set to the loopback and Docker Desktop's host range | 8815 |
| k6 | `grafana/k6:2.3.0` pinned by index digest in a container on the Compose network `gerlines_default`, memory limit 1.5 GiB; Centrifugo by service name, the engine and API through `host.docker.internal` (`--add-host host.docker.internal:host-gateway`) | none |

| Script | Measures |
| --- | --- |
| `k6/push.js` | `CLIENTS` WebSocket clients (100 per VU over `k6/websockets`) connect to Centrifugo with its JSON protocol over `RAMP_S` seconds, subscribe to `live:frames` (the engine's head notices) and `live:probe`, and stay `HOLD_S` seconds. A publisher sends one probe a second through Centrifugo's HTTP API with its send time; each client records the delay to its arrival. Connect time is from `new WebSocket` to the connect reply. |
| `k6/api.js` | constant arrival rate per route for `DURATION_S` seconds, each request from its own `X-Forwarded-For` address (10.0.0.0/8) behind the trusted loopback peer, so the per-client limits of the API do not apply as they would not for thousands of visitors; latency and outcome per route |
| `k6/traffic.js` | `FOLLOWERS` clients that follow the live frames as the web client does (`apps/web/src/live`): the keyframe on joining, then each new delta, all with `Accept-Encoding: br, gzip`; with `MODE=poll` (the default, the client before push notices) the head every second, with `MODE=push` (`LOAD_TRAFFIC_MODE=push`, the client with push notices) the head when subscribed to `live:frames`, on each notice of a new head and after 10 s without a read; bytes on the wire per client and minute, notices and pings included |

## Run

```bash
export LOAD_DIR=/absolute/scratch/dir              # state, logs and results
export LOAD_LIVE_PACKS=/absolute/data/live/packs-t102/v1
export LOAD_MARKER=/absolute/data/locks/heavy-<id>.txt
# database (POSTGRES_* read only), VALKEY_URL ending in its own database number, CENTRIFUGO_URL and
# CENTRIFUGO_HTTP_API_KEY (the placeholder key needs LIVE_LOCAL_STACK=1), SEARCH_, STATUS_, STATS_DATABASE_URL
tools/load/run.sh all
```

`all` refuses to start under 40 % free memory (`memory_pressure` on macOS, `MemAvailable` of `/proc/meminfo` on
Linux) or 41.0 GiB free disk on the file system of `LOAD_DIR`, writes the marker (owner from `LOAD_OWNER`), starts
the stack, runs push at `LOAD_CLIENTS` (default `500 1000 3000`), the API at the base rate and four times it, and the
traffic run, then stops what it started and removes the marker in a trap. A guard checks every 10 s during each k6 run
and kills k6 under 25 % free memory or 41.0 GiB free disk; later stages are then skipped. `LOAD_STAGES` picks stages
(`push api traffic`). Single steps: `up`, `push N`, `api NAME FACTOR`, `traffic`, `down`. Results:
`LOAD_DIR/results/<run>.txt` (summary), `<run>.json` (all metrics), `<run>.resources.csv` (CPU and memory of
Centrifugo, Valkey, k6, the engine and the API every 5 s).

From a worktree without `.env`, `infra/compose.sh` gives Centrifugo the placeholder keys of `compose.yaml`; the
runner passes `CENTRIFUGO_HTTP_API_KEY` to k6 by name only, never in a command line.

On Linux `host-gateway` is the address of the host on the Docker bridge, while the engine and the API listen on
127.0.0.1 only, so the `api` and `traffic` stages reach them only on Docker Desktop; `push` needs no host access. The
default `LOAD_TRUSTED_PROXIES` names Docker Desktop's host range.

## Results, 2026-11-08 (local machine only)

Setup: `live run` on `gerlines_replay` read only (Sunday 2026-10-25, replay clock from 15:00Z at 1x, 2,125 trains in
frames, packs `data/live/packs-t102/v1`), Valkey and Centrifugo from `compose.yaml` (Centrifugo memory limit 256 MiB),
the API from `api-replay.ts`. Memory free on the laptop stayed between 35 % and 46 %, disk 45.2 GiB.

### Push fan-out through Centrifugo

Ramp 15 s, hold 60 s, one probe a second (55 probes), 100 sockets per k6 VU.

| Clients | Connected | Connect p95 (max) | Delivery p95 (p99, max) | Probes delivered | Errors | Centrifugo peak |
| --- | --- | --- | --- | --- | --- | --- |
| 500 | 500 | 4 ms (11) | 11 ms (17, 18) | 27,500 of 27,500 | 0 | 54 MiB, 6 % of a core |
| 1,000 | 1,000 | 4 ms (13) | 19 ms (24, 28) | 55,000 of 55,000 | 0 | 76 MiB, 10 % |
| 3,000 | 3,000 | 2 ms (69) | 57 ms (114, 142) | 165,000 of 165,000 | 0 | 148 MiB, 44 % |

Errors count failed connects, socket errors, error replies and closes before the end. The delivery delay includes
k6's own event loop (k6 used up to 40 % of a core and 327 MiB at 3,000 clients) and Docker Desktop's network, both on
the same laptop. The engine's head notice arrived 8 to 13 times a minute per client.

### API

60 s per rate, each request from its own address. Base rate 60 requests a second (train detail 20, live keys 20, search
10, stations 5, data status 5), then four times that.

| Route | Answer in this run | p95 base (p99) | p95 at 4x (p99, max) |
| --- | --- | --- | --- |
| `GET /api/v1/live/keys/{key}` | 200, Valkey read | 6.1 ms (14.2) | 5.7 ms (19.6, 178) |
| `GET /api/v1/status` | 200, the shared 30 s answer | 3.9 ms (9.7) | 2.9 ms (9.2, 60) |
| `GET /api/v1/trains/{id}` | 404 only: no detail in Valkey | 5.8 ms (14.5) | 5.7 ms (19.3, 180) |
| `GET /api/v1/search` | 503 only: no index | 3.6 ms (8.7) | 2.6 ms (7.9, 88) |
| `GET /api/v1/stations/{id}` | 400 only: no station ids without search | 3.5 ms (5.6) | 2.8 ms (7.2, 72) |

No request failed at the connection and none was rate limited. The API process peaked at 172 MiB and 7 % of a core.

`gerlines_replay` predates migration 0055: the engine's detail writer fails on every batch (`relation "trip_product"
does not exist`) and the search index load fails (`relation "stop_place_display_name" does not exist`). The train
detail and search numbers above are therefore only their cheap refusal paths: the Valkey lookup of a missing key and
the 503 of a missing index. The p95 of a served detail (Valkey read, ETag, vehicle and forecast lookups) and of a
search over a built index are **not measured**; they need a replay database at the current schema.

### Live traffic per client at 1x

20 followers for 300 s, polling the head every second as `apps/web/src/live` does, `Accept-Encoding: br, gzip`.

| Part | Per client and minute |
| --- | --- |
| Head, 60 polls of about 560 bytes with headers | 33.9 KB |
| Deltas, 11.6 of about 1.5 KB | 17.0 KB |
| Steady total (k6 `data_received` less the join) | 50.9 KB |
| Joining once: the head and a keyframe | 46.7 KB |
| Push notices, if the client used them (about 10 a minute) | about 1 KB (inference from the notice size) |

The budget of 150 KB a minute holds with about a third used, on a Sunday afternoon with 2,125 trains; a weekday peak
has more trains and larger deltas. Two thirds of the steady bytes are head polls: a client that fetched the head only
on a push notice would need about 24 KB a minute (inference). Shape packs are not counted: they load once per shape
when a train first appears.

The engine serves `/live/v1/*` from the process that runs the tick: the head answered in 1.9 ms median but 117 ms at
p95 and 241 ms at most, while the engine used up to 111 % of a core. In production the CDN answers most head requests
(`max-age=1`), so the origin sees about one request a second per edge location, not one per client.

### Live traffic and head latency with push notices

Same setup, 20 followers for 300 s at 1x; the baseline rerun the same afternoon, then the change that brought
push notices (the head on a push notice, `live run`'s HTTP routes on a thread of their own with the head in memory).

| Run | Steady per client and minute | Head reads a minute | Head p50, p95, p99, max |
| --- | --- | --- | --- |
| Before, polling client, old engine | 50.8 KB (head 34.0, deltas 17.1) | 60 | 2.0, 123.7, 186.9, 334.6 ms |
| After, polling client, new engine | 50.6 KB (head 34.0, deltas 16.9) | 60 | 1.3, 3.5, 6.5, 29.6 ms |
| After, push client, new engine | 25.2 KB (head 7.2, deltas 16.9, notices and pings 1.3) | 12.8, of them 1.0 safety reads | 1.8, 5.6, 8.4, 24.7 ms |

Joining stays 46.7 KB. The push run received 1,140 notices (11.4 a minute per client), no request failed. A first
push run gave 25.1 KB and head p95 4.8 ms but lost one follower's socket after a `dial: i/o timeout` to
`host.docker.internal` (Docker Desktop's network), so the clean rerun is the one above. The engine's resident memory
averaged 531 MiB before and 547 to 575 MiB after (the HTTP thread), at most 660 MiB. Frames and motion stayed clean
in every run: `checkChain` (40 clients, no mismatch) and `runContinuity` (10x, 60 fps, 2,031 trips, no jump, stall,
backward step, visible swap or frame off the track) over each run's own output and the heads it served.

Rerun: `LOAD_TRAFFIC_MODE=push tools/load/run.sh traffic` after `up` (or `LOAD_STAGES=traffic` with `all`).

### API with served train details and search

`gerlines_replay` migrated in place from 0050 to 0092 with `packages/db` (16 migrations, 0.9 s), the Land areas loaded
(`gerlines-rollups lands`), the rollups refreshed by hand and their nine policies left paused, and the display names
written (`gerlines-static-import display-names`: 4,012 display names, 4,184 search names). The database grew from
2,542 MB to 2,812 MB, almost all of it the level-1 rollups. Same setup as above, the same afternoon: the engine wrote
2,401 train details to Valkey and the search index loaded at start.

| Route | Answer in this run | p95 at 60 req/s (p99, max) | p95 at 240 req/s (p99, max) |
| --- | --- | --- | --- |
| `GET /api/v1/trains/{id}` | 200 only, a served detail | 6.0 ms (10.4, 21.8) | 2.5 ms (6.7, 24.8) |
| `GET /api/v1/search` | 200 only, over the built index | 4.0 ms (10.1, 21.3) | 1.4 ms (4.4, 16.6) |
| `GET /api/v1/stations/{id}` | 200 only | 3.9 ms (10.3, 21.4) | 1.4 ms (6.2, 11.7) |
| `GET /api/v1/live/keys/{key}` | 200 only | 3.5 ms (8.8, 23.2) | 2.5 ms (6.3, 24.5) |
| `GET /api/v1/status` | 200 only | 4.4 ms (11.9, 26.4) | 1.4 ms (5.0, 22.3) |

3,614 and 14,415 requests, none failed, none rate limited. The second run came straight after the first, with the
process warm, which is why its p95 is lower. The API process peaked at 346 MiB and the engine at 471 MiB. The p95 of
the statistics routes was not measured under load. Single requests to each of them answered 200 in 6 to 54 ms.

### What a server run must still show

- Push at 3,000 clients and above over TLS through Caddy and Cloudflare, with k6 on another machine; Centrifugo used
  148 MiB of its 256 MiB limit here, so its limit caps it at about 5,000 connections (inference, linear from 31 MiB
  idle), and the production overlay keeps 256 MiB.
- The API p95 of a served train detail and of search behind the edge, with the API's own limits in force, and on a
  weekday peak (measured locally on a Sunday replay above).
- Live traffic on a weekday peak, and through the CDN with `Content-Encoding: br` passed through.
- Head latency at the origin while the engine ticks a weekday peak.
