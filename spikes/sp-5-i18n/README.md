# SP-5 locale switch spike

Proves that English, German and Polish switch at runtime without a reload while one MapLibre map stays mounted, with
Paraglide JS 2 (`packages/i18n`). It is a spike, not product code: private workspace member, linted, type-checked and
tested in CI (`turbo run lint typecheck test`); the measurements are manual.

## What it renders

- OpenFreeMap `dark` style (light use) with one MapLibre 6 map. Name labels follow the language through a
  `text-field` coalesce (`name:<language>`, `name:en`, `name:de`, `name`) applied with `setLayoutProperty`; the style
  is never reloaded (`src/map/labels.ts`).
- A header with the language switch, a train card, a legend and a live bar. Every string comes from `@gerlines/i18n`.
- Numbers are a real snapshot: counts and the ICE 379 card come from `design/variants/data/` (Transitous over DELFI,
  captured 2026-10-23 21:34 Berlin time), copied into `fixtures/sample.json` by `scripts/build-fixture.mjs`. The four
  plural lines at the end of the legend are plural checks, not data.
- `?lang=de` starts in a language; otherwise the stored choice, the browser language, then English.

## Run it

```bash
export PATH="$HOME/.nvm/versions/node/v24.22.1/bin:$PATH"
pnpm install
pnpm --filter @gerlines/sp-5-i18n dev        # http://127.0.0.1:5173, compiles the messages first
pnpm --filter @gerlines/sp-5-i18n build && pnpm --filter @gerlines/sp-5-i18n preview
```

Where file events are not delivered, start the dev server with `VITE_USE_POLLING=1`, or file changes are not seen. Editing a
message file reloads the page (the Paraglide plugin does not hot swap messages).

## Measure it

| What | Command |
| --- | --- |
| Map identity, switch timings, long tasks, tile and glyph requests | open the page, then `playwright-cli -s=sp-5 run-code --filename=spikes/sp-5-i18n/scripts/probe-run.js` |
| The same under 4 times CPU throttling | `playwright-cli -s=sp-5 run-code --filename=spikes/sp-5-i18n/scripts/probe-throttled.js` |
| Bundle size per number of locales | `pnpm --filter @gerlines/sp-5-i18n measure:bundle` (writes `results/bundle-sizes.json`) |
| i18next for the same strings | install `i18next` and `react-i18next` in a scratch directory, then `I18NEXT_DIR=<dir> node scripts/measure-i18next.mjs` |

The probe (`src/probe.ts`, installed as `window.__sp5`) is part of the spike only.

## Notes

- The Paraglide Vite plugin in `vite.config.ts` writes into `packages/i18n/src/paraglide`, the folder `pnpm --filter
  @gerlines/i18n compile` fills, so both write the same files. CI and turbo use the `compile` task; the plugin only adds
  recompiling while `dev` runs.
- `src/web-copy-parity.test.ts` reads `apps/web/src/copy.ts`, which is not a dependency of this package. `turbo.json`
  lists that file (and the two type files it imports) as inputs of `test` and `typecheck`, so a change there invalidates
  the turbo cache. Delete the test and the inputs together with `copy.ts` in WP-4.6.
