# GerLines live frame format, version 1.4

The binary contracts between the live engine (`services/live`, WP-3.2) and the client worker (WP-3.3): keyframes,
deltas, the head, and shape packs. `packages/live-frame` implements this document; the golden vectors in
`test-vectors/` are normative examples. Architecture §7 and §8.1 and ADR-0007 give the context.

## 1. Conventions

- Every number is little-endian. Integers are unsigned unless named `i16` or `i32`; `f32` is IEEE 754 binary32.
- Times are whole seconds. Absolute times are Unix seconds (UTC); a frame stores them relative to its `timeBase`.
- Map positions are EPSG:3857 Web Mercator. In shape packs they are integer centimetres.
- Arc lengths `s` are flat ground metres on the WGS84 ellipsoid along the shape from 0 at its first vertex (the M
  value of WP-2.2's `shape_pattern`, which ignores elevation), stored as integer centimetres (`u32`, up to
  42,949 km). Every arc position in this format (vertex M, stops, tunnels, explicit stop positions) is in this one
  arc length.
- A **column** is one array of one element type. Columns of one **table** have the same length (one element per row).
  This struct-of-arrays layout keeps columns contiguous for zero-copy typed-array views and compresses well.
- Each column is one **section**. Encoders start every section at an offset that is a multiple of 8 and fill gaps with
  zero bytes, so a decoder can view a column in place when the whole buffer starts at an aligned address.

## 2. Container

Every object (keyframe, delta, head, shape pack) is one container: a header, a section directory, then the sections.

### 2.1 Header (40 bytes in 1.0)

| Offset | Type | Field | Meaning |
| --- | --- | --- | --- |
| 0 | 4 bytes | magic | ASCII `GLFR` (0x47 0x4C 0x46 0x52) |
| 4 | u8 | versionMajor | 1 |
| 5 | u8 | versionMinor | 0 to 4: the lowest minor that holds the object's content (section 6) |
| 6 | u8 | kind | 1 keyframe, 2 delta, 3 head, 4 shape pack |
| 7 | u8 | headerFlags | 0 in 1.0; unknown bits are ignored |
| 8 | u16 | headerLength | bytes from offset 0 to the section directory; 40 in 1.0, a multiple of 8 |
| 10 | u16 | sectionCount | entries in the section directory |
| 12 | u32 | totalLength | bytes of the whole object; must equal the buffer length |
| 16 | u32 | crc32 | CRC-32 (ISO-HDLC, the zlib and PNG CRC) of the whole object with these 4 bytes read as 0 |
| 20 | u32 | sequence | frame sequence (section 3); 0 in shape packs |
| 24 | u32 | baseSequence | for a delta, the sequence it applies to (`sequence − 1`); 0 otherwise |
| 28 | u32 | timetableVersion | the static feed version (`feed_version.id`) the trips and shapes belong to |
| 32 | u32 | timeBase | Unix seconds; trip times are relative to it; the publication time of a frame, 0 in shape packs |
| 36 | u32 | shapeEpoch | the shape number registry (section 3.4): 0 when the object names shapes by hash prefix or holds no shape numbers, else the registry's epoch, at least 1; 0 in a head |

### 2.2 Section directory

`sectionCount` entries of 12 bytes from `headerLength`:

| Offset | Type | Field |
| --- | --- | --- |
| 0 | u16 | id |
| 2 | u16 | flags: bit 0 critical (a decoder that does not know the id must reject the object) |
| 4 | u32 | offset from the start of the object |
| 8 | u32 | length in bytes, a multiple of the element size |

Sections lie after the directory and inside `totalLength`, do not overlap and appear in the directory at most once
per id. Their order is free; encoders write them in ascending id order.

### 2.3 Decoding rules

A decoder rejects an object with a typed error (`FrameDecodeError` with a `code`) and reads nothing outside the
buffer. It checks in this order: magic, header and total length, CRC-32, major version, header length, kind, then
the directory and the content. The CRC comes before every other header field, so a damaged byte anywhere reports
`checksum`; bytes 0 to 19 (magic to crc32) keep their place and meaning in every major version for this reason.

| Code | When |
| --- | --- |
| `truncated` | the buffer is shorter than the header, than `headerLength` plus the directory, or than `totalLength` |
| `bad_magic` | the magic differs |
| `unsupported_version` | `versionMajor` is not 1, or a critical section id is unknown |
| `wrong_kind` | the kind is unknown, or not the kind the caller asked for |
| `checksum` | the CRC-32 differs |
| `corrupt` | anything else: the buffer is longer than `totalLength`, a section out of bounds, overlapping or repeated, a length that is not a multiple of the element size, a missing required section, columns of one table with different lengths, or a value that breaks a rule of section 3 or 5 |

## 3. Keyframe and delta (kinds 1 and 2)

The live engine numbers its states with one `sequence` that starts at 1 and grows by 1 per state. Rules:

- A **delta** at `s` turns the state at `s − 1` into the state at `s`: `baseSequence = s − 1`, so `s ≥ 2`. It carries
  every trip whose plan changed or that is new (the whole plan, not a patch) and the keys of trips that ended or
  disappeared. Encoders and decoders reject any other `baseSequence`.
- Every state after the first has a delta. A **keyframe** at `k` holds the motion plan of every running and
  soon-starting trip in state `k`: the state after delta `k`, so deltas `k + 1`, `k + 2` and on apply to it. Encoders
  and decoders reject a keyframe at sequence 0.
- `timetableVersion` is the static feed version of the frame's state. When it changes, the live engine starts the new
  version with a keyframe `k`, publishes no delta `k` across the change, and keeps no older delta (the head's `oldest`
  becomes `k + 1`). Trips running at the change are **carried over**: they keep their key and their plan and appear in
  keyframe `k` and the frames after it under the new version, although their trip and shape come from the old
  version's timetable (a shape id names content, not a version, section 3.4). New trips enter from the new version.
- **Restart.** After a restart the live engine continues the published chain when it can read it back (the latest
  keyframe and the deltas after it). Otherwise it starts with a keyframe `k` without a delta `k`, as at a timetable
  change (head `oldest = k + 1`), and with sequences above every sequence it may have published before: sequences
  never go back, also across restarts and the loss of published objects.
- Trip keys are never reused. A client that loads a keyframe (after a gap, a timetable change or a restart) keeps the
  trips it already draws by key and only updates their plans, so a carried-over trip does not fade out and back in.
- A client applies a delta only when its `baseSequence` and `timetableVersion` equal those of the state it holds
  (`appliesTo`). It drops any other frame, reads the head again and follows section 4 (`catchUp`); a keyframe whose
  `timetableVersion` differs from the head that named it is dropped the same way.

A keyframe and a delta share the trip, stop, shape and string tables. A delta adds the removal table.

### 3.1 Trip table (one row per trip, keys unique)

Encoders order rows by line name (rows without a line last), then shape, then key, comparing strings by UTF-16
code units: trips of one line and pattern sit together, so their repeated run times compress well (measured: 13 %
smaller with brotli than key order). Decoders accept any order and look trips up by key.

| Id | Column | Type | Meaning |
| --- | --- | --- | --- |
| 0x10 | key | u32 | stable trip key assigned by the live engine, unique per running trip instance and kept for its lifetime |
| 0x11 | shape | u16 | row in the shape table |
| 0x12 | category | u8 | 0 unknown, 1 `hsr`, 2 `ld`, 3 `night`, 4 `rfast`, 5 `reg`, 6 `sbahn`, 7 `urban`, 8 `bus` (architecture §9); a decoder reads codes it does not know as 0 |
| 0x13 | flags | u8 | bit 0 realtime (else timetable only), bit 1 cancelled, bit 2 foreign, bit 3 explicit stop arc positions; other bits 0 and ignored |
| 0x14 | delay | i16 | current delay in seconds; −32768 means unknown |
| 0x15 | firstStop | u16 | index of the trip's first plan stop in the shape's stop list |
| 0x16 | stopCount | u16 | plan stops of this trip, at least 2 |
| 0x17 | start | i32 | arrival time of the first plan stop, seconds relative to `timeBase` |
| 0x18 | line | u16 | row in the string table with the line name (`ICE 379` has line `ICE`, `RE 1` has `RE 1`); 65535 none |
| 0x19 | trainNumber | u32 | train number; 0 none |

### 3.1.1 Vehicle columns (1.3)

| Id | Column | Type | Meaning |
| --- | --- | --- | --- |
| 0x1C | series | u16 | row in the string table with the catalogue series id of the trip's vehicle identity (`db-412`; ADR-0011 layers L0 to L3); 65535 none |
| 0x1D | operator | u16 | row in the string table with the catalogue operator id (`db-regio-ag-nrw`); 65535 none |
| 0x1E | units | u8 | coupled units of that series (double traction is 2); 0 unknown |

Optional and not critical: an encoder writes all three or none, the three when at least one trip of the frame names
its vehicle (unknown included), and such a frame is written as version 1.3; a frame without them stays 1.0 byte for
byte. A 1.0 to 1.2 decoder skips them and reads the same trips (`test/vehicle.test.ts` reads both 1.3 vectors with
the frozen 1.2 decoder of `test/decoder-1.2/`). A 1.3 decoder rejects (`corrupt`) a frame with some but not all
three, a column of another length than the trip table, or a series or operator row outside the string table, and
gives every trip of a frame with them its series, operator and units (null when none). A trip without a series is
drawn with the generic model of its category (layer L4 or no rule); the client chooses the model of a series
(architecture §8.4). Series and operator strings share the string table with the line names, so a frame names each
once.

### 3.2 Stop table (one row per plan stop)

Rows hold the stops of trip 0, then trip 1 and so on, `stopCount` rows per trip; the table length is the sum of
`stopCount`. A trip's plan holds the stops from the last one it departed (or its origin, before departure) to its
destination: stops behind the train are left out. A plan has at least two stops (the motion kernel needs a leg); a
train that reached its destination stays in the frame for 30 s after its last arrival (the publisher's end grace, so
the client sees it stop), then it is removed. Stop `j` of a trip is stop `firstStop + j` of its shape, unless
flag bit 3 is set. The decoder of a frame cannot see the shape pack, so the client checks
`firstStop + stopCount ≤ stopCount` of the shape (section 5.1) when it joins the two, and treats a trip that fails it
as corrupt (`tripStopArcs` does this).

| Id | Column | Type | Meaning |
| --- | --- | --- | --- |
| 0x20 | run | u16 | seconds from the previous stop's departure to this stop's arrival; 0 for the first stop of a trip |
| 0x21 | dwell | u16 | seconds from this stop's arrival to its departure |
| 0x22 | flags | u8 | bit 0 arrival unknown, bit 1 departure unknown, bit 2 cancelled (the train passes without stopping), bit 3 realtime prediction; other bits 0 and ignored |

Times follow from the columns: `arrival(0) = timeBase + start`, `departure(j) = arrival(j) + dwell(j)`,
`arrival(j) = departure(j − 1) + run(j)`. A stop with an unknown arrival stores its departure as arrival (dwell 0);
one with an unknown departure stores its arrival as departure; one of the two is always known. So a stop with bit 0
or bit 1 has dwell 0, and bits 0 and 1 are never both set; a decoder rejects either as `corrupt`. Times never go
back: an encoder rejects a plan whose times decrease, and the live engine repairs such predictions first.

A stop with flags 0 is a halt, not always a passenger stop: a stop without boarding and alighting in the timetable
that has a scheduled dwell (a reversal, a crew change) is sent as a plain stop, so the train halts there; one
without a dwell is sent with bit 2 and the train passes. Whether passengers board at a stop comes from the train
detail (its pickup and drop-off), not from the frame.

### 3.3 Explicit stop arc positions

| Id | Column | Type | Meaning |
| --- | --- | --- | --- |
| 0x23 | arc | u32 | arc position in centimetres of each stop of every trip with flag bit 3, in stop table order |

Its length is the sum of `stopCount` over trips with flag bit 3 (usually 0). Such a trip has stops that its shape's
stop list does not hold (an added stop): the plan stops are at these positions, and `firstStop` is informative only.
Positions do not decrease within a trip.

### 3.4 Shape table

A frame names its shapes in one of two forms; exactly one of the two sections is present:

| Id | Column | Type | Meaning |
| --- | --- | --- | --- |
| 0x30 | hash prefix | 8 bytes | the first 8 bytes of the shape's 32-byte content hash (section 5) |
| 0x31 | number | u32 | the shape's stable number: assigned once per distinct shape and never reused, so it names the same content hash for good |

Rows in order of first use by the trips; each id appears once; at most 65,536 rows. A client fetches the shape pack
for an id it lacks.

`shapeEpoch` in the header chooses the form: 0x30 when it is 0, 0x31 when it is at least 1, also in a frame without
trips. Encoders and decoders reject any other combination. Shape numbers come from WP-2.2's registry, an identity
column that is never reset or reused (no `RESTART IDENTITY`, no rebuild into a fresh sequence); if the registry is
ever rebuilt or a second environment publishes its own numbers, the epoch changes. A number therefore names one
content hash only together with its epoch: a client keys cached shape packs by (epoch, number), and when a frame
carries an epoch other than that of its cached packs it fetches the packs again. Shape pack paths include the epoch (section 7). Hash prefixes need nothing beyond the content hash; numbers need a registry that never reuses a
number, but cost 4 instead of 8 incompressible bytes per shape (measured: a keyframe of 3,000 real trips is 50 KB
with numbers against 66 KB with hash prefixes, brotli 11).

### 3.5 String table

| Id | Column | Type | Meaning |
| --- | --- | --- | --- |
| 0x40 | offsets | u32 | `count + 1` byte offsets into 0x41, starting at 0, never decreasing, the last equal to the length of 0x41 |
| 0x41 | bytes | u8 | UTF-8 text of all strings, back to back |

Strings appear once each, in order of first use. Invalid UTF-8 is `corrupt`.

### 3.6 Removal table (delta only)

| Id | Column | Type | Meaning |
| --- | --- | --- | --- |
| 0x50 | removed | u32 | keys of trips to drop, ascending, unique, none of them in the delta's trip table |

All sections of 3.1, 3.2, 3.3 and 3.5 and one section of 3.4 are required in both kinds (a table may be empty); 0x50
is required in a delta.

## 4. Head (kind 3)

`sequence` is the newest state, `timeBase` the publication time of the head, `timetableVersion` that of the newest
state.

| Id | Column | Type | Meaning |
| --- | --- | --- | --- |
| 0x60 | head | u32 × 3 | latest keyframe sequence, latest frame sequence, oldest delta sequence still published |

Rules, enforced by `encodeHead` and `decodeHead`: `latest = sequence`, `1 ≤ keyframe ≤ latest` and
`2 ≤ oldest ≤ keyframe + 1`. Deltas `oldest` to `latest` are published, so a path always leads from the keyframe to
the newest state; `oldest = latest + 1` means no delta is kept (right after the first keyframe or a timetable change).

A client at state `n` of the same `timetableVersion` with `n ≤ latest` and `oldest ≤ n + 1` fetches deltas `n + 1` to
`latest` (none when `n = latest`). Otherwise (no state, a gap, a state newer than the head after a restart, another
timetable) it loads keyframe `keyframe`, then deltas `keyframe + 1` to `latest`. `catchUp(head, state)` returns this
plan. Paths and caching: section 7.

### 4.1 Head counts (1.1)

| Id | Column | Type | Meaning |
| --- | --- | --- | --- |
| 0x61 | counts | u32 × 2 | (code, count) rows of legend counts for the newest state, codes strictly ascending |

Optional and not critical: a 1.0 decoder skips it, and a head that carries it is written as version 1.1 (a head
without it stays 1.0, byte for byte). A code is `metric × 256 + category`: the category byte is a category code of
section 3.1, or 255 for every category together. Metrics:

| Metric | Name | Count |
| --- | --- | --- |
| 1 | running | trips in the state (drawn), which includes trains standing at their origin from 10 minutes before the first departure and at their destination for 30 s after the last arrival |
| 2 | untracked | trips running now that the state leaves out because their pattern has no usable track geometry (a `low_quality` or `unmeasured` shape, no shape, or an added trip that fits no pattern), from the first scheduled departure to the expected last arrival (realtime when known, so a late train stays counted); the legend note "{count} trains without track geometry are not shown" |
| 3 | cancelled | trips cancelled as a whole that would be running now by the timetable; left out of the state |
| 4 | realtime | trips in the state with the realtime flag |

The live engine writes the four totals (category 255) in every head, zero included, and a per-category row only when
its count is above zero. Decoders reject rows that are not pairs or not in ascending code order (`corrupt`) and skip
rows whose metric or category they do not know.

### 4.2 Pack sets (1.4)

| Id | Column | Type | Meaning |
| --- | --- | --- | --- |
| 0x62 | packSets | u32 × 4 | shape epoch (at least 1), latest set id, first set id of the increment chain, parts of the latest base set (1 to 64) |

Optional and not critical: a head that carries it is written as version 1.4, and older decoders skip it. A **pack set**
bundles the shapes the frames name in one window of 600 s: set `id` covers `[id × 600, (id + 1) × 600)` Unix seconds.
The live engine builds set `id` 120 s before its window starts, from the gated single packs of the epoch (section 7),
and names it in the head only after every file of it is written:

- the **base set** `id`: every shape the frames name from the build until the window ends (the trips of the state and
  the runs the engine admits before the end), in `parts` packs at `sets/<epoch>/b/<id>/<k>.bin`, `k` from 0, each
  holding nearby shapes (ordered by a Morton key of the middle vertex, about 150,000 vertices a part);
- the **increment** `id`: the shapes of base `id` that base `id − 1` lacks, one pack at `sets/<epoch>/i/<id>.bin`.

Every part is a shape pack of section 5 with shape numbers and the compact coding (5.4); part 0 and the increment
carry the window's shapes without a pack (5.5). Base `latest` and the increments of every id in `(first, latest]`
are published; older ones are deleted (the engine keeps six). `encodeHead` refuses an epoch of 0, `first` above
`latest` or parts outside 1 to 64. Because the section is optional, `decodeHead` never rejects a head for it: it
ignores values after the fourth (a later minor may add some) and reads a section shorter than four values or with
values out of range as no pack sets.

A client follows `packSetPlan(head, held)`: nothing while it holds `latest` or the head names no sets; the increments
`held + 1` to `latest` while `first ≤ held` and it is at most six behind; else the parts of base `latest`, one after
the other, so the trains of the first part are drawn while the rest arrive. It ignores sets of another epoch than its
frames, decodes a part shape by shape in slices of at most 8,000 vertices (`openShapePack`), holds its single pack
fetches while sets load except the selected train's shape and, once a part takes over 8 s, two at a time, and fetches
single packs for what the sets lack. Every read has a deadline (head 10 s, frames and sets 30 s, single packs 20 s). A
base read only in part counts as held, so the next increment and single packs fill the rest. Sets change no
shape: a shape decodes from a set to the same values as from its single pack (`test/compact.test.ts`, and on the
1,712 shapes of a national keyframe).

## 5. Shape pack (kind 4)

One pack holds one or more shapes (a `shape_pattern` of WP-2.2: geometry, stop arc positions, tunnels). Shapes are
immutable and addressed by their content hash, so a pack can be cached for good.

### 5.1 Shape table (one row per shape)

| Id | Column | Type | Meaning |
| --- | --- | --- | --- |
| 0x70 | hash | 32 bytes | content hash of the shape (as WP-2.2 stores it); its first 8 bytes are the shape id of section 3.4 |
| 0x71 | vertexCount | u32 | vertices, at least 2 |
| 0x72 | stopCount | u32 | stops on the shape |
| 0x73 | tunnelCount | u32 | tunnel spans |
| 0x74 | length | u32 | arc length of the last vertex in centimetres (the sum of the shape's 0x7D values) |
| 0x75 | flags | u8 | bit 0 has elevation; other bits 0 and ignored |
| 0x76 | number | u32 | the shape's stable number (section 3.4), unique in the pack; present exactly when `shapeEpoch` is at least 1 |

### 5.2 Vertex, stop and tunnel columns

Rows hold the vertices (stops, spans) of shape 0, then shape 1 and so on.

| Id | Column | Type | Meaning |
| --- | --- | --- | --- |
| 0x78 | x | i32 | Web Mercator x in centimetres: absolute for a shape's first vertex, else the difference to the previous vertex |
| 0x79 | y | i32 | Web Mercator y in centimetres, encoded like x |
| 0x7A | z | f32 | elevation in metres for every vertex; present when at least one shape has elevation; 0 for shapes without |
| 0x7D | m | u32 | arc length in centimetres: 0 for a shape's first vertex, else the difference to the previous vertex (never negative); the running sum is the vertex's M |
| 0x7B | stopArc | u32 | stop arc positions in centimetres, not decreasing, at most the shape's length |
| 0x7C | tunnel | u32 × 2 | tunnel spans as (start, end) arc positions in centimetres, start below end, ascending and not overlapping, within the length |

All sections except 0x76, 0x7A and those of section 5.3 are required. A decoder rejects a shape whose first 0x7D value is not 0 or whose
0x7D values do not add up to its length. Absolute coordinates stay within ±2,003,750,835 cm (the Web Mercator square);
a difference that does not fit `i32` cannot occur inside it except across the antimeridian, which an encoder
rejects.

The client builds the kernel's shape with the pack's arc length: `createShape(shapePolyline(pack, i))` passes x, y,
z and `s` (the running sum of 0x7D in metres), so stop arcs, tunnel spans and motion plans land where the pipeline
put them. Without `s` the kernel measures 3D segment lengths when z is present, and DEM noise makes that arc length
longer than M: in the package test (`test/arc-length.test.ts`), 304 km with a vertex about every 70 m and up to 3 m
of noise come out 199.7 m longer, so the last stop lands about 200 m short of its station.

### 5.3 Track stubs (1.2)

A shape starts at its first stop and ends at its last, so a train standing at either end has cars beyond M 0 or
beyond the length. A stub is the track beyond one end (D-055, `shape_stub` of migration 0065): it starts at the
shape's first vertex (`before`) or last vertex (`after`) and runs outward along OSM track, up to 400 m. The shape's M,
stop arcs, tunnels and hash are unchanged; a consumer places a point at M < 0 on `before` at distance -M and a point
at M > length on `after` at distance M - length. A stub's height is its end vertex's z.

| Id | Column | Type | Meaning |
| --- | --- | --- | --- |
| 0x80 | stubCount | u32 × 2 | per shape, the vertices of its `before` and `after` stub beyond the end vertex (which is not repeated); 0 where the shape has no stub on that side |
| 0x81 | stubX | i32 | Web Mercator x in centimetres as a difference: the first vertex of a stub to the shape's end vertex, the others to the previous vertex |
| 0x82 | stubY | i32 | Web Mercator y in centimetres, encoded like stubX |
| 0x83 | stubDistance | u32 | ground distance along the track in centimetres as a difference: the first vertex of a stub to the end vertex (0), the others to the previous vertex (never negative); the running sum is the distance from the end vertex, on the scale of M |

Rows hold shape 0 `before`, shape 0 `after`, shape 1 `before` and so on. The four sections are optional and not
critical: a pack carries all of them or none, and only when at least one shape has a stub; such a pack is written as
version 1.2, a pack without stubs stays 1.0 byte for byte. A 1.0 or 1.1 decoder skips them and reads the same shapes.
A 1.2 decoder rejects (`corrupt`) a pack with some but not all four, a 0x80 column that is not two rows per shape,
counts that do not add up to the other columns, a stub that leaves the Web Mercator square, or a stub of zero length.
`shapePolyline` returns `stubBefore` and `stubAfter` (x, y and d in metres, index 0 the end vertex at d 0) when the
shape has them.

### 5.4 Compact vertex columns (1.4)

| Id | Column | Type | Meaning |
| --- | --- | --- | --- |
| 0x84 | compactX | u8 | the values of 0x78, one zigzag LEB128 varint each |
| 0x85 | compactY | u8 | the values of 0x79, coded like 0x84 |
| 0x86 | compactZ | u8 | elevation in whole centimetres per vertex, absolute for a shape's first vertex, else the difference to the previous one, coded like 0x84; present when at least one shape has elevation and every z is a whole centimetre (`fround(cm / 100)` is the float32 value), else 0x7A carries z |
| 0x87 | compactM | u8 | per vertex, the M step of 0x7D less the predicted step, coded like 0x84; for a shape's first vertex the step itself (0) |

A zigzag varint codes `v ≥ 0` as `2v`, `v < 0` as `−2v − 1`, in 7-bit groups, low group first, bit 7 set on all but the
last byte, at most 5 bytes, and canonical (a last byte of 0 after the first is rejected). The **predicted step** between vertices `(x0, y0)` and `(x1, y1)` in Web Mercator
centimetres is `round(100 × sqrt(east² + north²))` metres with `u = (y0 + y1) / (2 × 637,813,700)`, `e = exp(u)`,
`cos = 2 / (e + 1/e)`, `sin = (e − 1/e) / (e + 1/e)`, `w = 1 − e² sin²` with the WGS84 `a` and `e²`,
`east = (x1 − x0) / 637,813,700 × a × cos / sqrt(w)` and `north = (y1 − y0) / 637,813,700 × a × (1 − e²) × cos / (w ×
sqrt(w))`: the ground distance with the radii of curvature at the mid latitude. `exp` is the fixed series of
`src/compact.ts` (14 Taylor terms of u / 16, squared four times), so the computation uses only + − × ÷ and `sqrt`,
which IEEE 754 and ECMAScript round exactly, and every engine gets the same integer (`Math.exp` may differ between
engines). On real packs the residual is −2 to 2 cm, 0 for 74 % of the vertices. **The function is frozen with
version 1.4**: a different operation, order or constant (`Math.hypot`, `Math.exp`, a reordered product) changes
some residuals and is a format change; `test/compact-digest.test.ts` pins the bits of 100,000 seeded inputs,
the Mercator edges and steps within 1e-4 cm of a half centimetre.

The four sections are critical: a 1.3 decoder rejects such a pack with `unsupported_version` instead of reading
other values. A pack holds either 0x78, 0x79 and 0x7D or 0x84, 0x85 and 0x87 (`corrupt` for both or a part), and z
in 0x7A or 0x86, not both. A decoder reads exactly one varint per vertex from each (`corrupt` for bytes left over, a
value cut short or longer than 5 bytes, x or y outside i32, an M step outside u32) and then checks the pack as
section 5.2 does. Packs with this coding are written as version 1.4 and only inside pack sets (4.2): `packs build`
keeps writing the 1.0 and 1.2 coding, byte for byte, so the gate, `complete.json` and every published single pack
keep their meaning. Measured on the 1,712 shapes of a national Sunday keyframe: 16.06 MB brotli as single packs,
10.62 MB as compact single packs, 6.09 MB as one compact pack (brotli 11, 16 MiB window), 7.00 MB in the 13 parts of a
base set as published (brotli 10, default window).

### 5.5 Shapes without a pack (1.4)

| Id | Column | Type | Meaning |
| --- | --- | --- | --- |
| 0x88 | absent | u32 | shape numbers the frames name that have no pack, ascending, none of them in the pack |

Optional and not critical (a pack with it is 1.4), only with a shape epoch; a pack set writes it also when empty.
A client does not ask for these numbers one by one until the next set it reads no longer lists them, or for 12
minutes (a window and the lead) at most.

## 6. Compatibility

- A minor version (1.1, 1.2, 1.3) only adds: new sections with new ids, new flag bits, new category codes, header fields
  inside a longer `headerLength`. It never changes the type or meaning of an existing section or field. A 1.0 decoder
  reads any 1.x object: it skips sections it does not know (unless critical), ignores unknown flag bits, reads
  unknown categories as 0 and ignores header bytes beyond 40.
- A new section that old decoders cannot safely ignore (it changes how existing columns are read) is marked
  critical; a decoder that meets an unknown critical section rejects the object with `unsupported_version`.
- A major version changes layout or meaning. Decoders reject other majors; the live engine then serves both majors
  under separate paths (`/live/v2/`) until old clients are gone.
- Shape ids and content hashes stay valid across versions: a shape pack of an older minor still serves its shape.
- Encoders write the lowest version that holds the content, so frames from 1.0 data stay readable by 1.0 clients.
- History: 1.1 adds the head counts (section 4.1) and states the carry-over and restart rules of section 3, which
  1.0 encoders already met (a keyframe without a delta after a timetable change). 1.2 adds the track stubs of shape
  packs (section 5.3). 1.3 adds the vehicle columns of keyframes and deltas (section 3.1.1). 1.4 adds the pack
  sets of the head (4.2), the compact vertex columns (5.4, critical, written only inside pack sets) and the absent
  shape numbers (5.5).
- A pack's bytes are immutable at its path, so adding stubs to shapes already published needs a new shape epoch
  (section 7 paths); a `packs build` that finds a pack of the same hash with other bytes refuses to mark the epoch
  complete.

## 7. Publication

- **Pre-compressed.** Keyframes, deltas and shape packs are immutable, so the publisher compresses each one once when
  it writes it: brotli quality 11, plus a gzip level 9 copy. Nothing is compressed per request. The keyframe budget
  (section 8) holds only with brotli: 50.4 KB at brotli 11 against 66.6 KB at gzip 9 for 3,000 real trips (README).
- **Negotiation.** A request whose `Accept-Encoding` lists `br` gets the brotli bytes with `Content-Encoding: br`,
  else one listing `gzip` gets the gzip copy, else the plain bytes. Every response carries `Vary: Accept-Encoding`.
  The CRC-32 and `totalLength` cover the plain bytes; the browser removes the content encoding before the worker
  decodes.
- **Content type.** `Content-Type: application/octet-stream` with `X-Content-Type-Options: nosniff`, chosen on
  purpose: it is no text type, so a browser never renders or sniffs it, and a CDN that compresses only listed types
  (Cloudflare's default list leaves it out [I]) has no reason to re-encode the stored brotli bytes. Whether the
  Cloudflare edge passes `Content-Encoding: br` from the origin through unchanged is checked by ADR-0007's CDN spike before launch.
- **Caching.** Keyframes, deltas and shape packs: `Cache-Control: public, max-age=31536000, immutable`. The head is
  68 bytes in 1.0 and 100 to 400 bytes with counts, sent plain with `Cache-Control: public, max-age=1` (ADR-0007).
- **Paths** (architecture §7): `/live/v1/head`, `/live/v1/k/<sequence>.bin`, `/live/v1/d/<sequence>.bin`, and one
  pack per shape at `/live/v1/s/<shapeEpoch>/<number>.bin` (shape numbers) or `/live/v1/s/0/<hash prefix>.bin` (16
  hex digits of the content hash); pack sets (4.2) at `/live/v1/sets/<epoch>/b/<id>/<k>.bin` and
  `/live/v1/sets/<epoch>/i/<id>.bin`, compressed with brotli quality 10 and the default window (a part of about 2 MB
  fits it; quality 10 is 0.3 % larger than 11 in about half the time) plus gzip 9, immutable like the packs. The
  engine writes a set in `sets/<epoch>/.staging-<id>/` on a worker thread and moves it into place, the increment's
  files first and the base directory last with one rename, so `b/<id>/` on disk means a whole set; a failed build is
  not tried again before the next window.

## 8. Sizes

Budgets (architecture §11): a keyframe for about 3,000 trips about 40 to 60 KB compressed; live traffic 150 KB per
minute or less per client. `pnpm --filter @gerlines/live-frame sizes` measures them; results are in the package
README.
