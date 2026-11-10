# @gerlines/live-frame

Binary contracts between the live engine (`services/live`) and the client worker: keyframes, deltas, the head and
shape packs. [FORMAT.md](FORMAT.md) is the specification (version 1.4); this package encodes, decodes and validates
it, in Node and in browsers (no Node or DOM API in `src`).

## Use

```ts
import {
  catchUp,
  decodeKeyframe,
  decodeShapePack,
  shapeIdOf,
  shapePolyline,
  tripStopArcs,
  tripTimes,
} from "@gerlines/live-frame";

const frame = decodeKeyframe(await response.arrayBuffer()); // typed columns, zero-copy where aligned
for (let i = 0; i < frame.trips.count; i++) {
  const key = frame.trips.key[i];
  const shape = shapeIdOf(frame, i); // hash prefix (string) or shape number
  const stops = tripTimes(frame, i, arrival, departure); // absolute Unix seconds
}
const pack = decodeShapePack(bytes);
const polyline = shapePolyline(pack, 0); // { x, y, z?, s } in metres: createShape(polyline) in @gerlines/geo
const arcs = new Float64Array(64);
tripStopArcs(frame, i, polyline.stops, arcs); // plan stop arcs on the same s; throws on a bad firstStop
const next = catchUp(head, state); // keyframe to load (or null) and the deltas to fetch, FORMAT.md section 4
```

- Decoders throw only `FrameDecodeError` with a `code` (`truncated`, `bad_magic`, `unsupported_version`,
  `wrong_kind`, `checksum`, `corrupt`) and never read outside the buffer; every object carries a CRC-32.
- Columns may be views of the input buffer: treat them as read-only. `frameToObject` and `shapePackToObject` give
  plain objects (tests, tools, the train card); the worker should stay on the columns.
- Encoders (`encodeKeyframe`, `encodeDelta`, `encodeHead`, `encodeShapePack`) take the plain objects of
  `src/model.ts`, reject what the format cannot hold with a `RangeError`, and write deterministic bytes.
- Trip rows are grouped by line, then shape; look trips up by key.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm --filter @gerlines/live-frame test` | unit, validation, property (fast-check seed 20261025) and golden tests with coverage |
| `pnpm --filter @gerlines/live-frame vectors` | rewrites `test-vectors/` from `test/vectors.ts` (only for a deliberate format change) |
| `pnpm --filter @gerlines/live-frame sizes [-- --gtfs <dir> --motis-shapes <file>]` | size and decode-time table |
| `pnpm --filter @gerlines/live-frame browser:serve` | serves the browser worker check on `http://127.0.0.1:4317/` |

Browser check: start `browser:serve`, open the page in Chromium (for example `playwright-cli -s=<name> open
http://127.0.0.1:4317/`). A module Web Worker decodes every golden vector, compares it with its JSON, and times
keyframe decoding; the page title ends in `PASS` or `FAIL` and `#result` holds the report. The server strips types
with Node's `stripTypeScriptTypes`, so no bundler is needed.

## Golden vectors

`test-vectors/<name>.bin` with `<name>.json` (`decoder`, then `expected` or `error`, `byteLength`); `index.json`
lists them. They cover every kind, both shape id forms with the shape epoch, fields at the ends of their ranges, a
removal-only delta, sections at odd offsets, a 1.3 keyframe and delta with the vehicle columns (`keyframe-vehicle`,
`delta-vehicle`), a 1.3 keyframe with an unknown section and a 1.2 delta with unknown sections that 1.0 must read, the 1.1 head counts (one head with counts, one with rows of an unknown metric and category that decoders skip),
the head right after a timetable change or a restart (no delta at the keyframe), the 1.4 head with pack sets
(`head-pack-sets`) and the 1.4 compact pack (`shape-pack-compact`, the stub pack in the compact coding), and fifteen
invalid inputs (one per decoder rule family: container, critical section, head gap, head count order, delta base, stop
flags, one-stop plan, shape epoch, pack arc length, compact pack arc length). Another implementation of the format passes when it
decodes each `.bin` to its JSON, also from an odd byte offset, and encodes each valid JSON to its `.bin` (except
`keyframe-unaligned` and the future-version vectors, which encoders do not write).

## Sizes

Measured 2026-10-26 with Node 24.22.1 (`sizes` with the SP-3 pfaedle feed and MOTIS shapes; brotli 11). The shape
pack row was measured again after the M column (section 0x7D) was added; the M column alone is 28.3 KB of it:

| Object | Raw KB | gzip 9 KB | brotli 11 KB |
| --- | --- | --- | --- |
| keyframe, 3,000 real trips, shape numbers | 219.9 | 66.6 | 50.4 |
| keyframe, 3,000 real trips, hash prefixes | 229.6 | 81.0 | 65.6 |
| delta, 3,000 real trips, 10 % changed, numbers | 25.5 | 10.9 | 9.0 |
| keyframe, 15,000 synthetic trips, numbers | 983.2 | 486.7 | 395.8 |
| shape pack, ICE trip of 1,063 km, 14,605 vertices, M, no z | 171.5 | 100.5 | 81.2 |
| same with z (synthetic profile) | 228.6 | 123.6 | 97.6 |

Budget (architecture §11): keyframe about 40 to 60 KB for 3,000 trips, live traffic 150 KB per minute. Decode in
a Chromium worker (HeadlessChrome 155, 2026-10-26): 3,000 trips 1.0 ms, 15,000 trips 4.1 ms (p50).
