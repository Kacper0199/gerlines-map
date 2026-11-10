## What changes

<!-- One or two sentences: what this pull request changes and why. Link the issue. -->

## How it was checked

- [ ] `pnpm turbo run lint typecheck test`
- [ ] `uv run pytest -m "not db" --ignore=pipelines/rail_graph` (Python changes)
- [ ] `GERLINES_DB_TESTS=required pnpm db:test` (migrations or database code)
- [ ] `uv run --frozen reuse lint` (new files, data or assets)
- [ ] `pnpm secrets:staged` before each commit

<!-- Paste the relevant output or numbers. Say plainly what you did not check. -->

## Screenshots

<!-- UI changes: phone (390 px) and desktop (1440 px) width, dark and light. Keep the map attribution visible. -->

## Project rules

- [ ] Trains move only along their matched shape (no straight lines, no jumps, no backwards motion)
- [ ] Every number, photo or logo shown has a named source with its licence, recorded in `REUSE.toml` and `docs/data-sources.md`
- [ ] New interface text exists in English, German and Polish and passes `pnpm lint:copy`
- [ ] No `.env`, keys, recordings or files from `raw/` and `data/`
