# @gerlines/trainforge

Generates lightweight glTF models of German train series from [`catalog/vehicles.yaml`](../../catalog/vehicles.yaml)
and the liveries in [`catalog/liveries.yaml`](../../catalog/liveries.yaml). Work package WP-5.1; placement on the
track is WP-5.2 (architecture §8.1 and §8.2).

## Commands

| Command | What it does |
| --- | --- |
| `pnpm --filter @gerlines/trainforge build` | writes `dist/` (git-ignored): every model, `manifest.json`, `palette.png`, `report.md`; exits 1 when a car is over budget |
| `node src/cli.ts build --out <dir> [--only id,id] [--catalog <dir>]` | the same with options |
| `pnpm --filter @gerlines/trainforge test` | geometry, palette, consist, determinism, budget, extras and bounding-box property tests |
| `pnpm --filter @gerlines/trainforge preview` | Vite page on 127.0.0.1 that serves `dist/`; run `build` first |

Preview parameters: `?model=<model_id>&view=overview|photo|nose|side|top|match|exact&lods=0,1,2&theme=dark|light`.
The page sets `body[data-ready]` when every car is placed. For fitting against photos:

| Parameter | What it does |
| --- | --- |
| `view=match&cam=x,y,z&look=x,y,z&fov=<deg>&roll=<deg>` | camera matched to a photo, in the leading car's frame (x forward, y left, z up, metres); set the viewport to the photo's aspect and `fov = 2 atan(H / 2f)` |
| `view=exact&cp=x,y,z&ct=x,y,z&fov=<deg>[&end=rear]` | camera position and target relative to the nose tip on the track (world axes, mirrored for `end=rear`) |
| `straight=1` | straight track instead of the 260 m curve |
| `ortho=side\|front\|top&scale=<px per m>&c=x,y,z[&sil=1]` | orthographic render centred at `c` from the nose; `sil=1` draws white silhouettes on black without track |

## Output

- `models/<model_id>/<car_type>.lod<N>.glb`: one car body per file, one mesh, one primitive, one material with
  the model's palette row as a 64 × 4 px PNG (nearest filtering).
- `models/<model_id>/bogie-<wheelbase mm>-<wheel mm>.lod<N>.glb`: one bogie centred on its pivot, drawn once per
  pivot of the consist, so a Jacobs bogie appears once.
- glTF axes: +x forward, +y up, +z right, metres, origin at the car centre on top of rail. Positions stay
  float32 without a node transform; normals and UVs are quantized (KHR_mesh_quantization) and everything is
  compressed with EXT_meshopt_compression.
- Node extras `gerlines`: model, series, car type, role, level of detail, length, width, height, floor,
  bogie pivots (`xM` forward of the centre, `kind` own or jacobs), Jacobs flag, livery, palette layout,
  estimated fields and sources.
- `manifest.json`: per model the formation, the consist in the form of `@gerlines/geo` (`bogieOffsets` from
  the front, per car its front and rear pivot and `centreFraction`) and per car type its files, triangles and
  bytes.
- `palette.png`: the shared atlas, one 4 px row per livery (neutral rows per category first), one 4 px column
  per slot (`body`, `upper_body`, `lower_body`, `window_band`, `stripe`, `doors`, `accent`, `window`, `roof`,
  `underframe`, `bogie`, `gangway`, `light`, `reveal`, `mode`, `skirt`, `mask`, `equipment`, `housing`, `glass`,
  `sheen`, `display`, `tail`, `logo`; new slots are appended so existing columns keep their place). A model's own UVs sample
  row 0 at v = 0.5; a renderer
  that shares the atlas maps v to `(row + 0.5) / rows`.
- Livery roles (migration 0056): `roof` paints the roof beside the mode band, `skirt` the band below a front's
  `skirt_top_m` along the body (and below `front_skirt_top_m` on the nose when that is set; `front_skirt_top_m`
  alone paints the skirt on the nose only; a car with its own front keeps its own skirt line or none, cars without
  one take the unit's), `mask` the painted
  helmet or mask (the `equipment` slot that fronts name with `mask_slot: equipment`, and the roof boxes). The
  `mask` slot itself stays the neutral dark surround of glass, lamps and pillars.

## Geometry

Each car is lofted from a cross-section (roof shoulder, straight side wall, tucked lower edge). Side walls are
split into columns at every door, window and body-zone edge; windows and doors are recessed panels with
reveals at LOD0 and flush panels at LOD1, windows merge into one band at LOD2. Cab fronts are lofted nose
presets (`streamlined`, `wedge`, `rounded`, `blunt`, `cab_car`, `locomotive`) closed by a cap. Two opt-in
measured profiles replace the tip, face and windscreen knots (a front takes one of them):
`side_profile` is the nose centreline as [setback, height] points from the tip (setback 0) up to the roof,
every point a ring row at full detail and every 8th at band detail (Velaro D, ICE 3neo, generic hsr);
`profile_by_height` is the centreline as [height, setback] points, closed by the forge at the roof at the
front's length, its points below the tip rows of the lower nose at full detail only (ICE 4, ICE T, ICE 1, IC2
cab). With them a front may give `plan_widths` ([setback, fraction of the half width], the same plan at every
height, set back with the profile), `tip_gap_m` (end over couplers to the tip) and `stripe_curve` ([setback,
bottom, top] of the stripe down the nose side, drawn instead of the dive); a car may give `body_bottom_m`, the
underside of the body side along the whole car (skirts over the bogies), `bogie_skirt_m`, the bottom of the side skirt over the bogies only (kept clear of the wheels, ICE T), and `side_panels_m`
([from, to, bottom, top] along the car from its centre, forward positive) grilles or louvres recessed into
both side walls in the mask colour at LOD0 and LOD1 (ICE 1 power head). Low-floor and
double-deck cars get raised body zones over the bogies. At LOD0 a front may carry `cheeks`: lobes either side of
a recessed coupler opening (the Mireo), reaching forward by `reach_m` between `inner` and `outer` and drawing
the middle back by `recess_m`. With `screen_columns` the pane windscreen and its frame are laid out
in columns spaced along their outline instead of rows that fan to a point at top and bottom, for a
screen wrapped over a dome (ICE T); `screen_tone: light` draws the windscreen grey-blue with a lighter upper
part instead of near black (regional fronts); `cab_glass_curve` ([setback, bottom, top]) lays the cab side
window's own glass over the front of a `band_curve` (Velaro D), and `band_from_curve_start` lets the band run forward to its curve's first setback instead of stopping beside the windscreen (ICE T, whose cab glazing sweeps into the nose); `lettering` (`text` from the glyphs I, C, E, `from_m` and `to_m` setbacks, `bottom_m`, `top_m`, `italic`, optional `stripe_gap_m`) writes the grey ICE logotype along both sides of the nose or the cab side behind it at full detail, read from outside on each side, and leaves the `stripe_curve` out between the gap's setbacks (Velaro D, ICE 3neo, ICE 2). With `plain_cab_side` the cab side behind the nose keeps the body colour between sill and window top up to the foremost passenger window instead of the dark window band (ICE 2 driving trailer). Front decals are panes just off the nose at LOD0, each lifted one
step above the panes it overlaps; over an apron they leave out what lies below the visible skin. A
mirrored `light` decal is a lamp: a dark housing with round lenses, a strip, or with `fill` a white
and a red lens filling it. The outermost lamp carries a red tail lens unless a lamp states `tail`
(its red share, 0 to 1) and `tail_side` (`outer`, `inner`, or `below` for a small white lens above a larger red
one); `tail_mode: combined` marks a lamp whose white lens itself shows red at the trailing end (ICE 3, ICE 3neo, ICE T: one LED or bulb cluster for both, no separate red lens in daylight): its lenses sample the light cell off centre (`COMBINED_TAIL_U`), the same colour, so a renderer can tell them apart; `lens_margin_m` sets the gap between a cluster lamp's housing and its lenses (0 fills it edge to edge; on a
white body a dark edge of at most 0.015 m round a white lens is allowed, D-053, and the high speed fronts use
0.012); `tilt_deg` turns a decal so its outer end rises; `clear_lens: inner|outer` draws that lens of a lamp's pair as a clear unlit lens (`glass`), the other one lit (440). A `logo: true` decal is the DB plate: a plate in the
decal's slot (border and letters), a red field inside it and the letters D and B as blocks with red counters,
sized by the decal's height and half width; the field and counters sample the `logo` cell, not `tail`, so the plate
never lights as a tail lamp. With `logo_red_letters` the border and letters are red and the slot paints the field (the
logo on a light body, 422). The forge draws the plate on a model whose livery names an operator of the DB group
(`src/logo.ts`: Deutsche Bahn, Q9322 on Wikidata, and every `operators.yaml` row whose `parents` reach it), and on a
model whose series a livery of a DB operator names (a neutral model of a series DB runs in its own row); the
neutral row and every other operator's row hide the plate's cells (`palette.logoRows`), and a model of neither kind
draws no plate. A `seam: true` decal is a panel joint (the coupler cover outline of the ICE 2 and ICE 3neo):
drawn only 6 mm off the skin (`SEAM_LIFT`) under every other pane, with rows and columns every 4 cm, so a hairline
seen at a grazing angle stays inside the body outline; it takes no layer, so it never lifts a later pane. Every
value comes from `vehicles.yaml`; where it has
none, a stylisation default in `src/spec.ts` applies and the field is listed as estimated.

A series that is the same vehicle type as a series the forge already draws (a class number of the same
variant, or the family name) gets its own model row whose `formation` and `car_types` are YAML aliases of
that model's rows: the geometry is byte for byte the same, the series and the livery are its own (the
neutral row when its operators run different liveries).

Budgets per car (body plus two bogies): LOD0 6,000 triangles, LOD1 1,200, LOD2 300 (`CAR_BUDGET` in
`src/geometry/lod.ts`). The build is deterministic: the same catalogue gives the same bytes.

## Fit harness

`scripts/fit/` measures a model's nose against digitised photo outlines (WP-5.1). Python runs through
`uv run --with opencv-python-headless,numpy,pyyaml` (`numpy,pillow` for `fit_preview.py`); reference images and
outlines with image coordinates stay in `raw/references/wp-5.1/` (git-ignored), only derived values go to the
catalogue with their source.

| Script | Input | What it reports |
| --- | --- | --- |
| `dump-body.ts <model_id> <car_type> <lod> <out.json> [catalog]` | the catalogue (no build needed) | one body as triangles with their palette slot, car frame x forward, y left, z up |
| `fit_body.py <body.json> <refs.yaml>` | `dump-body.ts` output, a refs file with `ortho: {side, front, top}` outlines in metres | per view IoU and the largest deviation over the first 8 m, underframe left out; also a pinhole `Camera` (focal length, centre, position, target, roll), a flat-shaded painter's render and `photo_mask` from `silhouette_px` for camera-matched comparisons in image space |
| `dump-glb.ts <body.glb> <out.f32>` | a built body GLB (what ships) | its triangles as float32 |
| `fit_glb.py <tris.f32> <outline.yaml> [--out prefix] [--json file] [--label text]` | `dump-glb.ts` output, `raw/references/wp-5.1/<family>/outline.yaml` (side `upper` and `lower`, front and top `half_widths`, `region_m`, `side_exclude` boxes for bogies, roof equipment and couplers, `tip_z_min_m` to take the tip above buffers) | per view IoU, largest and p95 deviation and where the worst point lies, at 1 cm per pixel; overlay PNGs with `--out` |
| `fit_preview.py <outline.json>` | the running preview (`FIT_PORT`, default 5813), a Playwright session (`FIT_SESSION`, default `fit`), an outline in `scripts/fit/outlines/` (roof line `top`, front edge `front`, window `zmin` and `xmax`, optional `body_floor`) | side IoU and the largest distance between our roof and front edge and the photo's, from a `straight=1&ortho=side&sil=1` screenshot at 200 px per m; overlay in `FIT_OUT` |

```
node scripts/fit/dump-glb.ts dist/models/db-412-7/end.lod0.glb /tmp/end.f32
uv run --with opencv-python-headless,numpy,pyyaml python scripts/fit/fit_glb.py /tmp/end.f32 \
  ../../raw/references/wp-5.1/db-412/outline.yaml --out /tmp/fit
node scripts/fit/dump-body.ts db-407 end 0 /tmp/407.json
uv run --with opencv-python-headless,numpy,pyyaml python scripts/fit/fit_body.py /tmp/407.json refs.yaml
```

Photo ghosts without EXIF: `photo_camera.py '<json pose>'` turns a hand estimate (distance from the pixels per
metre of the car height, off-axis angle from the front to side ratio, nose column, camera height, focal length in
pixels) into `view=exact` parameters (`cp`, `ct`, `fov`); render at the photo's pixel size and blend with
`photo_ghost.py <photo> <render> <out>` (`uv run --with pillow`). One or two corrections from the blend were
enough; this is a hand fit, not a solved camera.

Pitfalls: `cv2.fillPoly` with a list of overlapping polygons cancels the overlaps, so fill one polygon per call;
the painter's render is for silhouettes only (decals z-fight), take ghost overlays from a preview screenshot at
`view=match`; a front photo's glass heights move the side profile too (the profile runs through them), so set
setbacks and glass heights together.

## Pitfalls

- Vite reads `dist/` at start: restart the preview after a build adds files. File changes reach it through
  polling (`server.watch.usePolling`), because file events do not arrive inside some sandboxes.
- `quantize()` of positions would add a node transform that deck.gl's SimpleMeshLayer ignores, so positions
  are left in float32.
