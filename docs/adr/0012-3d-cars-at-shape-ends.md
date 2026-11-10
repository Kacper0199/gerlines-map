# ADR-0012: 3D cars at the ends of a shape: whole-train switch now, track stubs later

## Status
Accepted (2026-11-06). Part 1 is built (WP-5.2); part 2 is planned in the shape builder.

## Context
The 3D car layer places every car by its bogie points: each pivot is the shape point at its arc length behind the
train's front, and each car body lies on the chord between its two pivots ([architecture](../architecture.md),
sections 8.1 and 8.4). A shape begins at the first stop of its trip pattern and ends at the last. A train standing at
its first stop has its front at s = 0, so its whole consist lies before the start of the shape, where there is no
track geometry.

The first version of the layer drew such cars on a straight extension of the end segment. That breaks
[ADR-0001](0001-computed-positions-on-matched-track.md): a car could stand off the track. Hiding only the cars whose
pivots lie beyond the end fixed that, but then a train at its origin showed only some of its cars, and the rest
appeared one by one as it left. At Berlin Hbf and Hamburg Hbf 2 to 3 of 7 trains drawn as cars were affected.

## Decision
1. **Now:** a train is drawn as cars only when every bogie pivot of its consist lies on its shape (`onShape` in
   `apps/web/src/cars/car-instances.ts`); otherwise it is drawn as its chevron. No train is drawn in part, and no
   car is placed beyond a shape end. The switch between chevron and cars uses the same 0.3 s per-train blend as the
   zoom hand-over ([ADR-0013](0013-3d-car-hand-over-by-screen-width.md)).
2. **Later, in the shape builder:** extend each shape before its first stop and after its last along the matched
   OpenStreetMap track, by at most the length of the longest consist (about 400 m), so a train standing at a
   terminus has track under every car. The stub belongs to the shape geometry, so it needs a new shape epoch and
   new packs, and the stop arc positions move by the length of the leading stub.

## Consequences
### Positive
- A car is never drawn off the track, and a train is never drawn in pieces.
- Part 1 needs no change to the pipelines, the packs or the frame format.
### Negative
- Until part 2, a train standing at its first stop is a chevron among cars at close zoom, and it changes to cars
  only once its whole length has left the start of the shape. How this reads on departure is open to design review.
  Measured on one recorded hour (data/live/t138/r1 with packs-t116, epoch 4, which has no stubs; 16 keyframes, 44,088
  drawn trains): 6,818 (15 %) were chevrons only because of this rule, 83 % of them with the front at s = 0 (waiting
  for departure), the rest within one consist length of the start. A 202 m ICE 4 stays a chevron for its whole dwell
  and about 200 m of running. The reviewer's black ICE and blue RE at Essen Hbf (T148-M-1) are such trains, and the
  S-Bahn units beside them were on the way. `buildCars` has a test for it (`live-trains.test.ts`).
- Part 2 adds work to the shape builder: the stub must follow the track the train actually stands on, which at a
  terminus with many platform tracks needs the platform track choice of the stop.
### Alternatives considered
- **Straight extension of the end segment:** rejected by ADR-0001; at a curved station throat it puts cars beside
  the track.
- **Hide only the cars beyond the end:** the train is drawn in pieces and grows car by car as it departs.
- **Clamp the pivots to s = 0:** stacks the cars on one point.
- **Shift the train forward until its tail is at s = 0:** draws the train ahead of its stop, a wrong position.

## Date
2026-11-06
