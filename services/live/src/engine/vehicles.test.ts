import { decodeDelta, decodeKeyframe, frameToObject, type Head } from "@gerlines/live-frame";
import type { FleetRuleRow, ObservedFormation } from "@gerlines/schema/vehicle-resolver";
import { describe, expect, it } from "vitest";
import { checkChain } from "../evidence/chain-check.ts";
import type { HeadEntry } from "../evidence/continuity.ts";
import type { StaticRun } from "../model.ts";
import type { RealtimeReader } from "../realtime/readers.ts";
import type { ForecastRow } from "../realtime/store.ts";
import type { FeedVersionInfo, TimetableSource } from "../timetable/loader.ts";
import { type FleetCatalogue, type FleetSource, VehicleIdentities } from "../vehicle/identities.ts";
import { type FrameSink, LiveEngine, type RestoredChain } from "./engine.ts";
import { MemoryKeyStore } from "./keys.ts";

const T = 1_792_922_400;

function run(id: number, extra: Partial<StaticRun> = {}): StaticRun {
  return {
    instanceId: `00000000-0000-5000-8000-${String(id).padStart(12, "0")}`,
    serviceDate: "2026-10-25",
    feedVersionId: 1,
    tripKey: `t${id}`,
    category: "hsr",
    categoryCode: "hsr",
    foreign: false,
    line: "12",
    trainNumber: 500 + id,
    shortName: String(500 + id),
    operatorId: "db-fernverkehr-ag",
    patternId: `p${id}`,
    stopPlaces: ["a", "b", "c"],
    arrivals: [T, T + 1200, T + 2400],
    departures: [T + 60, T + 1260, T + 2400],
    passThrough: [0, 0, 0],
    shape: {
      shapeNo: 100 + id,
      hash: "cd".repeat(32),
      length: 30_000,
      stopArcs: Float64Array.from([500, 15_000, 29_000]),
      qaStatus: "pass",
    },
    gap: null,
    ...extra,
  };
}

const RULES: FleetRuleRow[] = [
  {
    ruleId: "ice-line-12",
    scope: "line",
    operatorId: "db-fernverkehr-ag",
    categoryCode: "hsr",
    lineKeys: ["12"],
    seriesIds: ["db-412"],
    modelId: null,
    modelName: null,
    units: null,
    fleetCount: null,
    fleetTotal: null,
    validFrom: null,
    validTo: null,
    sourceId: "wikipedia-de-ice-linien",
  },
];

const SERIES = new Map(
  [
    { seriesId: "db-412", name: "ICE 4", unitLengthMetres: 346 },
    { seriesId: "db-403", name: "ICE 3", unitLengthMetres: 200 },
  ].map((row) => [row.seriesId, row]),
);

class Catalogues implements FleetSource {
  observations: ObservedFormation[] = [];
  loads = 0;
  async load(): Promise<FleetCatalogue> {
    this.loads++;
    return {
      rules: RULES,
      series: SERIES,
      observations: this.observations,
      instances: new Map(),
      namedOperators: new Set(["db-fernverkehr-ag"]),
    };
  }
}

class Timetable implements TimetableSource {
  private readonly runs: StaticRun[];
  constructor(runs: StaticRun[]) {
    this.runs = runs;
  }
  async versions(): Promise<FeedVersionInfo[]> {
    return [{ feedVersionId: 1, publishedOn: "2026-10-19", validFrom: null, validTo: null }];
  }
  async runsOn(_: number, day: string) {
    return this.runs.filter((r) => r.serviceDate === day);
  }
  async shapeCoverage() {
    return { coverage: 1, runs: this.runs.length };
  }
  async placeCoordinates() {
    return new Map();
  }
}

const silent: RealtimeReader = {
  async *read() {},
};

class Sink implements FrameSink {
  readonly objects = new Map<string, Uint8Array>();
  readonly heads: HeadEntry[] = [];
  latestHead: Head | null = null;
  async object(kind: "k" | "d", sequence: number, bytes: Uint8Array) {
    this.objects.set(`${kind}/${sequence}.bin`, bytes);
  }
  async head(_: Uint8Array, head: Head) {
    this.latestHead = head;
    this.heads.push([
      head.timeBase,
      head.sequence,
      head.keyframeSequence,
      head.oldestSequence,
      head.timetableVersion,
    ]);
  }
  reader() {
    return async (path: string) => this.objects.get(path) ?? null;
  }
}

class Hung implements FleetSource {
  loads = 0;
  load(): Promise<FleetCatalogue> {
    this.loads++;
    return new Promise(() => {});
  }
}

class Slow implements FleetSource {
  private readonly inner = new Catalogues();
  load(): Promise<FleetCatalogue> {
    return new Promise((resolve) => setTimeout(() => resolve(this.inner.load()), 30));
  }
}

class Scripted implements RealtimeReader {
  private at = Number.NEGATIVE_INFINITY;
  private readonly rows: ForecastRow[];
  constructor(rows: ForecastRow[]) {
    this.rows = rows;
  }
  async *read(now: number) {
    const rows = this.rows.filter((row) => row.observedAt > this.at && row.observedAt <= now);
    this.at = now;
    if (rows.length > 0) yield { rows };
  }
}

function delayRow(r: StaticRun, delay: number, observedAt: number): ForecastRow {
  return {
    instanceId: r.instanceId,
    serviceDate: r.serviceDate,
    stopIndex: 1,
    sourceId: "delfi-gtfs-rt",
    observedAt,
    predictedArrival: (r.arrivals[1] as number) + delay,
    predictedDeparture: (r.departures[1] as number) + delay,
    arrivalDelay: delay,
    departureDelay: delay,
    cancelled: false,
    explicit: true,
    stopPlaceId: r.stopPlaces[1] as string,
  };
}

interface SetupOptions {
  readonly source?: FleetSource;
  readonly awaitVehicles?: boolean;
  readonly readTimeoutMs?: number;
  readonly firstVehicleWaitMs?: number;
  readonly onError?: (error: unknown) => void;
  readonly reader?: RealtimeReader;
  readonly sink?: Sink;
  readonly keys?: MemoryKeyStore;
}

function setup(runs: StaticRun[], options: SetupOptions = {}) {
  const catalogues = new Catalogues();
  const vehicles = new VehicleIdentities(options.source ?? catalogues, {
    refreshS: 600,
    ...(options.readTimeoutMs ? { readTimeoutMs: options.readTimeoutMs } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
  });
  const sink = options.sink ?? new Sink();
  const engine = new LiveEngine({
    timetable: new Timetable(runs),
    reader: options.reader ?? silent,
    keys: options.keys ?? new MemoryKeyStore(1),
    sink,
    shapeEpoch: 1,
    firstSequence: 10,
    vehicles,
    awaitVehicles: options.awaitVehicles ?? true,
    ...(options.firstVehicleWaitMs === undefined
      ? {}
      : { firstVehicleWaitMs: options.firstVehicleWaitMs }),
  });
  return { engine, sink, catalogues, vehicles };
}

function lastKeyframe(sink: Sink) {
  const keys = [...sink.objects.keys()].filter((path) => path.startsWith("k/"));
  return frameToObject(decodeKeyframe(sink.objects.get(keys.at(-1) as string) as Uint8Array));
}

describe("LiveEngine vehicles", () => {
  it("writes each trip's series, operator and units into 1.3 frames", async () => {
    const { engine, sink } = setup([run(1), run(2, { line: "99", operatorId: null })]);
    for (let now = T - 300; now <= T + 120; now++) await engine.tick(now);
    const trips = lastKeyframe(sink).trips;
    expect(trips.map((t) => [t.series, t.operator, t.units])).toEqual([
      ["db-412", "db-fernverkehr-ag", null],
      [null, null, null],
    ]);
  });

  it("sends a trip again when a later read changes its vehicle, and keeps the chain", async () => {
    const { engine, sink, catalogues } = setup([run(1)]);
    for (let now = T - 300; now <= T; now++) await engine.tick(now);
    catalogues.observations = [
      {
        serviceDate: "2026-10-25",
        trainNumber: "501",
        operatorId: "db-fernverkehr-ag",
        seriesId: "db-403",
        units: 2,
        cars: 16,
        lengthMetres: 400,
        sourceId: "bahn-vehicle-sequence",
        observedAt: (T - 3600) * 1000,
      },
    ];
    const before = sink.objects.size;
    for (let now = T + 1; now <= T + 700; now++) await engine.tick(now);
    expect(catalogues.loads).toBe(2);
    const deltas = [...sink.objects.keys()]
      .slice(before)
      .filter((path) => path.startsWith("d/"))
      .map((path) => frameToObject(decodeDelta(sink.objects.get(path) as Uint8Array)));
    const changed = deltas.flatMap((delta) => delta.trips).find((t) => t.series === "db-403");
    expect(changed).toMatchObject({ series: "db-403", units: 2 });
    expect(lastKeyframe(sink).trips[0]).toMatchObject({ series: "db-403", units: 2 });
    const report = await checkChain(sink.reader(), sink.heads, { clients: 10, seed: 3 });
    expect(report.mismatches).toBe(0);
    expect(report.chainErrors).toEqual([]);
    expect(report.keyframeComparisons).toBeGreaterThan(0);
  });

  it("keeps ticking and publishing when a live run's vehicle read never answers", async () => {
    const source = new Hung();
    const errors: unknown[] = [];
    const { engine, sink } = setup([run(1)], {
      source,
      awaitVehicles: false,
      readTimeoutMs: 20,
      onError: (error) => errors.push(error),
    });
    for (let now = T - 300; now <= T + 60; now++) await engine.tick(now);
    expect(lastKeyframe(sink).trips.map((t) => [t.series, t.operator])).toEqual([
      [null, "db-fernverkehr-ag"],
    ]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(errors).toHaveLength(1);
    for (let now = T + 61; now <= T + 700; now++) await engine.tick(now);
    expect(source.loads).toBe(2);
  });

  it("lets a render wait for a hung read only until the read timeout", async () => {
    const source = new Hung();
    const { engine } = setup([run(1)], { source, awaitVehicles: true, readTimeoutMs: 20 });
    const started = Date.now();
    await engine.tick(T - 300);
    await engine.tick(T - 299);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(source.loads).toBe(1);
  });

  it("starts a live chain with the series when the first read answers within the first wait", async () => {
    const { engine, sink } = setup([run(1), run(2)], {
      source: new Slow(),
      awaitVehicles: false,
      firstVehicleWaitMs: 1000,
    });
    for (let now = T - 300; now <= T + 120; now++) await engine.tick(now);
    const frames = [...sink.objects.entries()].map(([path, bytes]) =>
      frameToObject(path.startsWith("k/") ? decodeKeyframe(bytes) : decodeDelta(bytes)),
    );
    const sent = frames.flatMap((frame) => frame.trips);
    expect(sent.length).toBeGreaterThan(0);
    expect(new Set(sent.map((t) => t.series))).toEqual(new Set(["db-412"]));
  });

  it("keeps a restored trip's vehicle until the first read after a restart applies", async () => {
    const runs = [run(1)];
    const sink = new Sink();
    const keys = new MemoryKeyStore(1);
    const first = setup(runs, { sink, keys }).engine;
    for (let now = T - 300; now <= T + 300; now++) await first.tick(now);
    const head = sink.latestHead as Head;
    const chain: RestoredChain = {
      sequence: head.sequence,
      keyframeSequence: head.keyframeSequence,
      oldestSequence: head.oldestSequence,
      timetableVersion: head.timetableVersion,
      trips: new Map(first.currentState),
    };
    const before = sink.objects.size;
    const second = setup(runs, {
      sink,
      keys,
      source: new Hung(),
      awaitVehicles: false,
      firstVehicleWaitMs: 10,
      reader: new Scripted([delayRow(runs[0] as StaticRun, 240, T + 320)]),
    }).engine;
    await second.restore(chain);
    for (let now = T + 301; now <= T + 400; now++) await second.tick(now);
    const resent = [...sink.objects.keys()]
      .slice(before)
      .filter((path) => path.startsWith("d/"))
      .flatMap((path) => frameToObject(decodeDelta(sink.objects.get(path) as Uint8Array)).trips);
    expect(resent.length).toBeGreaterThan(0);
    expect(resent.every((t) => t.series === "db-412")).toBe(true);
    const report = await checkChain(sink.reader(), sink.heads, { clients: 10, seed: 5 });
    expect(report.mismatches).toBe(0);
    expect(report.chainErrors).toEqual([]);
  });
});
