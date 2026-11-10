# ADR-0014: Playback of past hours as pre-rendered windows in the live frame format

## Status
Accepted (2026-11-08): proposed with WP-7.6a; accepted once the timeline UI of WP-7.6b was merged and the
S2 design review passed playback 15 of 15 on screen.

## Context
WP-7.6 lets a visitor pick a past moment and watch every train run as it ran, with play, pause and a speed from
1x to 60x (DESIGN.md references: the Mini Tokyo 3D time editor and the Windy bottom timeline). Positions must stay
on the track in arc length ([ADR-0001](0001-computed-positions-on-matched-track.md)), and the numbers must be real:
what the feeds predicted at that instant, not what we know now.

The live engine already does this for development. `live render` runs the engine on a virtual clock over a past
window, reading `stop_event_forecast` as of each tick through the History reader, and writes the same keyframes
and deltas as `live run` ([ADR-0007](0007-live-transport-frames.md), [architecture](../architecture.md) section 7).
`live replay` serves a finished render with a head that follows a virtual clock. The questions are how a public
service serves such windows, what it costs, and what must stay in the database.

Measured on a replay database (Sunday 2026-10-25, 12:00 to 13:00Z, about 2,160 trains, 1.9 M
forecast rows over the day, read only; M1 Pro):

| Chain | Render of the hour | Keyframes | Deltas | Stored (br and gz) | Deltas br per service minute |
| --- | --- | --- | --- | --- | --- |
| live cadence (keyframe 30 s, delta 2 s), inside the 12 h r12g render | 60 s per hour of that render | 116 | 1,139 | 15.5 MB | 20.2 KB |
| playback cadence (keyframe 300 s, delta 10 s), cold start at 12:00 | 35 to 47 s wall, 22 s CPU, 0.6 GB RSS | 12 | 357 | 3.85 MB | 18.8 KB |
| playback cadence, 17:00 to 18:00Z through the job (lock, nice 10, pack gate, version load times) | 38.3 s wall, 25.3 s user and 2.8 s system CPU, 0.80 GB RSS | 12 | 359 | 4.86 MB | |

During the 17:00 job the database container (Postgres 16 in Docker, `docker stats` every 5 s) used 67 % of a core
on average and 110 % at most, against 0 to 2 % idle: the render's history reads cost Postgres about two thirds of a
core while it runs. Its chain and continuity checks over HTTP (40 clients, 10x) are clean as above.

Both chains pass `verify chain` (40 clients, 0 mismatches, final states equal) and the continuity check (0 jumps,
stalls, backward steps, visible swaps, overspeed steps, positions off the shape) at 10x; the playback chain also at
60x over the hour and at 1x over its first 10 minutes, read through the HTTP routes below.

## Options

1. **Render on demand per request.** Each request names a start; the server runs the engine from there. Every
   visitor pays a cold start of about 20 s for 10 minutes and 35 to 47 s for an hour, and a public endpoint that
   spends half a CPU minute per request is an easy denial of service. Two visitors at 14:23 and 14:24 share nothing.
2. **One shared playback engine per window start**, ticking at the speed of its viewers. Viewers at different
   speeds or positions cannot share it, it holds 0.6 GB per window while anyone watches, and pause, seek and speed
   become server state.
3. **Pre-rendered hour windows, cached on disk with a byte budget** (chosen). A job renders each settled hour once,
   the objects are immutable files behind the CDN, and the client plays them at any speed and position by itself.

## Decision
1. **Windows.** A window is one UTC hour; its start is a multiple of 3,600 Unix seconds. Starts reach back 7 days.
   A window is rendered 30 min after its end, so the realtime processor has folded late payloads and backfill
   minutes first. The client plays any instant of a window at any speed from 1x to 60x; speed, pause and seek are
   client state only, so the server never learns them.
2. **Rendering.** `live playback render` (a separate process, run hourly by a timer; never inside `live run`, whose
   tick must not wait) renders every settled hour the cache lacks with `live render` on a virtual clock: one tick per
   second, history as of each tick, the hold rule on, the pack gate of the live packs directory, and the playback
   cadence of a delta at most every 10 s and a keyframe every 300 s. `--packs` (the live packs directory) is
   required, so the job never plays a version live run would not have served. Each timetable version plays only
   from its load time (`feed_version.loaded_at`, `created_at` when unset) on the engine's clock, and a version
   loaded while a window renders stays hidden, so a backfill or a forced render after a later load plays the
   version that was live then; `--version-available ID=ISO` replaces a load time for a replay database, which
   loaded its versions after the days it replays. This was chosen over refusing windows older than the newest
   load: timetable loads are frequent, and refusing would block the backfill and every forced re-render of the
   past week after each load.
   The render goes into `tmp/`, keeps only the brotli and gzip copies (a client without either gets the gzip copy
   unpacked), and moves whole into its own revision directory `w/<start>/<revision>/{k,d}/` with that revision's
   index. Then `w/<start>/index.json`, the current revision, is replaced by a rename: the commit point. Bytes under
   a revision path never change, so a request that read the old index before a re-render still gets the old
   revision's bytes. A replaced revision stays for 2 hours (the index's max-age of 60 s, as long again at the CDN,
   and a client that keeps playing the old window at 1x for its hour) and is removed by the job's prune after
   that; while kept it counts in the budget. Then windows past 7 days go, and the oldest ones while the cache is
   above its budget (2 GB by default: about 200 Sunday hours or 130 weekday hours at 4 to 15 MB; a week is 168).
   The job takes `<cache>/render.lock` with its pid (one job per cache; a lock of a process that no longer runs is
   taken over; a held lock ends the job with exit 75, a skip for the timer with systemd `SuccessExitStatus=75`), lowers itself to nice 10
   (`--nice`), and first removes `tmp/` entries of processes that no longer run or older than an hour (killed
   renders, failed renames). Nice covers the Node process only; the Postgres reads (about two thirds of a core
   while a window renders, measured above) run in the database at its normal priority. At deploy the timer runs it
   as `nice -n 10 ionice -c 3 node src/cli.ts playback render ...` on Linux, or with systemd `Nice=10`,
   `IOSchedulingClass=idle` and `CPUQuota=100%`, one window at a time as it is now, so the live engine keeps its
   cores; `--last 3` hourly renders one new window per run.
3. **Format reuse.** Keyframes and deltas are the live format (`packages/live-frame`), decoded by the same client
   code with the same catch-up rule (FORMAT.md section 4). Shape packs are the live packs at `/live/v1/s/<epoch>/`;
   the index names the window's shape epoch, so packs of an epoch stay published while a cached window uses it.
4. **Routes** (`services/live/src/playback/app.ts`; `live run` mounts them read only when `LIVE_PLAYBACK_DIR` names
   the cache, off by default; `live playback serve` serves them locally):
   - `GET /playback/v1/windows`: the cached windows inside the limits and the limits (max-age 60).
   - `GET /playback/v1/w/<start>`: the index (revision, shape epoch, sequences, cadence, the first head of each
     state as `[time, sequence, keyframe, oldest, timetable version]`, sizes), max-age 60. 400 with `MISALIGNED`,
     `TOO_OLD`, `NOT_SETTLED` or `INVALID_WINDOW`; 404 `NOT_RENDERED`.
   - `GET /playback/v1/w/<start>/<revision>/head?at=<unix>`: the head a live client saw at that second, so the
     live chain client can poll it on a virtual clock unchanged. Immutable. The cold engine publishes its first head
     a few seconds into the window; an instant before it answers the first head with its own publication time.
   - `GET /playback/v1/w/<start>/<revision>/k|d/<sequence>.bin`: the objects with brotli, gzip or none by
     `Accept-Encoding`. Immutable.
   The revision is a hash prefix over every object and the heads. A window rendered again after a late rebuild of
   its day gets a new revision in its own directory, so objects the CDN cached never mix with new ones; the head
   and object routes answer the current revision and a replaced one while it is kept.
5. **Abuse limits.** No public request starts a render, so a request costs a file read or a CDN hit. Paths and the
   instant are checked against fixed patterns, and only aligned starts inside the limits are answered. Render on
   request exists only in `live playback serve --render-on-miss` for development, refused on a host other than
   loopback and rendering with the job's options (shapes database, `--packs` required, version load times): one
   render at a time, two waiting at most, `202 RENDERING` with `Retry-After: 30` and `503 BUSY` with `Retry-After: 60`. If it is ever opened to the
   public it goes behind the API's limiter and a concurrency gate, as the statistics and MOTIS reads are
   ([architecture](../architecture.md) section 12).
6. **History that must exist.** A render reads the timetable versions with their patterns and shapes, the vehicle
   tables, and the realtime state as of each tick: at its start the newest `stop_event_forecast` row per stop and
   source of the trip instances of the service days before, of and after the window (observed from the start of
   the day before), then the rows by `observed_at` through the hour, with the `trip_instance_source` sightings. In
   production the realtime processor writes them as it follows the recorder; the retention of
   `stop_event_forecast`, `trip_instance` and the sightings must cover 8 days (the 7 days and the day before). In development a replay database filled by the ingest replayer from the recorder's raw
   recordings serves the same purpose (the replay database above).

## Cost per client
Brotli bytes, measured on the Sunday hour: the index about 1 KB, a seek (the keyframe at or before the instant and
the deltas up to it) at most 154 KB, then 18.8 KB of deltas per minute of service. A whole hour costs about 1.2 MB
at any speed. Per wall minute that is 19 KB at 1x, 188 KB at 10x and 1.1 MB at 60x, with about 6 deltas per second
at 60x. The live budget of 150 KB per minute ([architecture](../architecture.md) section 11) holds up to about 8x;
playback gets its own budget of 1.5 MB per hour of service played, at most one window ahead fetched.

## Client (part b)
The client keeps the decisions above and adds none to the server: a virtual clock (speed 1x to 60x, pause, seek) is the
plan clock of the live worker while a playback runs, the heads come from the window index, a head about four wall
seconds of plan time ahead is followed on the revision path (frames warmed in parallel, at most 40), a seek fades the
trains out, clears them, loads the keyframe and the deltas to the instant and fades them in (no fades under reduced
motion), and the next hour's index is fetched 5 min ahead and starts a new chain as a reload when the clock reaches the
end of the window (the fleet blends or crossfades the cold start's corrections; with no next hour the clock stops).
The index's shape epoch must equal the frames' and the first shape's pack must be at `/live/v1/s/<epoch>/`, else the
window is refused. The moment is `?at=<UTC ISO to the second>` in the address, written by the History API (D-057).
Measured on 2026-10-25 12:00 to 14:00Z through `playback serve`: a seam crossing at 10x had 150 shape crossfades of
about 1,900 trains and no frame error, 60x kept a tick p95 of 2.4 ms and a frame apply lag of 0.2 plan seconds.

## Consequences
### Positive
- A request never costs more than a static file, and every visitor of an hour shares the same CDN objects.
- The chain and continuity checks of the live engine apply unchanged to every rendered window.
- Rendering a week costs about 168 renders of 22 s CPU each per week, and 0.65 to 2.5 GB of disk.

### Negative
- An hour becomes playable only 30 min after its end, and the first render after a gap takes about 40 s per hour.
- Each window starts its engine cold at the hour. At the seam between two windows the client meets a new chain
  (a keyframe without a delta) and the engine state of the next hour starts fresh, so trains may correct their
  position there; part b crossfades as at a timetable switch.
- A weekday hour with about 5,000 trains is larger than the Sunday hour measured: the live cadence render of
  2026-10-20 14:00Z (timetable only, no forecasts in that database) stored 16 MB of brotli and gzip copies with
  51 KB keyframes.
- The render shows a version from its load time, not from the moment its packs were complete; live run waited
  for the packs too, so the first minutes after a load may differ from what live showed.
- A forced re-render keeps two revisions of the window on disk for 2 hours.

## Open
- A rebuild notice that re-renders the hours of a rebuilt day. A window across a timetable rollover was not rendered
  with rollover data (the rollover database was not used).
- The weekday peak: render time, bytes per minute and the continuity check of a weekday hour with realtime data
  were not measured (no weekday replay database with forecasts was at hand).
- Keyframe stepping at high speed (one keyframe per 300 s of service, 577 KB per hour, cheaper than the deltas at
  60x) would skip plan changes between keyframes; not measured.
