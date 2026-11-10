# ADR-0004: One basemap schema (OpenMapTiles), keyless in development, self-hosted in production

## Status
Accepted (2026-10-23)

## Context
R-05 asks for a beautiful map with landuse, roads, forests, terrain and several styles; R-17 needs neighbouring
countries labelled; R-02 needs DE, EN and PL labels; budget is free now and about 20 EUR per month later. A style is
tied to its tile schema, so switching schemas later means rewriting styles.

## Decision
- Schema: OpenMapTiles. Development tiles from OpenFreeMap (keyless, Polish, German and English names, building
  heights). Production: our own Planetiler build of Germany plus neighbours as PMTiles on Cloudflare R2 behind the
  CDN (about 5.5 GB to zoom 14).
- Styles generated from DESIGN.md tokens: dark (default), light, satellite (VersaTiles orthophotos), terrain
  (hillshade and relief).
- Terrain: Mapterhorn DEM (1 m sources in Germany), 3D terrain only when pitched or toggled.
- Borders and Länder: BKG VG250 and VG2500 (DL-DE BY 2.0), Natural Earth for neighbours.
- Glyphs self-hosted in production.

## Consequences
### Positive
- No paid key; one style codebase from development to production.
### Negative
- OpenFreeMap, VersaTiles and Mapterhorn run on donations without guarantees: self-host before launch.
- basemap.de (official, Germany only, German labels only) can only be an optional extra style.
### Alternatives considered
- **MapTiler, Stadia**: free plans non-commercial and quota-bound.
- **Protomaps schema**: good, but OpenFreeMap's ready styles and the reference site's proven setup favour OpenMapTiles.

## Date
2026-10-23
