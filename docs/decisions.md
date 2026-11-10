# Decisions

Short records of the project decisions that the code and the documents cite as `D-0NN`. Decisions with a longer
context and their consequences are ADRs in [adr/](adr/). Each entry states what was decided, not how it was reached.

- **D-003** Design scope. The interface is designed as a product for web on phone, tablet, desktop and large
  screens; [DESIGN.md](../DESIGN.md) at the project root is the single source of truth for design decisions.
- **D-004** Key gating. Every API that needs a key is listed in [KEYS.md](KEYS.md) with where to get it and its
  environment variable; work against it starts only after the key is in `.env` and `scripts/check-keys.sh` passes.
- **D-008** Third-party screenshots stay local. `design/references/` is git-ignored: screenshots of other sites are a
  local design record and are not published.
- **D-012** pnpm 11. The repository pins pnpm 11.28.6; pnpm 12 follows once it works in every supported development
  setup.
- **D-017** Motion kernel. `packages/geo` is the motion kernel of the browser worker and the reference for the
  server's motion plans: square-root limited catch-up and a feasibility floor with counted adjustments, all along the
  matched shape in arc length ([ADR-0001](adr/0001-computed-positions-on-matched-track.md)).
- **D-018** Rendering tiers. The level-of-detail thresholds of [architecture.md](architecture.md) section 8.2 hold
  with count caps: dots and icons 15,000, slices 1,500, 3D cars for 300 trains with a hard cap of 600. The worker
  advances trains in view plus a margin every frame and the rest at a lower rate.
- **D-022** Messages with Paraglide. Paraglide JS 2 (pinned) compiles the English, German and Polish messages; the
  generated `src/paraglide/` is not committed and is built by the `@gerlines/i18n#compile` task; `changeLocale` is
  the only language switch.
- **D-024** MOTIS configuration. The journey planner runs MOTIS 2.11.4 on DELFI plus a rail-only OSM extract, with
  `route_shapes` for rail, no tiles and no geocoding, the timetable to the feed end and the dataset key `de-DELFI`;
  journeys are searched from station to station.
- **D-025** Versioned timetable. Timetable tables are keyed by feed version and GTFS key and loaded in one
  transaction per version; a reload replaces a version, deletes cascade, an advisory lock guards each source, and the
  stop counts and first and last times of every trip are reconciled in SQL before the commit.
- **D-027** Recorder storage. The recorder stores every payload byte for byte, per source and UTC hour, as zstd
  frames with a sidecar line per object; the files are the source of truth and the database (`raw_object`,
  `raw_object_segment`) is an index of them.
- **D-028** Shape method. Shapes come from MOTIS `route_shapes` and from pfaedle (`-m rail`) for each trip pattern;
  MOTIS is the primary method (domestic stop distance p95 23 m against 48 m). D-037 refines the fallback.
- **D-037** Per-pattern fallback. A pattern whose shape from its group's method fails the quality gate takes the
  other method's shape when that one passes; only when both fail is the pattern marked `low_quality`.
- **D-038** Trains without a usable shape. Trains whose pattern has no usable shape are not drawn and are counted as
  having no track geometry in the legend; fully cancelled trains stay out of the live frames but remain in search
  and on the train card.
- **D-039** Liveries on 3D cars. Every 3D car wears its sourced livery, or the neutral vehicle palette when none is
  sourced, never the category colour as a made-up livery; a roof band on each car carries the active colour mode
  (category by default, delay or operator).
- **D-040** Realtime ingest. Realtime feeds are decoded by our own GTFS-RT reader with limits, adapted per source
  into canonical events, matched to trips by id, by stops and times or by train numbers, and folded into
  `stop_event`, `stop_event_forecast`, `segment_obs`, `event` and `rt_payload`. Service dates are in Europe/Berlin,
  and a delay earlier than minus 30 minutes counts as no data.
- **D-041** Realtime sources. A live IRIS poller covers long-distance trains from a greedy station cover within the
  API's rate limit; the official Mobilithek DELFI GTFS-RT is the primary DELFI realtime source, with the community
  mirror as fallback; long-distance history comes from Bahn-Vorhersage, piebro and our own recordings.
- **D-045** Car triangle budget. A 3D car may use up to 6,000 triangles at LOD0, 1,200 at LOD1 and 300 at LOD2.
- **D-048** One unexplained turn. A matched shape whose only fault is a single unexplained turn is kept, with the
  turn cut to a chord where every stop stays near the line, and flagged for review: drawing a running train as a
  straight line is worse than one wrong turn.
- **D-051** ICE 50 at the Breckenheim junction. Matched shapes of ICE 50 turned at the Breckenheim junction, which
  has no platforms and where no train reverses (the Wallauer Spange is planned, not built). The leg is rerouted on
  our own rail graph instead of raising pfaedle's turn penalty for the whole run.
- **D-053** Lamps on train fronts. Each lamp cluster is one filled component placed where the photo shows it; the
  white lens is filled and dominant, a small dark unlit red lens appears only where the real cluster has one, and
  there is no rim stroke (a hairline edge up to 1.5 cm is allowed round a white lens on a white body). Which lamps are
  lit is a renderer state, not part of the model colours.
- **D-055** Cars at a shape's ends. A train is drawn as 3D cars only when its whole consist lies on the shape,
  otherwise as its chevron. Later, shapes are extended along the matched track beyond the first and the last stop
  (about 400 m) so that trains standing at a terminus show as cars; a straight extension off the track is rejected
  ([ADR-0001](adr/0001-computed-positions-on-matched-track.md)).
- **D-057** Address state. The address holds the train, station, land and map view through the History API
  (`replaceState` for camera moves, `pushState` for new selections), without a router; the search index lives in
  memory per Berlin service day.
- **D-060** Vehicle identification. Line rules name a series with a confidence of 0.3 to 0.9 and do not fall back to
  a weaker layer that could name a series the line source excludes; the bahn.de coach sequence adapter stays off by
  default.
- **D-065** Forecast on the card. Where the live feed predicts a delay for a later stop, the card shows that
  prediction with an upper bound (8 in 10 under) from our model's spread; our model's own expected value shows only
  where the feed has none. On a replay of 313,863 stop pairs the feed's prediction was the closer one.
- **D-067** Straight links across borders. Where the rail graph has no matched geometry for a cross-border link, the
  pattern keeps a straight link between the two stops; trains still move along it in arc length, but that shape is
  not the track. This is a known deviation from requirement R-04, closed once the neighbouring countries' rail data is
  in the rail graph.
- **D-070** Accessibility of the map. The map's text alternative is a list of the trains in view (the 20 nearest the
  map centre) with a polite view summary at most every 10 s after a user move; keyboard shortcuts can be switched
  off; the timeline speed buttons are 40 px (44 on a phone); the profile tooltip is hoverable, persistent and
  dismissable; colour and label modes are radio groups.
- **D-071** A stop passed while cancelled stays passed. The live engine draws a train past a cancelled stop it has
  already passed. When a later update serves that stop again, the motion plan keeps it cancelled and keeps its time,
  so no passed stop moves and the train never jumps backwards (ADR-0001). The same holds the other way: a served stop
  the train has reached stays served in the motion plan when the source cancels it while the train dwells there. The
  card and the detail API read a stop's state and times from the source rows, so they still show the source's answer.
