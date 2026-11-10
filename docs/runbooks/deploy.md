# Runbook: production deployment (prepared, not deployed)

Status on 2026-11-08: everything below is prepared and checked on a laptop; nothing is deployed, no server, DNS,
Cloudflare or GitHub setting exists or was touched. Going public (milestone M10) is the maintainer's decision. The stack is
stage 1 of [architecture.md](../architecture.md) section 14: one Hetzner server behind Cloudflare, Caddy as the edge.
The hardening below follows a security review of the whole stack.

## 1. Shape

```
visitor ─ HTTPS ─▶ Cloudflare (DNS proxied, TLS, one rate limiting rule, Cache Rules for immutable objects)
                      │ HTTPS to the origin over IPv4 with our own client certificate (per-hostname Authenticated
                      │ Origin Pulls; only certificates of our own CA pass)
                      ▼
server: nftables drops every new inbound connection but 443 from the Cloudflare ranges and SSH_PORT from SSH_SOURCES
  edge (Caddy, 0.0.0.0:443 on the routed network edge, fixed 172.31.250.10 on the internal network front)
    /api/dev/*        404
    /api/*            api:8787         (front + backend)
    /live/v1/*        live:8790        (front + backend)
    /playback/v1/*    live:8790
    /connection/websocket  centrifugo:8000 (front + backend; client port; API and health on 9000, never routed)
    everything else   the web build (WEB_DIST_DIR), index.html fallback
  front (internal, no route out): edge, api, live, centrifugo
  backend (internal, no route out): db, valkey, router, realtime, and the backend side of api, live, centrifugo
  egress: recorder (fetches the feeds), with backend for the database
```

| Service | Published | Networks | Secrets it needs |
| --- | --- | --- | --- |
| `edge` | `0.0.0.0:443/tcp` only | edge, front | the Origin CA key and our origin pull CA in `EDGE_TLS_DIR` |
| `api` | none | front, backend | `API_DB_PASSWORD`, `VALKEY_PASSWORD` |
| `live` | none | front, backend | `DB_OWNER_PASSWORD`, `VALKEY_PASSWORD`, `CENTRIFUGO_HTTP_API_KEY` |
| `centrifugo` | none | front, backend | `CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY`, `CENTRIFUGO_HTTP_API_KEY` |
| `db` | none | backend | `DB_OWNER_PASSWORD` |
| `valkey` | none | backend | `VALKEY_PASSWORD` |
| `router` (MOTIS and its web UI) | none | backend | none |
| `recorder` | none | backend, egress | `DB_OWNER_PASSWORD`, the optional provider keys |
| `realtime` | none | backend | `DB_OWNER_PASSWORD` |

Files: [infra/compose.production.yaml](../../infra/compose.production.yaml) (the overlay over `infra/compose.yaml`),
[infra/production/](../../infra/production/) (`Caddyfile`, `centrifugo.json`, `api.Dockerfile`, `cloudflare-ips.txt`,
`cloudflare-ranges.sh`, `firewall.sh`, `gerlines-firewall.service`, `production.env.example`), [scripts/check-deploy.sh](../../scripts/check-deploy.sh).

## 2. What is hardened, and how it is checked

| Item | How | Checked by |
| --- | --- | --- |
| Every secret required, none defaulted | each variable of the overlay is `${VAR:?}`; only `PREDICTION_TABLE` may be empty; the base file's `change-me-locally` defaults are overridden | check-deploy: unset and empty render fails for each of the 21 variables, no `:-` in the overlay, no `change-me` in the rendered config |
| Only the edge listens publicly | `ports: !reset []` on db, valkey, centrifugo, live, router; edge publishes 443/tcp on IPv4 | check-deploy: published ports |
| Database never published | as above, backend network only | check-deploy |
| Valkey password | `requirepass` read from stdin (not argv), protected mode on, health check with `REDISCLI_AUTH`, URLs of api and live carry the password | check-deploy; a throwaway container on 2026-11-08: `NOAUTH` without the password, `PONG` with it, the server runs as `valkey`, the password is not in any process's argv |
| Centrifugo | `infra/production/centrifugo.json`: admin off, no insecure mode, anonymous connect and anonymous subscribe for the `live` namespace only (the head notices), `train` closed to anonymous clients, publish, presence, join and leave, history and recovery false in every namespace, at most 4 channels per connection and 4,000 connections (memory limit 512 MiB in the overlay: the laptop load test measured 148 MiB at 3,000 clients, WP-9.4), prometheus, swagger, debug off; HTTP API and health on internal port 9000, the client port 8000 only behind `/connection/websocket`; allowed origin `https://PUBLIC_HOST` | check-deploy (config and `centrifugo checkconfig`); a throwaway container: 9000 `/health` 200, 8000 has no health, API, admin, metrics or swagger (404); a throwaway container on 2026-11-08: an anonymous client connects and subscribes to `live:frames`, gets 103 for `train:<id>`, a channel without namespace and a publish, 108 for presence and history |
| MOTIS and its web UI never public | router has no published port, backend network only, not routed by the edge | check-deploy |
| Client address | Caddy trusts only the Cloudflare ranges (`trusted_proxies static`, strict, `CF-Connecting-IP`), strips `CF-Connecting-IP`, `X-Forwarded-For`, `X-Real-IP`, `Forwarded`, `True-Client-IP` from any other peer; `API_TRUSTED_PROXIES` is the edge's fixed address and `API_CLOUDFLARE_RANGES` the same ranges | check-deploy (both lists equal `cloudflare-ips.txt`, the edge probe in the pinned Caddy image); `apps/api/src/search/client-address.test.ts` (production edge block) |
| Origin reachable only through our Cloudflare zone | per-hostname Authenticated Origin Pulls with our own client certificate: `client_auth require_and_verify` with `trust_pool file origin-pull-own-ca.pem` (our own CA, never Cloudflare's shared zone-level certificate, which every Cloudflare customer presents); the nftables firewall drops every new connection on the public interface but 443 from Cloudflare and SSH | `caddy validate`; check-deploy (the Caddyfile trusts only `origin-pull-own-ca.pem`; with `--env-file` on the server that file must be a CA certificate that is not Cloudflare's, valid 30 days more; the firewall rules); the ruleset passed `nft -c` and loaded in a container network namespace (nftables 1.1.6) on 2026-11-08, where `apply` without `confirm` rolled back after the timeout and restored the previous rules |
| Per-IP rate limit at the edge | one Cloudflare rate limiting rule over `/api/`, `/live/v1/head`, the mutable `/playback/v1/` paths and `/connection/websocket`, Cache Rules for the immutable objects (section 5); the API's own limits inside | written here, set by the user |
| Networks | only the edge joins the routed `edge` network; api, live, centrifugo talk to it on the internal `front` network and to the stores on the internal `backend` network, so none of them has a route out | check-deploy |
| API database role | the API reads search, statistics, data status and vehicle identity with its own role (`API_DB_USER`, read-only SQL in step 7), never the owner | check-deploy refuses `API_DB_USER` equal to `POSTGRES_USER`, and checks that the four URLs are the same |
| Dev routes and hooks off | section 6 | tests named there |
| Hardened containers | api, edge, live, recorder, realtime, router read-only, `cap_drop: ALL`, `no-new-privileges`; db, valkey, centrifugo `cap_drop: ALL` and `no-new-privileges` (valkey keeps `CHOWN`, `SETUID`, `SETGID` so its entrypoint can own `/data` and step down to the `valkey` user; their images write to their data folders, so they are not read-only); images pinned by digest | check-deploy; throwaway containers on 2026-11-08: db and centrifugo start with no capability, valkey fails with `chown: Operation not permitted` without `CHOWN` and answers `PONG` with the three |
| The API refuses an unsafe start | with `NODE_ENV=production` it needs `APP_NAME`, `APP_CONTACT`, `API_TRUSTED_PROXIES`, `API_CLOUDFLARE_RANGES`, and refuses an entry of either list with a prefix shorter than /8 (IPv4) or /16 (IPv6) | `apps/api/src/config.test.ts` (`checkProductionSettings`) |
| Web headers | HSTS (one year, no preload), nosniff, `X-Frame-Options DENY`, `no-referrer`, COOP, Permissions-Policy; a Content-Security-Policy in Report-Only | `caddy validate`; the CSP is not enforced yet (section 4, step 10) |
| No addresses in logs | Caddy has no access log; the API logs no address | check-deploy (no `log` in the Caddyfile) |
| Web files precompressed | `vite build` writes `.br` (brotli 11), `.zst` (zstd 19) and `.gz` beside every js, css, html, svg, json, geojson and wasm file (`apps/web/vite/precompress-plugin.ts`). The edge serves them with `file_server { precompressed br zstd gzip }` in two handles: `/assets/*` (immutable, no index fallback, so a chunk that is gone is a 404 that is not cached as a year-long HTML page) and the rest (`no-cache`, index fallback); `encode zstd gzip` stays for what has no copy (source maps). Caddy serves a copy because the file exists, so `WEB_DIST_DIR` must be replaced as a whole (step 5), never copied over the old folder. It saves about 0.2 s of the first paint on Slow 4G against Caddy's own zstd (architecture section 11) | check-deploy: the two handles in the Caddyfile, and an edge probe in the pinned Caddy image (br, zstd and gzip chosen by `Accept-Encoding` including Chrome's `gzip, deflate, br, zstd`, the plain file without one, JavaScript `Content-Type`, `Vary: Accept-Encoding`, a distinct `ETag` per encoding, immutable on `/assets/*`, `no-cache` HTML for the page, a missing asset a 404, a file with no copy compressed on the fly); `bash scripts/check-deploy.sh --dist <WEB_DIST_DIR>` decodes every copy and compares it to its file; `apps/web/vite/precompress-plugin.test.ts`. Cloudflare passing the origin's brotli through is not testable here: after the first deploy request `/assets/*` with `accept-encoding: br`, `gzip` and `zstd` and record the `content-encoding` that comes back (Cloudflare may ask the origin for gzip and br only, then the `.zst` copies are never served behind it) |

## 3. The check

```
bash scripts/check-deploy.sh                                   # dummy values, every check (about 6 s)
bash scripts/check-deploy.sh --offline                         # without the container checks
bash scripts/check-deploy.sh --pull                            # pull a missing pinned image first
bash scripts/check-deploy.sh --env-file /etc/gerlines/production.env   # the real file: names only, never values
```

It renders the overlay with `docker compose config` (every profile, a clean environment, never `up`) and fails on any
published port other than the edge's 443, any default or placeholder secret, any dev flag, any retired variable
(`API_DEV_ROUTES`, `TRANSITOUS_*`), any unpinned image, a
network a backend service should not join, a trusted proxy or Cloudflare list that differs from
`cloudflare-ips.txt`, an unsafe Centrifugo or Caddy setting. With dummy values it also renders once per required
variable with that variable unset and empty, runs `caddy validate` with a throwaway self-signed certificate, probes
the header stripping in the pinned Caddy image without network (`--network none`), runs `centrifugo checkconfig`, and
renders the firewall and checks its systemd unit. With `--env-file` it checks the real file instead: secrets at least
32 URL-safe characters and all different, the API role apart from the owner, and, where `EDGE_TLS_DIR` is readable,
the origin pull CA. Images: Caddy `caddy:2.11.9-alpine` (index digest `sha256:0bbb055b…`, 23.5 MB compressed on arm64),
Centrifugo as pinned in `infra/compose.yaml`; neither is pulled unless `--pull` is given.

Last run, 2026-11-08 on the M1 Pro: 39 PASS, 0 FAIL. Mutation runs (each reverted): a published Valkey port, a
defaulted `VALKEY_PASSWORD`, the `X-Forwarded-For` strip removed, Centrifugo admin on, `API_DEV_ROUTES=1`, a trusted
proxy widened to the /24, the Centrifugo and live environments merged with the base file (admin credentials and
`LIVE_LOCAL_STACK` back), `API_DB_USER` equal to `POSTGRES_USER`, an origin pull CA that names Cloudflare, a leaf
certificate in place of the CA: each one failed.

## 4. Steps

Every step on the server runs as the deploy user from the repository checkout (`/srv/gerlines`), with
`C="docker compose -f infra/compose.yaml -f infra/compose.production.yaml --env-file /etc/gerlines/production.env"`.

1. **Server.** Hetzner Cloud, Ubuntu 24.04, Docker Engine with the Compose plugin 2.24 or newer (`!reset` and
   `!override`), a deploy user in the `docker` group, SSH by key only (`PasswordAuthentication no`). Size: CX43 (16 GB)
   holds the stack if MOTIS runs in the reduced configuration of SP-1 (architecture section 14).
2. **Firewall.** With `F="SSH_SOURCES=<your addresses> SSH_PORT=<port, default 22> PUBLIC_IFACE=eth0"`:
   `env $F bash infra/production/firewall.sh print` and read it, then `sudo env $F bash infra/production/firewall.sh
   apply`. Apply puts the previous rules back after 60 s (`ROLLBACK_SECONDS`) unless
   `sudo bash infra/production/firewall.sh confirm` runs first: run it from a new SSH session, which proves the new
   rules still let you in. Keep a Hetzner console open while doing it (the console is not filtered). For boot:
   `sudo install -d -m 755 /etc/gerlines`, `sudo env $F bash infra/production/firewall.sh print | sudo tee
   /etc/gerlines/firewall.nft >/dev/null`, `sudo install -m 644 infra/production/gerlines-firewall.service
   /etc/systemd/system/`, `sudo systemctl daemon-reload`, `sudo systemctl enable --now gerlines-firewall`. Leave the
   stock `nftables.service` and `/etc/nftables.conf` alone: its `flush ruleset` would also drop Docker's rules on
   every reload. The rules sit in prerouting before Docker's DNAT, because a published container port never reaches
   the input hook, and drop every new connection on the public interface but 443 from Cloudflare, SSH, ICMP and DHCP
   replies, so a port published later by mistake stays closed. A Hetzner Cloud Firewall with the same rules is a
   second layer outside the host.
3. **Cloudflare.** Zone for the domain; one proxied `A` record to the server's IPv4 address and no `AAAA`, so Cloudflare
   reaches the origin over IPv4 and Docker's DNAT keeps its address. SSL mode Full (strict). An Origin CA certificate
   for the host name into `EDGE_TLS_DIR/origin.pem` and `origin.key` (mode 600).
   **Per-hostname Authenticated Origin Pulls with our own certificate**, never the zone-level or global ones: their
   certificate is shared by every Cloudflare customer, so any Cloudflare zone pointed at the origin would pass the
   client check and skip our rate limit and WAF (Cloudflare docs, Authenticated Origin Pulls, Per-hostname, updated
   2026-04-16: per-hostname pulls take your own leaf certificate and precede the zone-level ones). On a trusted
   machine, not the server:

   ```
   openssl genrsa -aes256 -out aop-ca.key 4096
   openssl req -x509 -new -key aop-ca.key -sha256 -days 1826 -subj "/O=GerLines/CN=GerLines AOP CA" -out aop-ca.pem
   openssl req -new -nodes -newkey rsa:2048 -keyout aop-client.key -subj "/O=GerLines/CN=<host>" -out aop-client.csr
   printf 'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=clientAuth\n' >aop-client.ext
   openssl x509 -req -in aop-client.csr -CA aop-ca.pem -CAkey aop-ca.key -CAcreateserial -days 730 -sha256 \
     -extfile aop-client.ext -out aop-client.pem
   ```

   Upload `aop-client.pem` and `aop-client.key` in the dashboard (SSL/TLS, Origin Server, Authenticated Origin Pulls,
   Per-hostname, Upload certificate) or with the API (`POST /zones/<zone>/origin_tls_client_auth/hostnames/certificates`,
   then `PUT /zones/<zone>/origin_tls_client_auth/hostnames` with the host name, the certificate id and `enabled`), and
   associate the host name. Copy only `aop-ca.pem` to the server as `EDGE_TLS_DIR/origin-pull-own-ca.pem`; keep
   `aop-ca.key` offline and delete `aop-client.key` after the upload. Renew the client certificate before it ends
   (730 days) by uploading a new one signed by the same CA. Then the rate limiting rule and the Cache Rules of
   section 5.
4. **Env file.** `sudo install -m 600 -o <deploy user> infra/production/production.env.example
   /etc/gerlines/production.env`; fill every value (`openssl rand -hex 32` per secret), then
   `bash infra/production/cloudflare-ranges.sh env` and put its two lines in place of the empty ones. Then
   `bash scripts/check-deploy.sh --env-file /etc/gerlines/production.env` until it passes.
5. **Folders.** `WEB_DIST_DIR` (the web build: build into a new folder next to it, copy the previous build's `assets/` into the new one so tabs that are still open find their chunks (keep the last two or three builds' assets, delete older ones), run `bash scripts/check-deploy.sh --dist <new folder>`, then swap the folders with one `mv`; never copy over the folder in place, an old `.br`, `.zst` or `.gz` left beside a new file would be served instead of it), `EDGE_TLS_DIR`, `API_DATA_DIR` with `search/places-de.tsv`,
   `photos/` and optionally the forecast table, `LIVE_DIR` owned by `LIVE_UID` (1000), `RECORDINGS_DIR`,
   `RECORDER_SEED_DIR`, `REALTIME_STATE_DIR`, `ROUTER_RUN_DIR` (MOTIS `data/` and `container.yml`).
6. **Images.** `$C --profile live --profile recorder --profile router --profile realtime build api live recorder realtime router`,
   then scan each: `trivy image --severity HIGH,CRITICAL --exit-code 1 gerlines-api:0.0.0` (and the others). The API
   image (`infra/production/api.Dockerfile`) was written next to `services/live/Dockerfile` but not built on
   2026-11-08 (no builds that session).
7. **Database.** `$C up -d --wait db valkey`; `$C --profile recorder up -d recorder` applies the migrations at start
   (`RECORDER_MIGRATIONS_DIR`). Then the API's read-only role, in `$C exec db psql -U gerlines -d gerlines`:

   ```sql
   CREATE ROLE gerlines_api LOGIN PASSWORD :'api_password';
   GRANT CONNECT ON DATABASE gerlines TO gerlines_api;
   GRANT USAGE ON SCHEMA public TO gerlines_api;
   GRANT SELECT ON ALL TABLES IN SCHEMA public TO gerlines_api;
   ALTER DEFAULT PRIVILEGES FOR ROLE gerlines IN SCHEMA public GRANT SELECT ON TABLES TO gerlines_api;
   ```

   (`\set api_password '<API_DB_PASSWORD>'` first, typed, so it stays out of the shell history.) Not run anywhere
   yet: check each API route against this role on a copy before relying on it, including the schemas other than
   `public` that the catalogue or the rollups use.
8. **Start.** `$C --profile router up -d --wait router`; build the packs (`infra/README.md`, Live engine), then
   `$C --profile live up -d centrifugo live`; `$C up -d --wait api edge`.
9. **Verify.** `curl -sI https://<host>/api/health` answers 200 through Cloudflare. `curl -sk --max-time 5
   --resolve <host>:443:<server ip> https://<host>/api/health` from elsewhere times out (firewall), and with the
   firewall off it fails the TLS handshake (no client certificate); so does a client certificate of another CA
   (`curl --cert other.pem --key other.key …`). `$C ps` lists ports for `edge` only; `ss -tlnp` on the host shows the
   SSH port and 443 and nothing else on a public address. About 150 requests to `/api/v1/search?q=ber` in 10 s get
   Cloudflare's 429 or block page; a second `curl -sI https://<host>/live/v1/s/<epoch>/<number>.bin` shows
   `cf-cache-status: HIT`. `bash scripts/check-deploy.sh --env-file /etc/gerlines/production.env` as a user who can read
   `EDGE_TLS_DIR` passes the origin pull CA check.
10. **CSP.** Open the site, read the console for Content-Security-Policy-Report-Only violations, adjust the policy in
    the Caddyfile, then rename the header to `Content-Security-Policy` and run check-deploy again.

Ranges change: `bash infra/production/cloudflare-ranges.sh refresh` rewrites `cloudflare-ips.txt` when Cloudflare's
lists changed; then the env file's two lines, `firewall.sh apply`, `$C up -d edge api` and check-deploy.

## 5. Per-IP rate limit at the edge

Plan limits (Cloudflare docs read 2026-11-08: WAF, Rate limiting rules, Availability; Cache, Cache Rules,
Availability; Rules language, Functions): the Free plan has **one** rate limiting rule, with the Path field only,
counting by IP, a 10 s period, a 10 s mitigation timeout and no cache exclusion (requests answered from the cache
count too); **10 Cache Rules**; `starts_with()` carries no plan restriction. One rule can OR several path conditions,
so it covers every route the origin computes; what never changes is served from the cache instead.

- **Chosen: one Cloudflare rate limiting rule** (Security rules, Rate limiting), characteristics IP, 100 requests per
  10 s, action Block for 10 s, expression:

  ```
  starts_with(http.request.uri.path, "/api/")
  or http.request.uri.path eq "/live/v1/head"
  or http.request.uri.path eq "/connection/websocket"
  or (starts_with(http.request.uri.path, "/playback/v1/")
      and not http.request.uri.path contains "/k/"
      and not http.request.uri.path contains "/d/")
  ```

  With anonymous push connections this rule is also the rate rule for `/connection/websocket`: each
  connect is one request, so an address opens at most 100 sockets per 10 s, and the web client reconnects after 1 s
  doubling to 60 s.

  That is 600 a minute per address for the API, the live head (a client polls it every few seconds), the playback
  index and window heads and each websocket connection, above the API's largest per-client limit (300 photo files a
  minute) and well under what fills the API's limiter tables (apps/api README, Clients and limits). The immutable
  frames and packs stay out of the rule on purpose: a page load fetches one shape pack per shape of the running trips
  (epoch 4 of `data/live/packs-t116` holds 92,482 pack files), which would trip a shared limit of 100 per 10 s, and on
  Free cached answers count. Cloudflare counts per data centre and may let a few requests through before it blocks;
  the API's limits stay the inner guard; `services/live` has no limiter of its own.
- **Cache Rules for the immutable objects** (Caching, Cache Rules; 3 of the 10): `starts_with(http.request.uri.path,
  "/live/v1/k/") or starts_with(http.request.uri.path, "/live/v1/d/") or starts_with(http.request.uri.path,
  "/live/v1/s/")`, and `starts_with(http.request.uri.path, "/playback/v1/w/") and (http.request.uri.path contains "/k/"
  or http.request.uri.path contains "/d/")`: Eligible for cache, Edge TTL and Browser TTL from the origin (the live
  server sends `public, max-age=31536000, immutable`), and `/assets/*` of the web build likewise. The origin then sees
  each object once per data centre. Residual: requests for objects that do not exist miss the cache and are not
  limited at the edge on Free; `live` answers them with a cheap 404 from fixed file patterns. Pro allows a second rule
  for those paths with a higher threshold.
- **Option: Caddy with `rate_limit`** from [mholt/caddy-ratelimit](https://github.com/mholt/caddy-ratelimit),
  Apache-2.0, commit `5625512f24f6f59d6f64fb3aafe5eecff0b286db` (2026-06-12; the only tag, v0.1.0, predates the
  `ipv6_prefix` option). It needs a custom build, which then replaces the pinned `caddy` image of the edge:

  ```Dockerfile
  FROM caddy:2.11.9-builder-alpine@sha256:d26fbc8a56ed8c3c1534f5573162d148ad3ed41732665da8526eb181fac0b728 AS build
  RUN xcaddy build v2.11.9 --with github.com/mholt/caddy-ratelimit@5625512f24f6f59d6f64fb3aafe5eecff0b286db
  FROM caddy:2.11.9-alpine@sha256:0bbb055bda6793c999bde78b1b5ce3e89f829fb031af2cf50056ea1246559fee
  COPY --from=build /usr/bin/caddy /usr/bin/caddy
  ```

  and in the Caddyfile (global `order rate_limit before basic_auth`, then in the site):

  ```
  rate_limit {
  	zone api {
  		match {
  			path /api/* /live/v1/head /connection/websocket /playback/v1/windows /playback/v1/w/*/head
  		}
  		key {client_ip}
  		ipv6_prefix 64
  		window 10s
  		events 100
  	}
  	zone objects {
  		match {
  			path /live/v1/k/* /live/v1/d/* /live/v1/s/* /playback/v1/w/*
  		}
  		key {client_ip}
  		ipv6_prefix 64
  		window 10s
  		events 5000
  	}
  }
  ```

  The second zone limits what the Free plan leaves open (requests for missing objects) at a level a page load of
  thousands of packs stays under. Each zone counts only the requests its matcher selects (the playback window heads
  fall in both).

  `{client_ip}` is the visitor Cloudflare names, since Caddy trusts only the Cloudflare ranges. Both images are pinned
  by their index digests of 2026-11-08. Not built or validated here.

## 6. Dev-only routes and hooks

| Where | What | Off in production by | Test |
| --- | --- | --- | --- |
| apps/api | no development routes (the Transitous proxy and `API_DEV_ROUTES` are gone) | the edge still answers `/api/dev/*` with 404 | `app.test.ts` "development routes"; check-deploy edge probe |
| apps/api | start without the edge settings | `checkProductionSettings` | `config.test.ts` `checkProductionSettings` |
| apps/web Vite plugin | the in-process API under `/api/` | `apply: "serve"`: dev server only, not in `vite build` | none of its own (Vite semantics) |
| apps/web | `window.gerlinesStore`, `window.gerlinesCheck` | `import.meta.env.DEV`, removed from production builds | not tested on a production bundle (no builds that session) |
| apps/web | `?probe`: `window.gerlines` (select, focus Land, map style, terrain), map diagnostics, a same-origin live base override | on in production on purpose (the frame probe); affects only the visitor's own tab; absolute live bases stay development only (`apps/web/src/live/source.ts`) | `apps/web` live source tests; whether to keep it public is the user's call |
| services/live | `LIVE_LOCAL_STACK=1` (accepts the placeholder Centrifugo key) | not set by the overlay | check-deploy dev flags |
| Centrifugo | admin UI, insecure modes, anonymous connect | `infra/production/centrifugo.json` | check-deploy, `centrifugo checkconfig` |
| apps/api | bahn.de coach sequence (`VEHICLE_SEQUENCE_ENABLED`) | `"0"` in the overlay until the endpoint's terms are checked (D-060) | check-deploy dev flags |

## 7. Left to the operator

- The go-ahead for M10, the server, the domain, the Cloudflare account and every cost.
- Steps 1 to 10 above: the server, the firewall (written, never run on a host), Cloudflare (zone, A record, Full
  strict, Origin CA certificate, Authenticated Origin Pulls, the rate limiting rule), the env file and its secrets.
- Our own origin pull CA and client certificate (step 3), made and uploaded by the operator; the CA key stays offline.
- The read-only database role (step 7, SQL not run) and least-privilege roles for live, recorder and realtime: they
  use the owner role. live writes to the database it reads, so its role needs the
  writes of its own tables; that split comes with the roles work.
- Building and scanning the images (step 6); the API image is unbuilt.
- The Content-Security-Policy switch from Report-Only (step 10). The header carries no `report-to` or `report-uri`,
  so violations show only in the browser console of whoever checks; a report endpoint (a collector, or
  Cloudflare's own CSP reporting on a paid plan) is the operator's choice. CORS: none is sent, which suits one origin
  for web and API.
- Databases of the API: search, statistics, data status and vehicle identity all read `POSTGRES_DB` with the API
  role (`SEARCH_`, `STATS_`, `STATUS_`, `VEHICLE_DATABASE_URL` set alike). `TIMETABLE_DATABASE_URL` stays unset: only
  the offline vehicle sample report (`apps/api/src/vehicle/sample-report.ts`) reads it, not the server.
- api, live and centrifugo have no route out (front and backend are internal). Turning on the bahn.de coach sequence
  (`VEHICLE_SEQUENCE_ENABLED=1`) later needs the api on the `egress` network too.
- Log rotation for every container (`/etc/docker/daemon.json` `log-opts` `max-size`, `max-file`; only `realtime` sets
  it in the base file), backups of the database to R2, monitoring (architecture sections 12 and 14), secrets in SOPS
  files (architecture section 12).
- Memory limits sized for a 16 GB development machine (`infra/README.md`, Resource limits): revisit for the server.
- The web has no Centrifugo client and no token endpoint yet: with token-only connect every websocket is refused until
  one exists, and clients poll `head` (architecture, Transport).
