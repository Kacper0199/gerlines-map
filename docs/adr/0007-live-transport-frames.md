# ADR-0007: Live data as immutable binary frames through a CDN, with push notices

## Status
Accepted (2026-10-23)

## Context
The reference site polls a viewport API every 15 s and freezes for about a second on each poll. geOps pushes
trajectories over a WebSocket per bounding box. Our concurrency is modest (about 2,100 simultaneous clients at
100,000 daily users) but should cost little to serve.

## Decision
`services/live` publishes a keyframe of all motion plans every 30 s and deltas every 2 to 5 s as immutable binary
objects plus a tiny `head` with a one-second cache. Clients fetch them through the CDN and learn about new frames
from a Centrifugo notice, falling back to polling `head`. Per-train channels carry detail for the open card.
Decoding and motion evaluation run in a Web Worker; no main-thread work over 50 ms per update.

## Consequences
### Positive
- Origin load does not grow with users; clients can animate for minutes between messages.
### Negative
- A custom binary format to version and test (golden vectors in `packages/live-frame`).
- Cloudflare caching of short-lived objects needs a spike before launch.
### Alternatives considered
- **Per-client WebSocket streams of positions**: origin load grows with users.
- **Viewport polling of JSON**: the reference site's stalls.

## Date
2026-10-23
