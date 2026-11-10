import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TrainDetail, type TrainStop } from "@gerlines/schema";
import { normalizeTrainNumber, tripInstanceId } from "@gerlines/schema/ids";
import type { FixtureInfo } from "./index.ts";

const DATABASE = process.env.FIXTURE_DATABASE ?? "gerlines_wp23";
const OUT = new URL("./", import.meta.url);
const SOURCE_PRIORITY = ["delfi-gtfs-rt", "gtfsde-rt", "vbb-gtfs-rt", "vbn-gtfs-rt"];

type Row = Record<string, unknown>;

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

function sql(text: string, vars: Record<string, string> = {}): Row[] {
  const args = ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"];
  for (const [key, value] of Object.entries(vars)) {
    args.push("-v", `${key}=${value}`);
  }
  const result = spawnSync(process.env.PSQL ?? "psql", args, {
    input: `select coalesce(json_agg(q), '[]') from (${text}) q;`,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: {
      PATH: process.env.PATH ?? "",
      PGHOST: process.env.POSTGRES_HOST ?? "127.0.0.1",
      PGPORT: process.env.POSTGRES_PORT ?? "5433",
      PGUSER: process.env.POSTGRES_USER ?? "",
      PGPASSWORD: process.env.POSTGRES_PASSWORD ?? "",
      PGDATABASE: DATABASE,
      PGOPTIONS: "-c default_transaction_read_only=on",
    },
  });
  if (result.status !== 0) {
    throw new Error(`psql failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as Row[];
}

function trainNumber(value: unknown): string | null {
  return normalizeTrainNumber(typeof value === "string" ? value : null);
}

const iso = (value: unknown): string | null =>
  value === null || value === undefined ? null : new Date(String(value)).toISOString();
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;
const num = (value: unknown): number | null => (typeof value === "number" ? value : null);

const at =
  process.argv[2] ??
  sql("select max(observed_at) - interval '20 minutes' as t from rt_payload")[0]?.t;
if (at === null || at === undefined) {
  say(`${DATABASE} holds no realtime payloads, nothing to build from`);
  process.exit(1);
}
const T = new Date(String(at)).toISOString();
const vars = { t: T };
say(`database ${DATABASE}, as of ${T}`);

const SUMMARY = `
  select se.trip_instance_id as id, se.source_id as source, ti.category_code as category, ti.operator_id as operator,
         coalesce(r.is_foreign, t.is_foreign, false) or se.source_id not in ('delfi-gtfs-rt','gtfsde-rt','vbb-gtfs-rt','vbn-gtfs-rt') as foreign,
         count(*)::int as stops,
         bool_or(se.cancelled) as any_cancelled, bool_and(se.cancelled) as all_cancelled,
         bool_or(se.platform_actual is distinct from se.platform_scheduled and se.platform_actual is not null and se.platform_scheduled is not null) as platform_change,
         max(length(sp.name))::int as longest_name,
         max(abs(coalesce(se.arrival_delay_s, se.departure_delay_s, 0)))::int as max_delay
  from stop_event se
  join trip_instance ti using (trip_instance_id)
  join stop_place sp on sp.stop_place_id = se.stop_place_id
  left join trip t on t.feed_version_id = ti.feed_version_id and t.trip_key = ti.trip_key
  left join route r on r.feed_version_id = t.feed_version_id and r.route_key = t.route_key
  group by 1, 2, 3, 4, 5
  having min(coalesce(se.scheduled_departure, se.scheduled_arrival)) <= :'t'::timestamptz
     and max(coalesce(se.predicted_arrival, se.scheduled_arrival, se.scheduled_departure)) >= :'t'::timestamptz
  order by 1, 2`;

interface Candidate {
  readonly id: string;
  readonly source: string;
  readonly category: string | null;
  readonly operator: string | null;
  readonly foreign: boolean;
  readonly stops: number;
  readonly any_cancelled: boolean;
  readonly all_cancelled: boolean;
  readonly platform_change: boolean;
  readonly longest_name: number;
  readonly max_delay: number;
}

function chooseSource(rows: Candidate[]): Candidate[] {
  const byInstance = new Map<string, Candidate[]>();
  for (const row of rows) byInstance.set(row.id, [...(byInstance.get(row.id) ?? []), row]);
  const rank = (source: string) => {
    const index = SOURCE_PRIORITY.indexOf(source);
    return index === -1 ? SOURCE_PRIORITY.length : index;
  };
  return [...byInstance.values()].map(
    (list) => [...list].sort((a, b) => rank(a.source) - rank(b.source))[0] as Candidate,
  );
}

function buildRealtime(candidate: Candidate): TrainDetail {
  const params = { ...vars, id: candidate.id, s: candidate.source };
  const head = sql(
    `select ti.trip_instance_id, ti.service_date::text as service_date, ti.category_code, ti.train_number, ti.is_added,
            t.headsign, t.short_name as trip_short_name, r.short_name as route_short_name,
            coalesce(r.is_foreign, t.is_foreign, false) as is_foreign,
            o.operator_id, coalesce(o.brand_name, o.name) as operator_name, o.wikidata_qid,
            fv.feed_version, s.name as source_name, s.attribution
     from trip_instance ti
     left join trip t on t.feed_version_id = ti.feed_version_id and t.trip_key = ti.trip_key
     left join route r on r.feed_version_id = t.feed_version_id and r.route_key = t.route_key
     left join operator o on o.operator_id = coalesce(ti.operator_id, r.operator_id)
     left join feed_version fv on fv.feed_version_id = ti.feed_version_id
     join source s on s.source_id = :'s'
     where ti.trip_instance_id = :'id'`,
    params,
  )[0] as Row;
  const stops = sql(
    `select se.stop_index, se.stop_place_id, sp.name, se.scheduled_arrival, se.scheduled_departure,
            se.platform_scheduled, se.platform_actual,
            (select e.occurred_at from event e where e.trip_instance_id = se.trip_instance_id and e.stop_index = se.stop_index
               and e.event_type = 'PlatformChanged' and e.source_id = :'s' and e.occurred_at <= :'t'::timestamptz
             order by e.occurred_at desc limit 1) as platform_changed_at
     from stop_event se join stop_place sp on sp.stop_place_id = se.stop_place_id
     where se.trip_instance_id = :'id' and se.source_id = :'s' order by se.stop_index`,
    params,
  );
  const forecasts = new Map(
    sql(
      `select distinct on (stop_index) stop_index, predicted_arrival, predicted_departure, arrival_delay_s,
              departure_delay_s, cancelled, explicit, observed_at
       from stop_event_forecast where trip_instance_id = :'id' and source_id = :'s' and observed_at <= :'t'::timestamptz
       order by stop_index, observed_at desc`,
      params,
    ).map((row) => [row.stop_index as number, row]),
  );
  const feedObservedAt = iso(
    sql(
      `select max(observed_at) as m from rt_payload where source_id = :'s' and observed_at <= :'t'::timestamptz`,
      params,
    )[0]?.m,
  );
  const changedAt = [...forecasts.values()].map((row) => Date.parse(String(row.observed_at)));
  const trainStops: TrainStop[] = stops.map((row) => {
    const forecast = forecasts.get(row.stop_index as number);
    const platformKnown = row.platform_changed_at !== null;
    return {
      index: row.stop_index as number,
      stopPlaceId: String(row.stop_place_id),
      name: String(row.name),
      scheduledArrival: iso(row.scheduled_arrival),
      scheduledDeparture: iso(row.scheduled_departure),
      predictedArrival: iso(forecast?.predicted_arrival),
      predictedDeparture: iso(forecast?.predicted_departure),
      arrivalDelaySeconds: num(forecast?.arrival_delay_s),
      departureDelaySeconds: num(forecast?.departure_delay_s),
      platformScheduled: text(row.platform_scheduled),
      platformActual: platformKnown ? text(row.platform_actual) : null,
      cancelled: forecast?.cancelled === true,
      prediction: forecast ? (forecast.explicit ? "explicit" : "propagated") : null,
    };
  });
  return assemble(
    head,
    trainStops,
    {
      kind: forecasts.size > 0 ? "realtime" : "timetable",
      sourceId: candidate.source,
      sourceName: String(head.source_name),
      attribution: String(head.attribution),
      predictionChangedAt:
        changedAt.length > 0 ? new Date(Math.max(...changedAt)).toISOString() : null,
      feedObservedAt,
    },
    forecasts.size,
  );
}

function stopTime(stop: TrainStop, kind: "arrival" | "departure"): number | null {
  const value =
    kind === "arrival"
      ? (stop.predictedArrival ??
        stop.scheduledArrival ??
        stop.predictedDeparture ??
        stop.scheduledDeparture)
      : (stop.predictedDeparture ??
        stop.scheduledDeparture ??
        stop.predictedArrival ??
        stop.scheduledArrival);
  return value === null ? null : Date.parse(value);
}

function progressAt(stops: TrainStop[]): { lastPassed: TrainStop | null; next: TrainStop | null } {
  const now = Date.parse(T);
  const served = stops.filter((stop) => !stop.cancelled);
  const passed = served.filter((stop, i) => {
    const time = stopTime(stop, i === served.length - 1 ? "arrival" : "departure");
    return time !== null && time <= now;
  });
  const lastPassed = passed[passed.length - 1] ?? null;
  const next = served.find((stop) => lastPassed === null || stop.index > lastPassed.index) ?? null;
  return { lastPassed, next };
}

function delayAt(stop: TrainStop | null, provenance: TrainDetail["provenance"]): number | null {
  if (provenance.kind !== "realtime" || stop === null) {
    return null;
  }
  return stop.arrivalDelaySeconds ?? stop.departureDelaySeconds;
}

function operatorOf(head: Row): TrainDetail["operator"] {
  return text(head.operator_id)
    ? {
        id: String(head.operator_id),
        name: String(head.operator_name),
        wikidataQid: text(head.wikidata_qid),
      }
    : null;
}

function assemble(
  head: Row,
  stops: TrainStop[],
  provenance: TrainDetail["provenance"],
  version: number,
): TrainDetail {
  const { lastPassed, next } = progressAt(stops);
  const cancelled = stops.every((stop) => stop.cancelled);
  const delay = delayAt(next ?? lastPassed, provenance);
  const last = stops[stops.length - 1] as TrainStop;
  const candidate = {
    tripInstanceId: String(head.trip_instance_id),
    frameKey: null,
    serviceDate: String(head.service_date),
    timetableVersion: text(head.feed_version) ?? "unknown",
    version,
    asOf: T,
    category: String(head.category_code ?? "other"),
    productName: null,
    line: text(head.route_short_name),
    trainNumber: trainNumber(head.train_number ?? head.trip_short_name),
    foreign:
      head.is_foreign === true ||
      (!SOURCE_PRIORITY.includes(provenance.sourceId) && provenance.kind === "realtime"),
    added: head.is_added === true,
    cancelled,
    operator: operatorOf(head),
    destination: { stopPlaceId: last.stopPlaceId, name: last.name },
    headsign: text(head.headsign),
    delaySeconds: cancelled ? null : delay,
    provenance,
    geometry: { available: true, reason: null },
    progress: cancelled
      ? { lastPassedIndex: null, nextIndex: null }
      : { lastPassedIndex: lastPassed?.index ?? null, nextIndex: next?.index ?? null },
    stops,
    vehicle: null,
    photo: null,
  };
  return TrainDetail.parse(candidate);
}

function buildTimetableOnly(category: string): { detail: TrainDetail; trip: string } | null {
  const serviceDate = String(
    sql(`select ((:'t'::timestamptz) at time zone 'Europe/Berlin')::date::text as d`, vars)[0]?.d,
  );
  const params = { ...vars, d: serviceDate, c: category };
  const trips = sql(
    `with ref as (select ((:'d'::date + time '12:00') at time zone 'Europe/Berlin') - interval '12 hours' as r),
          fv as (select max(feed_version_id) as id from feed_version where status = 'loaded')
     select t.feed_version_id, t.trip_key, t.trip_pattern_id, t.short_name, t.headsign, r.short_name as route_short_name,
            r.operator_id, coalesce(o.brand_name, o.name) as operator_name, o.wikidata_qid, fv2.feed_version
     from trip t join fv on t.feed_version_id = fv.id
     join route r on r.feed_version_id = t.feed_version_id and r.route_key = t.route_key
     left join operator o on o.operator_id = r.operator_id
     join feed_version fv2 on fv2.feed_version_id = t.feed_version_id
     join service_calendar sc on sc.feed_version_id = t.feed_version_id and sc.service_key = t.service_key
     left join service_calendar_date x on x.feed_version_id = t.feed_version_id and x.service_key = t.service_key and x.service_date = :'d'::date
     cross join ref
     where t.category_code = :'c' and not t.is_foreign
       and (x.exception_type = 1 or (x.exception_type is null and (sc.weekdays & (1 << ((extract(isodow from :'d'::date)::int) - 1))) > 0
            and :'d'::date between sc.start_date and sc.end_date))
       and ref.r + make_interval(secs => t.first_departure_s + 600) <= :'t'::timestamptz
       and ref.r + make_interval(secs => t.last_arrival_s - 600) >= :'t'::timestamptz
       and not exists (select 1 from trip_instance ti where ti.feed_version_id = t.feed_version_id and ti.trip_key = t.trip_key and ti.service_date = :'d'::date)
     order by t.trip_key limit 1`,
    params,
  );
  const trip = trips[0];
  if (!trip) return null;
  const stops = sql(
    `with ref as (select ((:'d'::date + time '12:00') at time zone 'Europe/Berlin') - interval '12 hours' as r)
     select st.stop_index, sp.stop_place_id, sp.name, sp2.platform_code,
            ref.r + make_interval(secs => st.arrival_s) as arr, ref.r + make_interval(secs => st.departure_s) as dep
     from stop_time st cross join ref
     join trip_pattern_stop tps on tps.feed_version_id = st.feed_version_id and tps.trip_pattern_id = :'p'::uuid and tps.stop_index = st.stop_index
     join stop_point sp2 on sp2.stop_point_id = tps.stop_point_id
     join stop_place sp on sp.stop_place_id = sp2.stop_place_id
     where st.feed_version_id = :'fv'::int and st.trip_key = :'k' order by st.stop_index`,
    {
      ...params,
      p: String(trip.trip_pattern_id),
      fv: String(trip.feed_version_id),
      k: String(trip.trip_key),
    },
  );
  const trainStops: TrainStop[] = stops.map((row, i) => ({
    index: row.stop_index as number,
    stopPlaceId: String(row.stop_place_id),
    name: String(row.name),
    scheduledArrival: i === 0 ? null : iso(row.arr),
    scheduledDeparture: i === stops.length - 1 ? null : iso(row.dep),
    predictedArrival: null,
    predictedDeparture: null,
    arrivalDelaySeconds: null,
    departureDelaySeconds: null,
    platformScheduled: text(row.platform_code),
    platformActual: null,
    cancelled: false,
    prediction: null,
  }));
  const origin = trainStops[0] as TrainStop;
  const number = trainNumber(trip.short_name);
  const id = tripInstanceId({
    serviceDate,
    operatorId:
      trip.operator_id === null || trip.operator_id === undefined ? null : String(trip.operator_id),
    trainNumber: number,
    originStopPlaceId: origin.stopPlaceId,
    originDeparture: Date.parse(String(origin.scheduledDeparture)),
  });
  const source = sql(
    `select name, attribution from source where source_id = 'delfi-gtfs'`,
  )[0] as Row;
  const head: Row = {
    trip_instance_id: id,
    service_date: serviceDate,
    category_code: category,
    train_number: number,
    is_added: false,
    headsign: trip.headsign,
    route_short_name: trip.route_short_name,
    is_foreign: false,
    operator_id: trip.operator_id,
    operator_name: trip.operator_name,
    wikidata_qid: trip.wikidata_qid,
    feed_version: trip.feed_version,
  };
  const detail = assemble(
    head,
    trainStops,
    {
      kind: "timetable",
      sourceId: "delfi-gtfs",
      sourceName: String(source.name),
      attribution: String(source.attribution),
      predictionChangedAt: null,
      feedObservedAt: null,
    },
    0,
  );
  return { detail, trip: String(trip.trip_key) };
}

interface Pick {
  readonly name: string;
  readonly note: string;
  readonly test: (candidate: Candidate) => boolean;
  readonly score?: (candidate: Candidate) => number;
  readonly accept: (detail: TrainDetail) => boolean;
}

const running = (d: TrainDetail) =>
  d.progress.lastPassedIndex !== null && d.progress.nextIndex !== null && !d.cancelled;
const ahead = (d: TrainDetail, stop: TrainStop) =>
  d.progress.nextIndex !== null && stop.index >= d.progress.nextIndex;
const changed = (stop: TrainStop) =>
  stop.platformActual !== null &&
  stop.platformScheduled !== null &&
  stop.platformActual !== stop.platformScheduled;
const SCAN = 60;

const PICKS: readonly Pick[] = [
  {
    name: "ice-delay",
    note: "High speed train running with realtime and a delay of at least five minutes",
    test: (c) =>
      c.category === "hsr" &&
      !c.foreign &&
      !c.all_cancelled &&
      c.max_delay >= 300 &&
      c.max_delay <= 3600 &&
      c.stops >= 5,
    score: (c) => (c.platform_change ? 10_000 : 0) + c.stops,
    accept: (d) => running(d) && Math.abs(d.delaySeconds ?? 0) >= 300,
  },
  {
    name: "platform-change",
    note: "Train running with a changed platform at its next stop or a later one",
    test: (c) => c.platform_change && !c.all_cancelled && !c.foreign && c.stops >= 4,
    score: (c) => c.stops,
    accept: (d) => {
      const next = d.stops.find((stop) => stop.index === d.progress.nextIndex);
      return running(d) && next !== undefined && changed(next);
    },
  },
  {
    name: "sbahn-on-time",
    note: "S-Bahn running with realtime and no delay",
    test: (c) =>
      c.category === "sbahn" && !c.foreign && !c.any_cancelled && c.max_delay < 60 && c.stops >= 6,
    score: (c) => (c.operator?.includes("s-bahn") ? 1000 : 0) - c.stops,
    accept: (d) => running(d) && d.delaySeconds === 0,
  },
  {
    name: "cancelled-stop",
    note: "Train running with realtime and a cancelled stop ahead",
    test: (c) => c.any_cancelled && !c.all_cancelled && !c.foreign && c.stops >= 4,
    score: (c) => c.stops,
    accept: (d) => running(d) && d.stops.some((stop) => stop.cancelled && ahead(d, stop)),
  },
  {
    name: "cancelled-train",
    note: "Train cancelled at every stop",
    test: (c) => c.all_cancelled && c.stops >= 3,
    score: (c) => -c.stops,
    accept: (d) => d.cancelled,
  },
  {
    name: "long-names",
    note: "Running train with the longest stop names among running trains",
    test: (c) => c.longest_name >= 30 && !c.all_cancelled,
    score: (c) => c.longest_name,
    accept: (d) => running(d),
  },
  {
    name: "foreign",
    note: "Running train of a neighbouring country, realtime from a foreign source or marked foreign in the timetable",
    test: (c) => c.foreign && !c.all_cancelled && c.stops >= 3,
    score: (c) => (c.source === "gtfsde-rt" || c.source === "delfi-gtfs-rt" ? 1000 : 0) + c.stops,
    accept: (d) => running(d),
  },
  {
    name: "night",
    note: "Night train running",
    test: (c) => c.category === "night" && !c.all_cancelled,
    score: (c) => c.stops,
    accept: (d) => running(d),
  },
];

const candidates = chooseSource(sql(SUMMARY, vars) as unknown as Candidate[]);
say(`${candidates.length} running instances at ${T}`);
const used = new Set<string>();
const written: string[] = [];

function builderInfo(): FixtureInfo["builder"] {
  const path = fileURLToPath(import.meta.url);
  const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim();
  return {
    script: "apps/web/src/components/train/fixtures/build.ts",
    commit: commit === "" ? null : commit,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  };
}

function provenanceInfo(): {
  replay: FixtureInfo["replay"];
  feedVersions: FixtureInfo["feedVersions"];
  rtPayloads: FixtureInfo["rtPayloads"];
} {
  const window =
    sql("select min(observed_at) as from, max(observed_at) as to from rt_payload")[0] ?? {};
  const versions = sql(
    "select feed_version_id as id, feed_version as version from feed_version where status = 'loaded' order by 1",
  );
  const payloads = sql(
    "select source_id as source, count(*)::int as n from rt_payload where observed_at <= :'t'::timestamptz group by 1 order by 1",
    vars,
  );
  return {
    replay: { from: iso(window.from), to: iso(window.to) },
    feedVersions: versions.map((row) => ({ id: Number(row.id), version: String(row.version) })),
    rtPayloads: {
      atOrBefore: T,
      total: payloads.reduce((sum, row) => sum + Number(row.n), 0),
      bySource: Object.fromEntries(payloads.map((row) => [String(row.source), Number(row.n)])),
    },
  };
}

const BUILD_INFO = { ...provenanceInfo(), builder: builderInfo() };
const ASSUMED = [
  "detail.geometry.available is set true: matched shapes are not loaded in this database",
  "detail.productName is null: the static feed names long distance routes by line number only",
];

function write(name: string, note: string, detail: TrainDetail, selection: string) {
  const info: FixtureInfo = {
    name,
    note,
    database: DATABASE,
    asOf: T,
    selection,
    ...BUILD_INFO,
    assumed: ASSUMED,
    rebuildable: false,
    rebuildNote: `${DATABASE} is a scratch database that other runs reset, so the data behind this instant may be gone`,
  };
  const fixture = { fixture: info, detail };
  writeFileSync(new URL(`${name}.json`, OUT), `${JSON.stringify(fixture, null, 2)}\n`);
  written.push(name);
  say(
    `${name}: ${detail.line ?? ""} ${detail.trainNumber ?? ""} ${detail.stops.length} stops, source ${detail.provenance.sourceId}`,
  );
}

for (const pick of PICKS) {
  const matches = candidates
    .filter((c) => !used.has(c.id) && pick.test(c))
    .sort((a, b) => (pick.score?.(b) ?? 0) - (pick.score?.(a) ?? 0) || a.id.localeCompare(b.id));
  let chosen: { candidate: Candidate; detail: TrainDetail } | null = null;
  for (const candidate of matches.slice(0, SCAN)) {
    const detail = buildRealtime(candidate);
    if (pick.accept(detail)) {
      chosen = { candidate, detail };
      break;
    }
  }
  if (!chosen) {
    say(
      `${pick.name}: no match in the data (${matches.length} candidates, ${Math.min(matches.length, SCAN)} checked)`,
    );
    continue;
  }
  used.add(chosen.candidate.id);
  write(
    pick.name,
    pick.note,
    chosen.detail,
    `trip_instance ${chosen.candidate.id}, source ${chosen.candidate.source}`,
  );
}

const timetable = buildTimetableOnly("rfast");
if (timetable) {
  write(
    "re-timetable",
    "Fast regional train running by the timetable with no realtime from any source on this day",
    timetable.detail,
    `trip ${timetable.trip} of the newest loaded feed version, no trip_instance on the service day`,
  );
} else {
  say("re-timetable: no match in the data");
}
say(`wrote ${written.join(", ")}`);
