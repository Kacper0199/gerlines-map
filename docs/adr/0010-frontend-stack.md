# ADR-0010: Vite and React single-page app, URL state, worker for motion

## Status
Accepted (2026-10-23); component library confirmed in WP-1.5 with the chosen design direction

## Context
The client is a WebGL-heavy map app with panels, statistics and search, in three languages, deployed as static
files on a CDN. The map loop runs outside any UI framework.

## Decision
- Vite and React 19 with TypeScript, React Compiler; TanStack Router with typed search params so every view (train,
  station, Land, mode, style) is a shareable URL; TanStack Query for server data; Zustand for UI state. Live
  vehicle data never enters React state.
- i18n: Paraglide JS for EN, DE, PL. Spike SP-5 (2026-10-25) confirmed it: the locale switches without a reload
  while the map stays mounted (same map object, no style or tile requests), about 5.7 KB gzip for the runtime and all
  messages in three languages against 21.6 KB for i18next. Components read strings through `useCopy()` from
  `@gerlines/i18n` (the React Compiler memoises a bare message call); i18next is not used.
- UI components: the React default (shadcn/ui on Base UI with Tailwind v4), themed fully
  from DESIGN.md tokens; WP-1.5 confirms or changes it.
- A Web Worker owns shapes and motion state and transfers typed arrays to deck.gl each frame.
- PWA shell later; live frames are never cached by the service worker.

## Consequences
### Positive
- Largest ecosystem for MapLibre and deck.gl; static hosting.
### Negative
- No server rendering; SEO pages for stations and trains can be prerendered later if wanted.
### Alternatives considered
- **SvelteKit, SolidStart**: smaller bundles, smaller map and component ecosystems.
- **Next.js**: server runtime not needed for a client-heavy map.

## Date
2026-10-23
