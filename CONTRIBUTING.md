# Contributing to GerLines

Thank you for your interest. GerLines is a young, maintainer-led project: the plan in [docs/PLAN.md](docs/PLAN.md)
sets the order of work, and most of the code is written in planned work packages. Contributions that fit this plan
are welcome, and so are bug reports and reports of wrong data.

## Before you start

- **Bugs and wrong data:** open an issue. For a wrong train, give the train number, the date and time, what the
  map showed and what you expected, and a link to an official source if you have one.
- **Features and larger changes:** open an issue first and describe the change. Check [docs/PLAN.md](docs/PLAN.md):
  the work may already be planned or in progress on a branch.
- **Security problems:** do not open an issue; follow [SECURITY.md](SECURITY.md).
- **Issue forms:** bug report, wrong train data, feature or change. Blank issues are switched off.

## Set up

Follow [docs/development.md](docs/development.md): Node 24, pnpm 11, uv, and Docker for the database. The short
version is in the README under Quick start. You need no API key to run the web client. A fresh clone draws the map without trains until a live engine or a replay runs.

## Make a change

1. Fork the repository and create a branch from `main`.
2. Keep the change focused on one topic. Write tests first for logic; adapters get recorded fixtures, geometry and
   motion get property tests.
3. Run the checks:

   ```bash
   pnpm turbo run lint typecheck test
   uv run pytest -m "not db" --ignore=pipelines/rail_graph
   pnpm secrets:staged
   ```

   Database changes also need `GERLINES_DB_TESTS=required pnpm db:test` against the local database
   (`pnpm infra:up`).
4. Commit with [Conventional Commits](https://www.conventionalcommits.org/): `feat(web): …`, `fix(ingest): …`,
   `docs: …`. Explain why in the body when it is not obvious.
5. Open a pull request against `main` and fill in what changed, how you checked it and, for UI changes,
   screenshots at phone and desktop width in dark and light.

## Project rules

These rules come from the requirements of the project. A pull request that breaks one is not merged.

- **On the track.** Train positions are evaluated by distance along a matched shape. Straight-line interpolation,
  extrapolation along a heading, backwards motion and jumps are bugs ([ADR 0001](docs/adr/0001-computed-positions-on-matched-track.md)).
- **Real data only.** Every number, photo and logo shown comes from a named source with its licence. Missing data is
  shown as missing, never invented.
- **Licences.** Data, fixtures, photos and other third-party files need an entry in `REUSE.toml` with their author
  and licence, and the source in [docs/data-sources.md](docs/data-sources.md). Check with
  `uv run --frozen reuse lint`. Do not add screenshots of other websites.
- **No secrets, no raw data.** Never commit `.env`, keys, certificates, recordings or anything from `raw/` and
  `data/`. The pre-commit hook and CI scan for secrets.
- **Outbound requests** send `User-Agent: <APP_NAME>/<version> (+<APP_CONTACT>)` and respect each provider's rate
  limit and terms.
- **Design.** Visual changes follow [DESIGN.md](DESIGN.md). Propose a change to DESIGN.md in the pull request
  rather than working around it.
- **Interface text** is concrete and short, and has no double dashes, slashes, quotation marks, semicolons or middle
  dots. Every message exists in English, German and Polish (`packages/i18n`).
- **Migrations** are plain SQL in `packages/db`. The runner refuses a migration numbered below the highest one
  applied, so ask in the issue which number range to use.

## Licence of contributions

GerLines is licensed under AGPL-3.0-or-later. By contributing, you agree that your contribution is licensed under
the same licence. Data you add keeps the licence of its source, recorded in `REUSE.toml`.

## Conduct

Follow the [code of conduct](CODE_OF_CONDUCT.md). Report a problem with GitHub's Report content menu, as it
describes.
