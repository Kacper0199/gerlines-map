# Development

How to set up, check and extend the GerLines monorepo. Architecture lives in [architecture.md](architecture.md),
milestones in [PLAN.md](PLAN.md), keys in [KEYS.md](KEYS.md).

## Layout

| Path | Contents | Guide |
| --- | --- | --- |
| `apps/web` | web client: React, MapLibre GL JS, deck.gl, the live worker, the train and station cards, the 3D car layer, the statistics panel, the journey planner, the legal and credits pages | `apps/web/README.md` |
| `apps/api` | HTTP API (Hono): journeys and their punctuality, router health, search and stations, statistics, train detail with vehicle identity and forecast, live keys, vehicle photos | `apps/api/README.md` |
| `services/ingest` | recorder (every source, stored byte for byte), realtime processor (`src/realtime`), DB API adapters | `services/ingest/README.md` |
| `services/live` | live engine: motion plans, keyframes and deltas, shape packs, the frame server, the train detail writer | this file, section Live engine |
| `services/router` | MOTIS 2 configuration, import and measurement scripts | `services/router/README.md` |
| `packages/config` | shared TypeScript and Biome profiles, tests of the secret rules | |
| `packages/schema` | shared contracts (zod), among them `TrainDetail` | |
| `packages/db` | SQL migrations, the migration runner, Kysely types | `packages/db/README.md` |
| `packages/geo` | linear referencing and the motion kernel shared by server and browser | |
| `packages/live-frame` | binary live frame codec | `packages/live-frame/README.md`, `FORMAT.md` |
| `packages/i18n` | messages in English, German and Polish (Paraglide), the copy lint | `packages/i18n/README.md` |
| `packages/ui` | design system components and theme tokens | `DESIGN.md` |
| `pipelines/common` | shared Python code | |
| `pipelines/static_import` | DELFI timetable import for trains (`gerlines-static-import`) | `pipelines/static_import/README.md` |
| `pipelines/rail_graph` | rail graph from OpenStreetMap and track shapes per trip pattern (`gerlines-rail-graph`, own dependency group) | `pipelines/rail_graph/README.md` |
| `pipelines/geo_base` | Germany mask, Länder, neighbours (`geo-base`) | `pipelines/geo_base/README.md` |
| `pipelines/catalog` | loads `catalog/` into the database, generates fleet rules, finds and stores vehicle photos (`gerlines-catalog`) | `pipelines/catalog/README.md` |
| `pipelines/rollups` | statistics rollups: Land areas, refresh, policy control, recomputation check (`gerlines-rollups`) | `pipelines/rollups/README.md` |
| `pipelines/backfill` | history backfill from piebro (`gerlines-backfill`) | `pipelines/backfill/README.md`, [history.md](history.md) |
| `pipelines/predict` | B1 delay forecast table, backtest and live shadow check (`gerlines-predict`) | `pipelines/predict/README.md`, [predictions.md](predictions.md) |
| `catalog/` | categories, operators, transport associations, vehicle series, vehicle geometry, liveries, line colours, sources | `catalog/README.md` |
| `spikes/*` | time-boxed experiments kept for their measurements (`sp-2-coverage`, `sp-4-render`, `sp-5-i18n`) | README in each |
| `infra/` | local Compose stack: db, valkey, centrifugo, live, recorder, realtime, router | `infra/README.md` |
| `scripts/` | repository checks (copy lint, data licence guard, secret scan helpers, key check), screenshot capture | this file |
| `tools/trainforge` | procedural glTF train models from `catalog/vehicles.yaml` and `catalog/liveries.yaml`, a preview page, photo fitting scripts | `tools/trainforge/README.md` |
| `tools/photo-review` | local page to approve or reject vehicle photo candidates | `tools/photo-review/README.md` |

Every TypeScript package is private, ESM only (`"type": "module"`), licensed `AGPL-3.0-or-later`, exports its
`src/index.ts` directly (no build step for internal packages) and has the scripts `lint`, `typecheck` and `test`.

## Prerequisites

| Tool | Version | Install |
| --- | --- | --- |
| Node | 24 LTS (`.nvmrc`) | `nvm install && nvm use`; make it the default with `nvm alias default 24` |
| pnpm | 11.28.8 (`packageManager` in `package.json`) | `npm install --global pnpm@11.28.8` or `corepack enable` |
| uv | 0.13.5 or newer (`required-version` in `pyproject.toml`) | <https://docs.astral.sh/uv/getting-started/installation/>, then `uv self update` |
| Python | 3.13 (`.python-version`) | `uv python install 3.13` (uv picks it up automatically) |
| Docker | Desktop or Engine | needed for the database, Valkey, Centrifugo, the recorder, the realtime processor, the live engine and the router; not for the web client alone |

pnpm 12 is not used yet (decision D-012). uv older
than 0.13.4 trusts the compromised emSign root certificate (advisory GHSA-hq85-5cpj-mr62), hence the floor.
`nvm alias default node` would follow every new major release (Node 26 included), which `engines` rejects.

## First-time setup

```bash
nvm use
pnpm install            # installs JS dependencies; never installs git hooks
uv sync                 # creates .venv with ruff, pytest and the pipeline packages
pnpm hooks:install      # installs the lefthook pre-commit hook into .git/hooks (once per clone)
cp .env.example .env    # then fill it in, see docs/KEYS.md
```

`pnpm install` never writes git hooks: the lefthook postinstall script is denied in `pnpm-workspace.yaml`
(`allowBuilds`) and `lefthook.yml` sets `no_auto_install`. After changing `lefthook.yml`, run
`pnpm hooks:install` again.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm check` | `turbo run lint typecheck test` over every package |
| `pnpm turbo run lint typecheck test` | the same, as CI runs it; a second run with no changes is a full cache hit |
| `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` | one turbo task over every package |
| `pnpm turbo run test --filter=@gerlines/schema` | one task for one package |
| `pnpm infra:up`, `pnpm infra:down`, `pnpm infra:ps`, `pnpm infra:psql` | local Compose stack (db and valkey; `pnpm infra:up:live` adds Centrifugo; `pnpm live:packs` then `pnpm live:up` start the `live` service on `127.0.0.1:8790`), see `infra/README.md` |
| `pnpm db:migrate`, `pnpm db:status`, `pnpm db:reset`, `pnpm db:types` | migrations and Kysely types, see `packages/db/README.md` |
| `GERLINES_DB_TESTS=required pnpm db:test` | database integration tests; without the variable they skip only when no server answers |
| `pnpm --filter @gerlines/web dev` | the map on 127.0.0.1; it draws our live engine's trains from `/live/v1` (set `LIVE_PROXY_TARGET` to a `live run` or `live replay` server). Without one the map draws no trains and the live bar says No live server is running; nothing else needs setting up for the map itself |
| `pnpm --filter @gerlines/api dev` | the HTTP API on `127.0.0.1:8787`, or `API_PORT` (empty means the default) (`apps/api/README.md`) |
| `pnpm lint:copy` | the copy lint over every message (section Copy lint) |
| `pnpm format` | Biome: format and apply safe fixes to TS, JS, JSON and CSS |
| `pnpm lint:root` | Biome on root config files (also runs before every package `lint`) |
| `pnpm deploy:check` | `bash scripts/check-deploy.sh`: renders the production overlay with dummy values and fails on a published port other than the edge, a default secret or a dev flag; needs Docker, starts no service ([docs/runbooks/deploy.md](runbooks/deploy.md)) |
| `pnpm --filter @gerlines/web operator-groups` | regenerates `apps/web/src/modes/operator-groups.generated.ts` from `catalog/operators.yaml` after a catalogue change (a web test fails while it is stale) |
| `bash scripts/check-keys.sh` | checks every API key in `.env` against its provider, prints PASS, WARN, FAIL or SKIP, never the values (docs/KEYS.md) |
| `pnpm secrets:scan` | secretlint over the working tree |
| `pnpm secrets:staged` | secretlint over the staged content (what the pre-commit hook runs) |
| `pnpm exec lefthook run pre-commit` | run the pre-commit hook without committing |
| `pnpm turbo run test --filter=@gerlines/config` | secretlint fixture tests for this project's key formats |
| `node scripts/check-gitleaks-rules.mjs <path to gitleaks>` | the same fixtures against `.gitleaks.toml` |
| `gitleaks git --config .gitleaks.toml --redact --log-opts=--all .` | gitleaks over the full history, as CI runs it |
| `uv sync --frozen` | install Python dependencies exactly as locked |
| `uv run ruff check .` and `uv run ruff format --check .` | Python lint and format check |
| `uv run ruff format .` | format Python |
| `uv run pytest -m "not db" --ignore=pipelines/rail_graph` | Python tests without a database, as CI runs them |
| `uv run pytest -m db --ignore=pipelines/rail_graph` | Python database tests (throwaway databases on the local `db`) |
| `uv sync --group rail-graph` then `uv run --group rail-graph pytest pipelines/rail_graph` | rail graph tests (need osmium and scipy); plain `uv run pytest` fails on them without the group |
| `uv run --frozen reuse lint` | REUSE licence compliance (reuse and its dependencies locked in `uv.lock`) |
| `node scripts/check-data-licences.mjs <reuse spdx output>` | no data file only under the AGPL catch-all (Licensing) |
| `actionlint` | workflow lint; install the pinned binary from the actionlint release page |

The pre-commit hook runs Biome on staged TS, JS, JSON and CSS files, ruff on staged Python files and secretlint on
the staged content (an export of the index, so a secret that is staged but removed from the working tree is still
caught). It works offline. Biome and ruff read the working-tree copy of each staged file, so with partial staging
they may check slightly different content than the commit; the secret scan always checks the index.

Without an installed hook, run `pnpm secrets:staged` before every commit.

## Copy lint

Every interface message lives in `packages/i18n/messages/{en,de,pl}.json`. `pnpm lint:copy` (also part of the
`@gerlines/i18n` `lint` task, so of every `turbo run lint` and of CI) fails on:

- double dashes, slashes, quotation marks, semicolons, middle dots, em and en dashes in any message, after NFKC
  normalisation so lookalike characters count too (URLs and `{placeholders}` are ignored);
- a key missing in a locale or extra to it, and placeholders or plural forms that lose a placeholder of English;
- a key that no component reads.

A message that really needs one of these characters goes into `packages/i18n/copy-lint.allow.json` with a reason;
a stale or invalid entry fails as well. Details and the rule for adding a message or a language:
`packages/i18n/README.md`.

## Database and migrations

The local database is TimescaleDB with PostGIS in Docker on `127.0.0.1:5433` (`pnpm infra:up`); the PostgreSQL that
may be installed on the host (port 5432) is not used. Migrations are plain SQL pairs in `packages/db/migrations/`
(`NNNN_name.up.sql`, `NNNN_name.down.sql`); `main` holds 30 migrations from 0001 to 0092, numbered with gaps (`packages/db/README.md`, Tables, names the migration of each table).

```bash
pnpm infra:up                               # db and valkey, waits until healthy
pnpm db:migrate                             # apply pending migrations
pnpm db:status                              # applied and pending; fails when an applied file changed
GERLINES_DB_TESTS=required pnpm db:test     # integration tests on a throwaway database
```

Before it runs, rolls back or reports status, the runner checks the recorded history against the files
(`verifyHistory` in `packages/db/src/migrations.ts`). It refuses when:

- an applied migration has no file any more, or its file was renamed;
- the checksum of an applied up or down file changed (never edit an applied migration; add a new one);
- a pending migration is numbered below the highest applied one.

The last rule decides how to number a new migration: take a number above the highest applied in every database the
change will meet, and below the numbers already used on unmerged branches, so the branches can merge in any order
without renumbering. A migration that waits on a branch while a higher number is applied elsewhere must be
renumbered before it can run there. Rules for statements that cannot run in a transaction and for correcting a down
file are in `packages/db/README.md`.

## Recorder

The recorder fetches every realtime and static source on its own schedule and stores each payload byte for byte in
compressed segment files under `data/recordings/` (git-ignored), with an index in the database and gap tracking.
It runs as the Compose service `recorder`:

```bash
pnpm infra:up
pnpm recorder:up        # builds the image and starts recording; it applies pending migrations at start
pnpm recorder:status    # per source: last success, last error, objects and bytes today, gaps
pnpm recorder:logs
```

Sources, cadences, the storage format, retention, golden days, backfill from the DELFI mirror's archive and the
disk guard are described in `services/ingest/README.md`. Sources that need a key (Mobilithek, DB, Switzerland,
Belgium) stay off until the key is in `.env` and passes `bash scripts/check-keys.sh` ([KEYS.md](KEYS.md)).

## Realtime processing

The realtime processor (`services/ingest/src/realtime`) reads the payloads the recorder stored, matches them to
timetable trips and writes stop events, forecasts, per-segment observations and alerts. It never fetches a source
itself. Every command refuses any database but a throwaway one (`gerlines_rt…`, `gerlines_wp<n>`,
`gerlines_test…`) unless `--allow-shared` is given.

```bash
export POSTGRES_HOST=127.0.0.1 POSTGRES_DB=gerlines_rt   # the other POSTGRES_* come from .env or the Compose defaults
export RECORDINGS_DIR="$PWD/data/recordings"     # absolute path
pnpm --filter @gerlines/ingest realtime replay --from 2026-10-26T21:00:00Z --to 2026-10-27T07:00:00Z --speed 0
pnpm --filter @gerlines/ingest realtime check     # invariants, data quality counts, table sizes
pnpm --filter @gerlines/ingest realtime live      # follow the recordings as they are written
pnpm --filter @gerlines/ingest realtime --help
```

The database needs the timetable loaded first (`uv run gerlines-static-import load`, see
`pipelines/static_import/README.md`) and the recordings indexed (`recorder reindex`). The Compose profile
`realtime` runs `live` as a service against the shared database (`--allow-shared`); on `main` it is defined but not
started by any `pnpm` script.

## Live engine

`services/live` turns the timetable and the realtime forecasts into a motion plan per train and publishes them as
binary keyframes and deltas (`packages/live-frame/FORMAT.md`), plus one shape pack per track shape. Clients evaluate
the plans by distance along the shapes ([ADR 0001](adr/0001-computed-positions-on-matched-track.md)). The engine
reads the database only (`DATABASE_URL` or `POSTGRES_*`; `SHAPES_DATABASE_URL` optionally supplies the shapes from
another database).

```bash
cd services/live
pnpm live packs build --out /abs/live --timetable-version <feed_version_id>
pnpm live render --from 2026-10-25T15:00:00Z --to 2026-10-25T17:00:00Z --out /abs/render --report /abs/render.json
pnpm live verify continuity --out /abs/render --packs /abs/live --report /abs/render.json --time-scale 10
pnpm live verify compare /abs/render-a /abs/render-b
pnpm live run --out /abs/live --memory-keys
pnpm live --help
```

| Command | What it does |
| --- | --- |
| `packs build` | writes `DIR/s/<epoch>/<shape number>.bin` for every drawable shape of a timetable version and runs the geometry gate: hairpins (turns above 160 degrees not at an intermediate stop), U-turns and falling M; exits 1 when a shape has a fault that its `--allow-*` list does not name by shape number (none by default) or when no shape is linked to the version (`--timetable-version` is required). The packs are written either way; `DIR/s/<epoch>/complete.json` marks the version only after a full build of more than 0 shapes without failures that passed the gate, and a new build of that version drops its mark first. Build again for every new shape epoch |
| `render` | runs the engine over a past window on a virtual clock against the recorded forecasts and writes every keyframe and delta under `--out`; `--report` writes the run's report with the heads the `verify` commands read, `--detail-check` also builds and checks every train detail |
| `verify continuity` | a headless client follows a render with the packs and counts jumps, stalls, backward motion and positions off the track |
| `replay` | serves a finished render as if it were live: `/live/v1/head` follows a virtual clock over the render's heads at `--speed`, objects from `--out`, shape packs from `--packs`; no database (default port 8788) |
| `verify chain`, `verify compare` | simulated clients joining at random heads; sha256 of two renders (determinism) |
| `run` | follows realtime, publishes frames under `--out`, serves `/live/v1/head`, `/live/v1/k/…`, `/live/v1/d/…`, `/live/v1/s/<epoch>/…` and `/healthz` on `127.0.0.1:8790` (`--port`; the API keeps 8787); writes train details to Valkey (`VALKEY_URL`, or `--memory-keys` without Valkey and without details) and pushes notices to Centrifugo when `CENTRIFUGO_URL` is set. Until `--out/s/<epoch>/complete.json` marks the packs of the current shape epoch for the newest loaded timetable version it answers 503 on every path and logs once a minute |
| `playback render` | renders each settled UTC hour of the window (default the last `--last 24` hours) that the cache `--cache` lacks, at a delta every 10 s and a keyframe every 300 s, then drops windows older than 7 days, replaced revisions after two hours and the oldest windows above `--budget-mb`; one job per cache (`render.lock`, exit 75 while it is held), niced; `--packs` is the pack gate of `run` ([ADR 0014](adr/0014-playback-windows-from-history.md)) |
| `playback serve` | serves `/playback/v1/*` from a cache and `/live/v1/s/*` from `--packs` for development; `--render-on-miss` renders a missing window on request, on loopback hosts only. `run` serves the same routes read only when `LIVE_PLAYBACK_DIR` names the cache |

Relative paths are resolved against `services/live` (pnpm runs the script there), so pass absolute paths. The
Compose service `live` (profile `live`) runs `run` with `LIVE_DIR` (default `data/live/run`) mounted at `/live`;
build the packs into that directory first, as `infra/README.md` describes. The train detail writer can also run
alone: `pnpm detail render --at <ISO instant>` (in `services/live`, `--help` for options) builds every running
train's detail and checks it against the `TrainDetail` schema; `apps/api` serves it at `/api/v1/trains/{id}`.

### Shape epochs and packs

Frames name shapes by number within a shape epoch: the highest epoch in `shape_registry` of the database the engine
reads (`DATABASE_URL`), carried in every frame header and in a render's report (`shapeEpoch`). Packs sit at
`DIR/s/<epoch>/`, so a render or a running engine is served with the packs of its own epoch: `replay --packs` and the
`live` directory must hold `s/<epoch>/` of that epoch. A new set of shapes, a new shapes load or a
`SHAPES_DATABASE_URL` that points at another load, is a new epoch:

1. Register it in the database the engine reads, above every epoch there (the registry is append only, migration
   0057): `INSERT INTO shape_registry (epoch, note) VALUES (<highest + 1>, '<which shapes, from which load>')`.
2. Build its packs with the same `DATABASE_URL` and `SHAPES_DATABASE_URL` the engine will use:
   `pnpm live packs build --out <dir> --timetable-version <id>`. Known faulty shapes are allowed by number only
   (`--allow-u-turn-shapes <no>,<no>`, repeated options merge). Without a passing, full build there is no `complete.json`.
3. Start `live run` again, or render again: a running engine keeps the epoch it started with, and a new one waits for
   `complete.json`.

Loading other shapes or links into the database a registered epoch was built from, without a new epoch, makes frames
name shape numbers that the epoch's packs do not hold. A packs directory built before `complete.json` existed gets it
from one more `packs build` run (the packs are kept, about 2 minutes for a national timetable).

To watch a render in the browser without a database, serve it with `replay` and point the web dev server at it
(`LIVE_PROXY_TARGET` forwards `/live` and `/replay`, so the page stays on one origin):

```bash
cd services/live && pnpm live replay --out /abs/render --packs /abs/live --report /abs/render.json \
  --speed 10 --loop --port 8788
LIVE_PROXY_TARGET=http://127.0.0.1:8788 pnpm --filter @gerlines/web dev    # then open /?replay=10
```

The web client's address parameters (`?live=`, `?replay=`, `?probe=1`) and its continuity
probe are described in `apps/web/README.md`, section Our own trains.

## Train models and the 3D cars

The map draws our engine's trains as 3D cars once a car is wide enough on screen (about zoom 16;
[architecture.md](architecture.md), section 8.4, and [ADR-0013](adr/0013-3d-car-hand-over-by-screen-width.md)). The
models come from `tools/trainforge` and are not in git, so build them once per clone and after every change under
`catalog/` or `tools/trainforge`:

```bash
pnpm --filter @gerlines/trainforge build    # writes tools/trainforge/dist: manifest.json, palette.png, models/
```

The web dev and preview servers serve `tools/trainforge/dist` at `/trains/`, and `vite build` copies it into
`apps/web/dist/trains/`; `pnpm build` (turbo) builds the forge first. Without a forge build the page draws chevrons
only, `vite build` warns "no forge build", and the browser console shows `[cars] train models failed to load` with
a retry delay that doubles from 1 s to 1 min. For frame budget runs, `?probe=1&carRadiusKm=<km>` widens the radius
in which trains are drawn as cars (still at most 300 trains). The forge's own commands, preview page and output
format are in `tools/trainforge/README.md`.

## Journey router

MOTIS 2 runs as the Compose service `router` (`pnpm router:up`) from a data folder imported by
`services/router/scripts/import.sh`; `apps/api` serves `/api/v1/journeys` when `ROUTER_BASE_URL`, `APP_NAME` and
`APP_CONTACT` are set. The import needs several GB of memory and disk: `services/router/README.md`.

## Secret scanning

Two scanners share one set of project rules:

- **secretlint** (`.secretlintrc.json`): the recommended preset plus pattern rules for the keys this project uses:
  DB API Marketplace client id and key (as variables and as the `DB-Client-Id` and `DB-Api-Key` headers),
  opentransportdata.swiss keys and bearer JWTs, Cloudflare and R2 credentials, Hetzner Cloud tokens, GlitchTip or
  Sentry DSNs with a key, and Postgres passwords with a real value. It runs in the pre-commit hook, in
  `pnpm secrets:scan` and in CI.
- **gitleaks** (`.gitleaks.toml`): the default gitleaks rules plus the same project rules, over the full git
  history in CI.

Empty values, `<placeholders>`, `${VARIABLE}` references, reads from `os.environ` or `process.env` and the
`.env.example` value `change-me-locally` are allowed. The made-up fixtures in `packages/config/secret-fixtures.json`
(values are assembled at test time, so the file itself holds no key-shaped text) must be reported by both tools,
and the placeholders must not be; `packages/config` tests secretlint, `scripts/check-gitleaks-rules.mjs` tests
gitleaks. To cover a new key format, add a rule to both configuration files and a `mustFail` fixture.

Neither scanner reads binary files (a NUL byte, images, archives such as `.gz`): never put a secret into a binary
file, and review binary additions by hand.

## Continuous integration

Four workflows in `.github/workflows/` run on pushes and pull requests to `main`:

| Workflow | Runs when | Jobs and steps |
| --- | --- | --- |
| `ci.yml` (CI) | every push and pull request | **TypeScript:** `pnpm install --frozen-lockfile`, `pnpm turbo run lint typecheck test --concurrency=2` (two tasks at a time on the two-core runner; includes the copy lint and the secretlint fixtures) with the turbo cache restored from earlier runs, `pnpm secrets:scan`; cache entries older than seven days are pruned before saving. **Python and policy:** `uv sync --locked`, ruff check, ruff format check, `pytest -m "not db" --ignore=pipelines/rail_graph`, actionlint, REUSE lint, the data licence guard and its tests, the gitleaks fixtures and gitleaks over the full history; the secret, workflow and licence steps run even when an earlier step failed |
| `db.yml` (Database) | changes under `services/ingest`, `services/live`, `pipelines`, `packages/db`, `packages/config`, `packages/geo`, `packages/live-frame`, `packages/schema`, `infra` and the lock and version files | a TimescaleDB service container with the image pinned in `infra/compose.yaml`; `pnpm db:test`, the recorder index integration test, the live engine integration tests, the Python database tests (`pytest -m db`), and migrate up, roll back four, migrate up again through the CLI |
| `rail-graph.yml` (Rail graph) | changes under `pipelines/rail_graph`, `pipelines/common` and the uv files | `uv sync --locked --group rail-graph`, then the rail graph tests (osmium, scipy) |
| `audit.yml` (Dependency audit) | every push and pull request, Mondays 04:23 UTC, by hand | `pnpm audit --prod --audit-level high` over `pnpm-lock.yaml`; `uv export --all-packages --no-dev` of `uv.lock` audited by pip-audit (pinned, hashes required), then `scripts/check-pip-audit.mjs` fails on a high, critical or unrated advisory, with the OSV record or its GitHub alias as the source of the rating (pip-audit has no severity filter); moderate and low findings are listed without failing |

Only pull request runs cancel an older run of the same branch; every push to `main` is checked to the end. Actions
are pinned to full commit SHAs with the version in a comment. Dependabot proposes grouped monthly updates for
GitHub Actions, npm, uv, Docker Compose images and Dockerfiles, at most five open pull requests each. The actionlint and gitleaks binaries are
downloaded at pinned versions, retried five times when GitHub's release downloads fail, and verified against their
release checksums.

## Versions and the TypeScript compiler

Shared dependency versions live once in the `catalog:` of `pnpm-workspace.yaml` and are referenced as `"catalog:"`.
Versions are exact (`saveExact: true`); `pnpm install --frozen-lockfile` fails when `package.json` and
`pnpm-lock.yaml` disagree. `packageManager` pins pnpm with the sha512 of its npm tarball; when pnpm is upgraded,
take the new value from `npm view pnpm@<version> dist.integrity` (base64) and write it as hex after `+sha512.`.

The workspace uses TypeScript 7 (the native compiler) for `tsc` and the editor. TypeScript 7 does not ship the
JavaScript compiler API of TypeScript 6 and earlier. A tool that imports that API gets TypeScript 6 under the alias
`@typescript/typescript6`:

- a tool that requires `typescript` without declaring it (kysely-codegen): add it under `packageExtensions` in
  `pnpm-workspace.yaml` with `typescript: npm:@typescript/typescript6@6.0.2`;
- a tool that declares `typescript` as a peer (openapi-typescript): install it in the package that runs it,
  together with `"typescript": "npm:@typescript/typescript6@6.0.2"` in that package's `devDependencies`. Keep such
  code generation in a package that does not need `tsc` 7 for its own sources.

## Adding a package

TypeScript package (for example `packages/frames`):

1. Create `package.json` like the existing ones: `"name": "@gerlines/frames"`, `"private": true`,
   `"type": "module"`, `"license": "AGPL-3.0-or-later"`, `"exports": { ".": "./src/index.ts" }`, the three scripts
   `lint` (`biome check .`), `typecheck` (`tsc`), `test` (`vitest run --passWithNoTests`), and devDependencies
   `@biomejs/biome`, `typescript`, `vitest` as `"catalog:"` plus `"@gerlines/config": "workspace:*"`.
2. Create `tsconfig.json` extending one profile from `packages/config/tsconfig/`: `base.json` (runs in Node and
   the browser), `node.json` (Node only, adds `@types/node`, also add `"@types/node": "catalog:"`) or `dom.json`
   (browser and React).
3. Add `src/index.ts`, then `pnpm install`.
4. Depend on another workspace package with `"@gerlines/<name>": "workspace:*"`. Relative imports carry the `.ts`
   extension (Biome `useImportExtensions`), so files run unchanged under Node type stripping in the workspace.
   Node refuses to strip types for files under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so a
   service shipped in a container (after `pnpm deploy` or with copied packages) is bundled first; WP-1.3 chooses
   the bundler.

The workspace globs in `pnpm-workspace.yaml` (`apps/*`, `services/*`, `packages/*`, `tools/*`, `spikes/*`), the
tasks in `turbo.json`, `biome.json` and CI pick a new package up without further changes.

### Package-level task settings

A package changes its own turbo tasks in a `turbo.json` next to its `package.json`, without touching root files.
Turborepo runs in strict environment mode: a task sees only the variables it declares. A package whose tests need
a database URL declares it like this:

```json
{
  "$schema": "../../node_modules/turbo/schema.json",
  "extends": ["//"],
  "tasks": {
    "test": {
      "env": ["DATABASE_URL"]
    }
  }
}
```

`env` passes the variable and makes its value part of the cache key (a different database gives a different
cache entry); `passThroughEnv` passes it without affecting the cache key, for values such as credentials that do
not change the result. Extra inputs outside the package use `"inputs": ["$TURBO_EXTENDS$", "$TURBO_ROOT$/<path>"]`,
as `packages/config/turbo.json` does for the secret rules. A test that imports a file from a package it does not
depend on must list that file the same way, or turbo replays a stale result from its cache.

Generated code: `packages/i18n` compiles its messages into `src/paraglide/` (git-ignored) with its own `compile`
task. A package that imports it names the task as `@gerlines/i18n#compile` in `dependsOn` of its `typecheck`,
`test`, `build` and `dev` (`^compile` fails because turbo wants the task in every dependency).

### Root files that need a maintainer review

Some changes need a root file, which a maintainer reviews:

- `allowBuilds` in `pnpm-workspace.yaml` for a dependency that must run an install script;
- `packageExtensions` in `pnpm-workspace.yaml` (for example kysely-codegen and TypeScript 6, see above);
- new shared versions in the `catalog:`;
- a shared persistent task such as `dev` (`"cache": false, "persistent": true`) in the root `turbo.json`;
- service containers (Postgres and others) and new jobs in `.github/workflows/ci.yml`;
- new workspace globs in `pnpm-workspace.yaml` or new members outside `pipelines/*` in `pyproject.toml`;
- root scripts in `package.json`, `biome.json`, `lefthook.yml`, `.gitignore`, `REUSE.toml` and the secret rules.

Python pipeline (for example `pipelines/static_import`):

1. `uv init --lib --build-backend uv pipelines/static_import` or copy `pipelines/common`: a `pyproject.toml` with
   `requires-python = ">=3.13"`, `license = "AGPL-3.0-or-later"`, the `uv_build` backend, sources in
   `src/<package>/`, tests in `tests/`.
2. Depend on shared code with `dependencies = ["gerlines-common"]` and
   `[tool.uv.sources] gerlines-common = { workspace = true }` in the member.
3. Pin third-party versions exactly, then `uv lock` and commit `uv.lock`.

The root `pyproject.toml` already includes `pipelines/*` as members and holds the ruff and pytest settings.

## Licensing

The repository follows the [REUSE](https://reuse.software) specification: `REUSE.toml` annotates every file as
`AGPL-3.0-or-later`, the licence text is in `LICENSES/` (and in `LICENSE`). Data and third-party assets get their
own `[[annotations]]` entry in `REUSE.toml` when they are added; later entries take precedence. Before committing a
file derived from a feed, keep only records of feeds whose licence allows redistribution and name each of them in the
entry; [data-sources.md](data-sources.md) lists the licences.

`scripts/check-data-licences.mjs` guards this in CI next to `reuse lint`: it reads the output of `reuse spdx`
and fails when a data file resolves only to the `**` AGPL catch-all. Data means a file under a `fixtures`,
`test-vectors`, `results` or `data` directory, or any `*.pb`, `*.gz`, `*.geojson`, `*.csv` or `*.xml` file. Files
that really are ours (synthetic vectors, our own measurements, code beside fixtures) go on
`scripts/data-licence-exemptions.json` with a reason; an exemption that no longer matches fails too. Run it locally:

```bash
uv run --frozen reuse spdx --output "$TMPDIR/reuse.spdx"
node scripts/check-data-licences.mjs "$TMPDIR/reuse.spdx"
node --test scripts/check-data-licences.test.mjs
```
