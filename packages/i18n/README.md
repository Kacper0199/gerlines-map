# @gerlines/i18n

Messages in English, German and Polish, compiled with Paraglide JS 2 ([ADR 0010](../../docs/adr/0010-frontend-stack.md)). The map stays mounted when the language changes: the locale switch never reloads the page.

## What is here

| Path | What |
| --- | --- |
| `messages/{en,de,pl}.json` | every UI string, one flat key per string (`card_platform_changed`), plurals as Paraglide variants |
| `project.inlang/settings.json` | locales and the message format plugin, read from `node_modules` so compiling needs no network |
| `project.inlang/paraglide.config.js` | compiler options shared by the CLI and the Vite plugin: client only, strategy `localStorage`, `preferredLanguage`, `baseLocale`, one module per message |
| `src/paraglide/` | generated, git-ignored and excluded from Biome by `biome.json`; `pnpm --filter @gerlines/i18n compile` (turbo runs it before `typecheck` and `test`) |
| `src/locale.ts` | the locale store: `currentLocale`, `changeLocale`, `subscribeLocale`, locale names and BCP 47 tags |
| `src/copy-lint.ts` | the copy lint as a pure function (`lintCopy`), with `copy-lint.test.ts`; the command is `scripts/lint-copy.ts` at the repository root |
| `copy-lint.allow.json` | allow list for the copy lint, empty by default: `{ "allow": [{ "key", "rule", "locale"?, "reason" }] }` |
| `src/copy.ts` | `copyFor(locale)`: every string of the entry (shell, card, legend, map error, attribution) in one nested object, built once per locale |
| `src/copy-stats.ts`, `copy-legal.ts`, `copy-journeys.ts`, `copy-predict.ts`, `copy-playback.ts`, `copy-profile.ts`, `copy-status.ts` and their hooks `src/stats.ts`, `legal.ts`, `journeys.ts`, `predict.ts`, `playback.ts`, `profile.ts`, `status.ts` | the statistics, legal, planner, forecast, playback, segment profile and data status strings and `useStatsCopy()`, `useLegalCopy()`, `useJourneysCopy()`, `usePredictCopy()`, `usePlaybackCopy()`, `useProfileCopy()`, `useStatusCopy()` (subpaths `@gerlines/i18n/stats`, `/legal`, `/journeys`, `/predict`, `/playback`, `/profile`, `/status`): imported only by the lazily loaded panels, pages and card blocks, so their messages stay out of the entry chunk; the entry copy keeps `stats.open`, `journeys.open` and the four footer links of `legal` |
| `src/copy-a11y.ts`, `src/a11y.ts` | the skip link, the map keys hint, the retry hint and the result count, `useA11yCopy()` (subpath `@gerlines/i18n/a11y`), read by the entry (search and map) |
| `src/format.ts` | `formattersFor(locale)`: clock, day, count and count parts with `Intl` in Europe/Berlin, and the speed in km/h with a no-break space (`120 km/h`, `120 km/godz.`) |
| `src/react.ts` | `useLocale`, `useCopy`, `useFormatters` on `useSyncExternalStore` (import from `@gerlines/i18n/react`) |

## Use

```tsx
import { changeLocale } from "@gerlines/i18n";
import { useCopy, useFormatters } from "@gerlines/i18n/react";

function Platform({ track }: { track: string }) {
  const copy = useCopy();
  const { clock } = useFormatters();
  return <p>{copy.card.platform(track)} {clock(Date.now())}</p>;
}
```

Switch with `void changeLocale("pl")`; `changeLocale("pl", { persist: false })` switches for the current visit only (used for `?lang=`). It updates the store, sets `<html lang>`, notifies subscribers (React and the map
label binding) and stores the choice in local storage under `PARAGLIDE_LOCALE`. Without a stored choice the language
comes from the browser, then English.

## Rules that keep the switch working

- Components read strings through `useCopy()` or pass the locale to a message: `m.brand_tagline({}, { locale })`.
  A bare `m.brand_tagline()` in a component is memoised by the React Compiler and keeps the old language after a
  switch (proved in `spikes/sp-5-i18n/src/compiler-memo.test.tsx`).
- Code outside React, for example a worker or a map layer, subscribes with `subscribeLocale` and reads `currentLocale()`.
- The store lives in one JavaScript realm. A worker that imports this package gets its own copy of it: send the locale to
  the worker with `postMessage` and call `changeLocale` there.
- `changeLocale` stores the choice first, then calls every listener; a listener that throws does not stop the others, and the
  promise rejects with an `AggregateError` after all of them ran.
- A package that imports this one needs `"allowJs": true` and `"checkJs": false` in its tsconfig: the compiler output is
  JavaScript with JSDoc types.
- Copy rule R-15: no double dashes, slashes, quotation marks (also `„ “ « »`), semicolons or middle dots in any
  message. `src/messages.test.ts` checks the sources, `src/copy.test.ts` checks the rendered strings of every locale.
- `pnpm lint:copy` (also part of this package's `lint`, so of `turbo run lint`) reads `messages/*.json` and fails on the
  characters above (after NFKC, so lookalikes such as the full-width slash, bullets and the Greek question mark count;
  URLs and `{placeholders}` are ignored), on a key missing in or extra to a locale, on placeholders, plural input names
  or plural forms (other than `one`) that lose a placeholder of English, and on a key nobody reads. A key is read when
  `src/copy.ts` or one of the lazy `copy-*.ts` files wires it to a property (`prop: m.key(`) and a component or module in `apps/web/src` or `packages/ui/src`
  reads that property (`.prop`, a destructured `prop`, or a computed access on a parent such as `errors[code]`), or when
  `m.key` appears outside those files. Comments do not count. Keys must be static: write `m.key`, not `m[name]`.
  A code that needs a forbidden character goes into `copy-lint.allow.json` with a reason (both the lint and the
  rendered-string test in `copy.test.ts` honour it); an invalid or stale entry fails. Leaf names are matched by name
  only, so a property called `label` counts as read wherever `.label` is read: the check is coarse, not exact.
- Narrow phones (up to 480 px) show `search.placeholderShort`: the full placeholder is 227 px wide and the input has
  147 to 219 px at 390 px. Every long string needs a short form measured at 360 px before it goes in the shell.

## Add a message or a language

1. Add the key to `messages/en.json`, then to `de.json` and `pl.json` (same placeholders; `messages.test.ts` fails
   otherwise). Polish plurals need `one`, `few`, `many` and `other`.
2. Expose it in `src/copy.ts` (or the lazy `copy-*.ts` of its panel; `scripts/lint-copy.ts` lists the wiring files) under the matching section and run `pnpm turbo run lint typecheck test --filter=@gerlines/i18n`.
3. A new language needs its code in `project.inlang/settings.json`, `LOCALE_NAMES` and `LOCALE_TAGS` in `src/locale.ts`,
   its plural categories in `messages.test.ts` and a file in `messages/`. Each language costs about 0.9 KB gzip.
