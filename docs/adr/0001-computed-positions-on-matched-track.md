# ADR-0001: Train positions are computed along matched track, not received

## Status
Accepted (2026-10-23)

## Context
R-04 asks for smooth motion that never leaves the rails. Research on 2026-10-23 decoded every open German realtime
feed (DELFI GTFS-RT, gtfs.de, VBB, VBN): none carries vehicle positions. geOps and Transitous compute positions
from timetable plus delay. The reference site test.offentligdata.com shows the failure mode of the alternative:
straight lerps between fixes, dead reckoning on a heading, a 1200 m jump threshold, headings from GPS noise.

## Decision
Every trip pattern gets a shape matched to OSM rail with cumulative distance and baked elevation. The server sends
motion plans (stop arc positions, predicted times, flags). The client evaluates them in 1D arc length with a
trapezoidal speed profile per leg and a bounded, never-backwards catch-up; large corrections crossfade. Cars are
placed by their bogie points. Measured fixes, where a foreign feed has them, are projected onto the shape and
filtered (alpha-beta) into the plan.

## Consequences
### Positive
- Off-track positions are impossible by construction; updates blend without jumps.
- Works with every source that has a timetable, including timetable-only trips.
### Negative
- Trains held between stations look like they move until the next prediction arrives; the card must show
  provenance (live prediction, estimated, timetable only) and data age.
- Requires a shape pipeline with a quality gate.
### Alternatives considered
- **Server-side trajectories like geOps**: equivalent truth, more bandwidth; our motion plans carry the same
  information more compactly.
- **Constant speed between stops (Transitous RailViz)**: simpler but visibly wrong near stations.
- **Straight-line interpolation of fixes (offentligdata)**: rejected, causes every artefact the user reported.

## Date
2026-10-23
