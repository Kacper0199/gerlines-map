# geo_base

Builds the static geography of the map from licensed sources: the Germany outline and the world-minus-Germany
mask, the 16 Länder for Land focus, the neighbour countries with label points, and a first list of rail border
crossings. Outputs are GeoJSON (RFC 7946, EPSG:4326) in `apps/web/public/geo/`.

## Run it

```bash
APP_NAME=gerlines APP_CONTACT=<contact> uv run geo-base download   # once; reuses verified files on disk
uv run geo-base build                                                # about 3 s, about 310 MB peak
uv run pytest pipelines/geo_base                                     # checks the committed outputs
```

`download` writes each archive to `data/geo/<source>/` with a sidecar `<file>.json` (URL, fetch time, bytes,
sha256, the published md5 where BKG offers one, licence, attribution, edition). Dropped connections, timeouts,
HTTP 5xx, truncated bodies and zips that fail `testzip` are retried with backoff and never kept. Each source in
`sources.py` pins its edition by sha256 (BKG from the versioned `2026/` folder); a different upstream file stops
the download and the build with a message to review the new edition. `build` reads only verified files and writes the same bytes on every run (no timestamps), plus
`pipelines/geo_base/build-report.json` with the sources, parameters, counts and the raw and gzip size of every
output. Options: `--data-dir`, `--out-dir`, `--report`.

## Sources

| Source | Used for | Licence and attribution |
| --- | --- | --- |
| BKG VG250 Ebenen, Stand 1 January 2026 (`vg250_ebenen_0101/2026/vg250_01-01.utm32s.gpkg.ebenen.zip`) | Germany, the Länder, German Land names | DL-DE BY 2.0, "© GeoBasis-DE / BKG (2026)", changed (see below) |
| Natural Earth 10m admin 1, 5.1.1 | English and Polish Land names, ISO 3166-2 cross-check | public domain |
| Natural Earth 10m admin 0, 5.1.1 | neighbour countries, their names (`NAME`, `NAME_DE`, `NAME_PL`) | public domain |
| Natural Earth 10m railroads, 5.0.0 | border crossing hints | public domain |

Change note for BKG data, carried in every BKG-based file: land areas only (VG250 `GF` 3 and 4, so coastal waters
and the Bodensee are outside), reprojected from ETRS89 UTM 32N to WGS 84, simplified with shared borders kept,
coordinates rounded.

## Method

1. Read `vg250_lan`, keep `GF` 3 and 4, dissolve per `ARS` into 16 Länder (a valid polygon coverage).
2. Parts under the level's threshold leave the coverage without opening gaps: one that shares an edge with another
   Land joins the Land it shares the longest edge with (small enclaves), the rest (islets, tiny exclaves abroad) are
   dropped. So a small exclave of Land A inside Land B is drawn as part of B, in `laender` and in B's focus mask.
   Named islands in `KEPT_ISLANDS` (Helgoland with its Düne, Neuwerk) stay whatever their area: German territory is
   never shown as abroad.
3. Simplify the coverage with `shapely.coverage_simplify` (GEOS coverage simplification, Visvalingam-Whyatt on
   shared edges), so every shared border stays identical: no slivers, no gaps. Two levels:

   | Level | Tolerance | Rounding | Parts kept | Outputs |
   | --- | --- | --- | --- | --- |
   | national | 300 m | 3 decimals (about 110 m) | 5 km² and more | `germany-outline`, `germany-mask`, `laender` |
   | focus | 100 m | 4 decimals (about 11 m) | 0.5 km² and more | `laender-masks/<code>` |

   The national threshold is 5 km² because MapLibre's GeoJSON simplification (source `tolerance`, default 0.375)
   turned the many islet holes of a 0.5 km² mask into dark wedges over the North and Baltic Seas at zoom 5 to 6.
   With 5 km² plus the kept islands the mask renders cleanly at the default (checked at zoom 4.5 to 6.3 in light
   and dark); smaller unnamed islets are masked at the national level and stay land in their Land focus.

4. Reproject to WGS 84, round, check validity and coverage again, orient rings for RFC 7946.
5. Outline is the union of the national Länder, so `laender` and `germany-outline` match exactly. The mask is
   the Web Mercator world (±180°, ±85.051129°) minus the outline: one polygon with Germany's parts as holes, plus
   the Austrian exclave Jungholz as a separate piece. No ring crosses the antimeridian.
6. Label points: pole of inaccessibility (polylabel, 100 m) of each Land's largest focus part, checked to lie
   inside both levels.
7. Neighbours: Natural Earth countries within 100 km of the outline (`shares_border` within 2 km); the label is
   the pole of inaccessibility of the country's part within 120 km of Germany, so it stays on screen at national
   zoom.
8. Border crossings: Natural Earth railroads (train ferries left out) intersected with the national outline,
   the country on the other side within 10 km, crossings closer than 3 km along one line merged.

## Outputs

| File | Content |
| --- | --- |
| `germany-outline.geojson` | one MultiPolygon, `code`, names in EN, DE, PL, `bbox` |
| `germany-mask.geojson` | world minus Germany, `role: outside-germany` |
| `laender.geojson` | 16 Länder: `code` (ISO 3166-2), `ars`, `name_en`, `name_de`, `name_pl`, `label_lon`, `label_lat`, `fit_west`, `fit_south`, `fit_east`, `fit_north`, and the RFC 7946 `bbox` of the whole Land |
| `laender-masks/<code>.geojson` | world minus that Land at focus detail, `role: outside-land`, names, `fit_*` |
| `neighbours.geojson` | label points: `code` (ISO 3166-1), names, `shares_border`, `distance_km` |
| `border-crossings.geojson` | points: `country`, `line` (null: Natural Earth has no line names), `source_id` |

Every FeatureCollection carries `attribution`, `licence`, `note` and `sources` members.

### Using them in the client

- National view: the existing `mask` and `outline` sources stay as they are. Setting `tolerance: 0` on the mask
  sources removes the simplification risk entirely (the files are already simplified).
- Land focus: load `geo/laender-masks/<code>.geojson` on demand (3 to 34 KB gzip), swap it into the mask source
  (`setData`), draw its rings as the Land outline, and `fitBounds([[fit_west, fit_south], [fit_east, fit_north]])`
  with the panel padding. `fit_*` leaves out far islets (Hamburg's Neuwerk, Helgoland), the `bbox` member covers
  the whole Land.
- Land labels: build points from `label_lon` and `label_lat` (scalar properties survive MapLibre's GeoJSON
  worker); the polygons serve hit testing and the Land list.
- A client-built alternative to the mask files: a Polygon whose outer ring is the world and whose holes are the
  Land's outer rings, plus each of the Land's holes (Berlin inside Brandenburg, Bremen inside Lower Saxony) as an
  extra polygon. The prebuilt files avoid that code and are tested.

## Preview

`bash pipelines/geo_base/preview/serve.sh [port]` copies `preview/index.html`, MapLibre from `apps/web` and the
outputs into a fresh temporary folder (removed on exit) and serves only that folder on 127.0.0.1 (default port
8765); the Natural Earth comparison files come from `main:design/variants/data/`. Views:
`?view=focus&land=DE-BY&theme=light` (Land focus) and `?view=compare&lon=6.05&lat=50.75&zoom=9` (Natural Earth
outline before against the BKG outline after).

## Cross-border lines for WP-2.2

Natural Earth gives positions only, at 1:10 million. The precise list comes from OSM in WP-2.2: filter the
Germany extract (and the neighbour extracts) to `railway=rail` ways and `route=train|railway` relations, intersect
the ways with the VG250 border (`vg250_li` or the focus outline), and take the line name from the route
relations' `name` and `ref` and the way's `railway:ref`.
