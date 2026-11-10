# ADR-0013: Chevrons hand over to 3D cars by the on-screen width of a car

## Status
Accepted (2026-11-06). Built on `main` with the 3D car layer (WP-5.2).

## Context
The level of detail plan ([architecture](../architecture.md), section 8.2) started the 3D car tier at zoom 14.5.
At that zoom a car body (about 2.9 m wide) is about 1.4 px wide on screen at 52 degrees north. A design review of the
first car layer found that the 20 px chevron in its category colour was replaced by a grey hairline: the roof band
that carries the category colour was below one pixel, so ICE, regional and S-Bahn trains looked the same exactly
where the user zooms in to look closer. The selected train's cars also merged into its route line, so the
selection was no longer distinct (requirement R-14).

A zoom threshold also means a different car size at different latitudes: Web Mercator scales with the cosine of the
latitude, so the same zoom shows a car about 16 % wider at 47.5 degrees north than at 54.5.

## Decision
The hand-over between chevrons and cars depends on how wide a car is on screen, computed at the latitude of the view
centre (`carWidthPx` in `apps/web/src/cars/car-instances.ts`):

| What | Rule |
| --- | --- |
| Car tier opacity | 0 below 3.5 px, 1 from 5.5 px, linear between (`carFade`): about zoom 15.8 to 16.5 at 52 degrees north, 16.0 to 16.6 at 47.5, 15.7 to 16.4 at 54.5 |
| Chevron of a train drawn as cars | gives way by the tier opacity times the train's own blend (`carHandOver` in `apps/web/src/live/live-trains.ts`), so a train is never drawn twice at full opacity |
| Per-train switch | a train changes between chevron and cars over 0.3 s (`CarBlend`), and only once every mesh it needs is loaded; until then it keeps its chevron |
| Selected train | its marker stays until its cars are 5.5 px wide and fades out by 7 px (`markerFade`) |
| Levels of detail | LOD2 below zoom 15.5 (where no cars show today), LOD1 from 15.5, LOD0 at zoom 17 (the map's maximum zoom); one level coarser for a train whose nearest bogie is beyond the half diagonal of the view (`lodFor`) |
| Which trains | at most 300 trains, nearest to the view centre, within 1.15 times the half diagonal plus the train's length (`chooseCarTrains`) |
| Model download | the manifest, palette and meshes are fetched from zoom 15.3 on, retried after a failure from 1 s doubling to 1 min (`loadWithRetry` for the manifest and palette, `retryDelayMs` per mesh), each failure reported once through `warnCars` |

The opacity is a continuous function of zoom and latitude, so the tier cannot flicker at a threshold and needs no
hysteresis.

## Consequences
### Positive
- Cars appear only when their category band can be read; below that, every train keeps its chevron in its category
  colour.
- The same car size triggers the hand-over everywhere in Germany.
- A failed or slow model download costs a delay, never a vanished train.
### Negative
- Cars start later than the plan said (about zoom 16 instead of 14.5): between zoom 12.5 and about 16 trains stay
  chevrons until the track slice tier is built.
- LOD0 shows only at zoom 17, the map's maximum, where a car is about 7.9 px wide top down; it needs a tilted view or
  a higher maximum zoom to be seen in detail.
- The width is computed for a top-down view at the view centre; in a strongly tilted view, trains near the horizon
  are smaller than the rule assumes.
### Alternatives considered
- **Zoom thresholds (14.5, as planned):** cars below one pixel wide, category colour lost, and a size that changes
  with latitude.
- **A minimum screen width for car meshes in the shader:** keeps cars visible at low zoom, but draws them wider than
  the track and other trains, so the true-scale picture is lost.
- **Hysteresis between two zooms:** not needed once the opacity is continuous.

## Date
2026-11-06
