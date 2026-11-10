# ADR-0003: MapLibre GL JS 6 with deck.gl 9.4, interleaved, WebGL2

## Status
Accepted (2026-10-23)

## Context
We draw thousands of moving trains over a vector basemap with 3D buildings and terrain, on phones and desktops,
with an open licence. The reference site uses MapLibre 5.24 with deck.gl 9.4; MOTIS RailViz uses MapLibre 6 with
deck.gl 9.4; Mini Tokyo 3D uses Mapbox GL with a three.js custom layer.

## Decision
MapLibre GL JS 6.x (ESM only, WebGL2) as the map; deck.gl 9.4 through `@deck.gl/maplibre` in interleaved mode for
trains, routes and profiles. Levels of detail: dots, oriented icons, true-length track slices, 3D cars from zoom
14.5. Train elevation comes from baked shape z, because deck.gl layers are not draped on MapLibre terrain. WebGPU
is revisited in 2027.

## Consequences
### Positive
- Open licence, shared WebGL context, picking and layer ordering under labels, proven by MOTIS.
### Negative
- Our own z baking and bridge and tunnel handling; visual QA on steep corridors.
- MapLibre 6 drops WebGL1 browsers (acceptable in 2026).
### Alternatives considered
- **three.js custom layer**: full control, but picking, LOD and instancing would be ours to write.
- **Mapbox GL JS**: proprietary licence and per-load pricing.

## Date
2026-10-23
