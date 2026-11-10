import type { LonLat } from "@gerlines/geo";
import { decodeHead, type Head, type PackSets } from "@gerlines/live-frame";
import { describe, expect, it } from "vitest";
import { checkChain } from "../evidence/chain-check.ts";
import type { HeadEntry } from "../evidence/continuity.ts";
import { FrameClient, sameState } from "../evidence/frame-client.ts";
import type { GeometryGap, StaticRun } from "../model.ts";
import type { RealtimeReader } from "../realtime/readers.ts";
import type { ForecastRow } from "../realtime/store.ts";
import type { FeedVersionInfo, TimetableSource } from "../timetable/loader.ts";
import type { DetailPort, LiveInstanceState, LiveTickUpdate } from "./detail-port.ts";
import {
  ENTRY_LEAD_S,
  type EngineOptions,
  type FrameSink,
  LiveEngine,
  type RestoredChain,
  SWITCH_COVERAGE_FLOOR,
  SWITCH_RUNS_FLOOR,
  VERSIONS_REFRESH_S,
  type VersionDecision,
} from "./engine.ts";
import { MemoryKeyStore } from "./keys.ts";

/** 2026-10-25T10:00:00Z, a Sunday (CET from 01:00Z that day). */
const T = 1_792_922_400;

function run(
  id: number,
  start: number,
  extra: Partial<StaticRun> = {},
  stops = 3,
  leg = 600,
): StaticRun {
  const arrivals = Float64Array.from(
    { length: stops },
    (_, j) => start + j * (leg + 60) - (j === 0 ? 0 : 60),
  );
  const departures = Float64Array.from({ length: stops }, (_, j) => start + j * (leg + 60));
  return {
    instanceId: `00000000-0000-5000-8000-${String(id).padStart(12, "0")}`,
    serviceDate: "2026-10-25",
    feedVersionId: 1,
    tripKey: `t${id}`,
    category: "reg",
    categoryCode: "reg",
    foreign: false,
    line: `RB ${id}`,
    trainNumber: 1000 + id,
    shortName: String(1000 + id),
    operatorId: null,
    patternId: `p${id}`,
    stopPlaces: Array.from({ length: stops }, (_, j) => `place-${id}-${j}`),
    arrivals,
    departures,
    passThrough: new Uint8Array(stops),
    shape: {
      shapeNo: 100 + id,
      hash: "cd".repeat(32),
      length: stops * 10_000,
      stopArcs: Float64Array.from({ length: stops }, (_, j) => 500 + j * 9_000),
      qaStatus: "pass",
    },
    gap: null,
    ...extra,
  };
}

class FakeTimetable implements TimetableSource {
  private readonly byVersion: Map<number, StaticRun[]>;
  private readonly versionList: FeedVersionInfo[];
  private readonly coverage: ReadonlyMap<number, number>;
  private readonly coordinates: ReadonlyMap<string, LonLat>;
  coordinateReads = 0;

  constructor(
    byVersion: Map<number, StaticRun[]>,
    versionList: FeedVersionInfo[],
    coverage: ReadonlyMap<number, number> = new Map(),
    coordinates: ReadonlyMap<string, LonLat> = new Map(),
  ) {
    this.byVersion = byVersion;
    this.versionList = versionList;
    this.coverage = coverage;
    this.coordinates = coordinates;
  }

  async versions() {
    return this.versionList;
  }
  async runsOn(feedVersionId: number, serviceDate: string) {
    return (this.byVersion.get(feedVersionId) ?? []).filter((r) => r.serviceDate === serviceDate);
  }
  async shapeCoverage(feedVersionId: number, serviceDate: string) {
    return {
      coverage: this.coverage.get(feedVersionId) ?? 1,
      runs: (await this.runsOn(feedVersionId, serviceDate)).length,
    };
  }
  async placeCoordinates() {
    this.coordinateReads++;
    return this.coordinates;
  }
}

class ScriptedReader implements RealtimeReader {
  private at = 0;
  private readonly rows: ForecastRow[];

  constructor(rows: ForecastRow[]) {
    this.rows = rows;
  }
  async *read(now: number) {
    const out = this.rows.filter((row) => row.observedAt > this.at && row.observedAt <= now);
    this.at = now;
    for (let i = 0; i < out.length; i += 2) yield { rows: out.slice(i, i + 2) };
  }
}

class MemorySink implements FrameSink {
  readonly objects = new Map<string, Uint8Array>();
  readonly heads: HeadEntry[] = [];
  latest: Head | null = null;
  async object(kind: "k" | "d", sequence: number, bytes: Uint8Array) {
    const path = `${kind}/${sequence}.bin`;
    if (this.objects.has(path)) throw new Error(`${path} written twice`);
    this.objects.set(path, bytes);
  }
  async head(bytes: Uint8Array, head: Head) {
    this.latest = decodeHead(bytes);
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

const V1: FeedVersionInfo = {
  feedVersionId: 1,
  publishedOn: "2026-10-19",
  validFrom: null,
  validTo: null,
};

function delayRow(r: StaticRun, stopIndex: number, delay: number, observedAt: number): ForecastRow {
  return {
    instanceId: r.instanceId,
    serviceDate: r.serviceDate,
    stopIndex,
    sourceId: "delfi-gtfs-rt",
    observedAt,
    predictedArrival: (r.arrivals[stopIndex] as number) + delay,
    predictedDeparture: (r.departures[stopIndex] as number) + delay,
    arrivalDelay: delay,
    departureDelay: delay,
    cancelled: false,
    explicit: true,
    stopPlaceId: r.stopPlaces[stopIndex] as string,
  };
}

function engineFor(
  runs: StaticRun[],
  rows: ForecastRow[] = [],
  sink = new MemorySink(),
  keys = new MemoryKeyStore(1),
  versions: FeedVersionInfo[] = [V1],
  byVersion = new Map([[1, runs]]),
  extra: Partial<EngineOptions> = {},
) {
  const engine = new LiveEngine({
    timetable: new FakeTimetable(byVersion, versions),
    reader: new ScriptedReader(rows),
    keys,
    sink,
    shapeEpoch: 1,
    firstSequence: 500,
    ...extra,
  });
  return { engine, sink, keys };
}

async function runFor(engine: LiveEngine, from: number, to: number, step = 1) {
  for (let now = from; now <= to; now += step) await engine.tick(now);
}

describe("LiveEngine", () => {
  it("starts with a keyframe without a delta, then deltas at most every 2 s and keyframes every 30 s", async () => {
    const runs = Array.from({ length: 6 }, (_, i) => run(i + 1, T + 60 * i));
    const { engine, sink } = engineFor(runs);
    await runFor(engine, T - 300, T + 900);
    expect(sink.heads[0]).toEqual([T - 300, 500, 500, 501, 1]);
    expect(sink.objects.has("d/500.bin")).toBe(false);
    const deltas = [...sink.objects.keys()]
      .filter((p) => p.startsWith("d/"))
      .map((p) => Number(p.slice(2, -4)));
    expect(deltas.length).toBeGreaterThanOrEqual(5);
    const times = sink.heads
      .filter((h, i) => i > 0 && h[1] !== (sink.heads[i - 1] as HeadEntry)[1])
      .map((h) => h[0]);
    for (let i = 1; i < times.length; i++)
      expect((times[i] as number) - (times[i - 1] as number)).toBeGreaterThanOrEqual(2);
    const keyframes = [...new Set(sink.heads.map((h) => h[2]))];
    expect(keyframes.length).toBeGreaterThan(1);
  });

  it("keeps the chain: clients joining at random heads always equal the keyframes", async () => {
    const runs = Array.from({ length: 12 }, (_, i) => run(i + 1, T + 120 * i));
    const rows = runs.flatMap((r, i) => [
      delayRow(r, 1, 60 * (i % 4), T + 100 * i),
      delayRow(r, 2, 90, T + 100 * i + 400),
    ]);
    const { engine, sink } = engineFor(runs, rows);
    await runFor(engine, T - 600, T + 3600);
    const result = await checkChain(sink.reader(), sink.heads, { clients: 25, seed: 3 });
    expect(result).toMatchObject({ mismatches: 0, chainErrors: [], finalStatesEqual: true });
    expect(result.keyframeComparisons).toBeGreaterThan(10);
    const client = new FrameClient(sink.reader());
    await client.follow(sink.latest as Head);
    expect(sameState(client.state, engine.currentState)).toBe(true);
  });

  it("lets a train in 10 min before its departure and out 30 s after its arrival", async () => {
    const r = run(1, T + 1200);
    const { engine } = engineFor([r]);
    await engine.tick(T + 1200 - ENTRY_LEAD_S - 1);
    await engine.tick(T + 1200 - ENTRY_LEAD_S + 1);
    await engine.tick(T + 1200 - ENTRY_LEAD_S + 3);
    expect(engine.currentState.size).toBe(1);
    const end = r.arrivals[2] as number;
    await runFor(engine, end + 25, end + 29);
    expect(engine.currentState.size).toBe(1);
    await runFor(engine, end + 30, end + 34);
    expect(engine.currentState.size).toBe(0);
  });

  it("counts trains without track geometry and cancelled trains in the head instead of drawing them", async () => {
    const gap: GeometryGap = "low_quality";
    const drawn = run(1, T);
    const untracked = run(2, T, { gap, category: "sbahn", categoryCode: "sbahn" });
    const cancelled = run(3, T);
    const rows = [0, 1, 2].map((j) => ({ ...delayRow(cancelled, j, 0, T - 700), cancelled: true }));
    const { engine, sink } = engineFor([drawn, untracked, cancelled], rows);
    await runFor(engine, T - 600, T + 30);
    expect(engine.currentState.size).toBe(1);
    const counts = sink.latest?.counts ?? [];
    expect(counts).toContainEqual({ metric: "running", category: null, count: 1 });
    expect(counts).toContainEqual({ metric: "untracked", category: null, count: 1 });
    expect(counts).toContainEqual({ metric: "untracked", category: "sbahn", count: 1 });
    expect(counts).toContainEqual({ metric: "cancelled", category: null, count: 1 });
    expect(counts).toContainEqual({ metric: "realtime", category: null, count: 0 });
  });

  it("counts a late train without track geometry until its expected last arrival", async () => {
    const late = run(2, T, { gap: "no_shape" });
    const lastArrival = late.arrivals[2] as number;
    const { engine, sink } = engineFor([late], [delayRow(late, 2, 300, T - 700)]);
    const untracked = () =>
      sink.latest?.counts?.find((c) => c.metric === "untracked" && c.category === null)?.count;
    await runFor(engine, T - 600, lastArrival + 40, 10);
    expect(untracked()).toBe(1);
    await runFor(engine, lastArrival + 400, lastArrival + 410, 10);
    expect(untracked()).toBe(0);
  });

  it("takes a renamed stop place only within 150 m of the stop, by the timetable's coordinates", async () => {
    const r = run(1, T);
    const coordinates = new Map([
      ["place-1-1", { lon: 8, lat: 50 }],
      ["near", { lon: 8, lat: 50.00054 }],
      ["far", { lon: 8, lat: 50.018 }],
    ]);
    const renamedAt = async (place: string) => {
      const timetable = new FakeTimetable(new Map([[1, [r]]]), [V1], new Map(), coordinates);
      const engine = new LiveEngine({
        timetable,
        reader: new ScriptedReader([{ ...delayRow(r, 1, 120, T - 700), stopPlaceId: place }]),
        keys: new MemoryKeyStore(1),
        sink: new MemorySink(),
        shapeEpoch: 1,
        firstSequence: 500,
      });
      await runFor(engine, T - 600, T + 60, 10);
      return { plan: engine.counters.plan, reads: timetable.coordinateReads };
    };
    const near = await renamedAt("near");
    expect(near.plan.placesRenamed).toBeGreaterThan(0);
    expect(near.plan.placeMismatches).toBe(0);
    expect(near.reads).toBe(1);
    const far = await renamedAt("far");
    expect(far.plan.placesRenamed).toBe(0);
    expect(far.plan.placeMismatches).toBeGreaterThan(0);
  });

  it("reads the place coordinates again only when the version list changes", async () => {
    const r = run(1, T);
    const list = [V1];
    const timetable = new FakeTimetable(new Map([[1, [r]]]), list);
    const engine = new LiveEngine({
      timetable,
      reader: new ScriptedReader([]),
      keys: new MemoryKeyStore(1),
      sink: new MemorySink(),
      shapeEpoch: 1,
      firstSequence: 500,
    });
    await runFor(engine, T - 600, T - 600 + 2 * VERSIONS_REFRESH_S, 30);
    expect(timetable.coordinateReads).toBe(1);
    list.push({ ...V1, feedVersionId: 2, publishedOn: "2026-10-24" });
    await runFor(engine, T - 570 + 2 * VERSIONS_REFRESH_S, T - 600 + 4 * VERSIONS_REFRESH_S, 30);
    expect(timetable.coordinateReads).toBe(2);
  });

  it("is deterministic: the same inputs give the same bytes", async () => {
    const runs = Array.from({ length: 8 }, (_, i) => run(i + 1, T + 90 * i));
    const rows = runs.map((r, i) => delayRow(r, 1, 45 * i, T + 30 * i));
    const a = engineFor(runs, rows);
    const b = engineFor(runs, rows);
    await runFor(a.engine, T - 600, T + 1800);
    await runFor(b.engine, T - 600, T + 1800);
    expect([...a.sink.objects.keys()]).toEqual([...b.sink.objects.keys()]);
    for (const [path, bytes] of a.sink.objects) expect(b.sink.objects.get(path)).toEqual(bytes);
  });

  it("continues a restored chain after a restart and keeps trip keys", async () => {
    const runs = Array.from({ length: 5 }, (_, i) => run(i + 1, T + 60 * i));
    const sink = new MemorySink();
    const keys = new MemoryKeyStore(1);
    const first = engineFor(runs, [], sink, keys).engine;
    await runFor(first, T - 600, T + 300);
    const before = new Map(first.currentState);
    const head = sink.latest as Head;
    const chain: RestoredChain = {
      sequence: head.sequence,
      keyframeSequence: head.keyframeSequence,
      oldestSequence: head.oldestSequence,
      timetableVersion: head.timetableVersion,
      trips: before,
    };
    const second = engineFor(runs, [], sink, keys).engine;
    await second.restore(chain);
    await runFor(second, T + 301, T + 900);
    expect(sink.objects.has(`d/${head.sequence + 1}.bin`)).toBe(true);
    const result = await checkChain(sink.reader(), sink.heads, { clients: 20, seed: 11 });
    expect(result).toMatchObject({ mismatches: 0, chainErrors: [], finalStatesEqual: true });
    for (const key of before.keys()) {
      if (second.currentState.has(key))
        expect(second.currentState.get(key)?.trainNumber).toBe(before.get(key)?.trainNumber);
    }
  });

  it("switches the timetable at 03:00 local with a keyframe without delta and carries running trains over", async () => {
    const night = Date.parse("2026-10-27T02:00:00Z") / 1000;
    const lateRun = run(1, night - 1200, { serviceDate: "2026-10-27" }, 3, 1200);
    const v2Run = { ...run(2, night + 1200, { serviceDate: "2026-10-27", feedVersionId: 2 }) };
    const sameTrainV2 = { ...lateRun, feedVersionId: 2, tripKey: "t1-v2" };
    const versions: FeedVersionInfo[] = [
      V1,
      { feedVersionId: 2, publishedOn: "2026-10-19", validFrom: null, validTo: null },
    ];
    const byVersion = new Map([
      [1, [lateRun]],
      [2, [sameTrainV2, v2Run]],
    ]);
    const sink = new MemorySink();
    const engine = new LiveEngine({
      timetable: new FakeTimetable(byVersion, [V1]),
      reader: new ScriptedReader([]),
      keys: new MemoryKeyStore(1),
      sink,
      shapeEpoch: 1,
      firstSequence: 500,
    });
    await runFor(engine, night - 1800, night - 1);
    expect(engine.timetableVersion).toBe(1);
    const keyBefore = [...engine.currentState.keys()];
    (engine as unknown as { options: { timetable: TimetableSource } }).options.timetable =
      new FakeTimetable(byVersion, versions);
    await runFor(engine, night, night + 5);
    expect(engine.timetableVersion).toBe(2);
    expect([...engine.currentState.keys()]).toEqual(expect.arrayContaining(keyBefore));
    await runFor(engine, night + 6, night + 1800);
    const switchHead = sink.heads.find((h) => h[4] === 2) as HeadEntry;
    expect(switchHead[2]).toBe(switchHead[1]);
    expect(switchHead[3]).toBe(switchHead[1] + 1);
    expect(sink.objects.has(`d/${switchHead[1]}.bin`)).toBe(false);
    const result = await checkChain(sink.reader(), sink.heads, { clients: 20, seed: 5 });
    expect(result).toMatchObject({ mismatches: 0, chainErrors: [], finalStatesEqual: true });
  });
});

describe("LiveEngine timetable switch coverage", () => {
  const night = Date.parse("2026-10-27T02:00:00Z") / 1000;
  const versions: FeedVersionInfo[] = [
    V1,
    { feedVersionId: 2, publishedOn: "2026-10-26", validFrom: null, validTo: null },
  ];

  async function engineAfterNight(
    coverage: Map<number, number>,
    onVersionDecision?: (decision: VersionDecision) => void,
    byVersion = new Map([
      [1, [run(1, night - 1200, { serviceDate: "2026-10-27" }, 3, 1200)]],
      [2, [run(2, night + 1200, { serviceDate: "2026-10-27", feedVersionId: 2 })]],
    ]),
    pinnedVersion?: number,
  ): Promise<LiveEngine> {
    const engine = new LiveEngine({
      timetable: new FakeTimetable(byVersion, [V1], coverage),
      reader: new ScriptedReader([]),
      keys: new MemoryKeyStore(1),
      sink: new MemorySink(),
      shapeEpoch: 1,
      firstSequence: 500,
      ...(onVersionDecision ? { onVersionDecision } : {}),
      ...(pinnedVersion === undefined ? {} : { pinnedVersion }),
    });
    await runFor(engine, night - 1800, night - 1);
    (engine as unknown as { options: { timetable: TimetableSource } }).options.timetable =
      new FakeTimetable(byVersion, versions, coverage);
    await runFor(engine, night, night + 5);
    return engine;
  }

  async function versionAfterNight(
    coverage: Map<number, number>,
    onVersionDecision?: (decision: VersionDecision) => void,
  ): Promise<number> {
    return (await engineAfterNight(coverage, onVersionDecision)).timetableVersion;
  }

  it("never takes a version with full coverage but half the active version's runs today", async () => {
    const decisions: VersionDecision[] = [];
    const engine = await engineAfterNight(
      new Map([
        [1, 1],
        [2, 1],
      ]),
      (d) => decisions.push(d),
      new Map([
        [
          1,
          [
            run(1, night - 1200, { serviceDate: "2026-10-27" }, 3, 1200),
            run(3, night + 1200, { serviceDate: "2026-10-27" }),
          ],
        ],
        [2, [run(2, night + 1200, { serviceDate: "2026-10-27", feedVersionId: 2 })]],
      ]),
    );
    expect(SWITCH_RUNS_FLOOR).toBe(0.9);
    expect(engine.timetableVersion).toBe(1);
    expect(decisions.at(-1)).toMatchObject({
      activeRuns: 2,
      candidates: [{ feedVersionId: 2, coverage: 1, runs: 1 }],
      chosen: 1,
    });
  });

  it("switches to a version under 95 % that covers as much as the active one", async () => {
    expect(
      await versionAfterNight(
        new Map([
          [1, 0.9222],
          [2, 0.9215],
        ]),
      ),
    ).toBe(2);
  });

  it("stays on the active version while the new one covers clearly less", async () => {
    expect(
      await versionAfterNight(
        new Map([
          [1, 0.9222],
          [2, 0.723],
        ]),
      ),
    ).toBe(1);
  });

  it("never goes below the absolute coverage floor, even within the slack", async () => {
    expect(SWITCH_COVERAGE_FLOOR).toBe(0.9);
    expect(
      await versionAfterNight(
        new Map([
          [1, 0.91],
          [2, 0.895],
        ]),
      ),
    ).toBe(1);
  });

  it("leaves an active version that draws nothing today for the newest loaded one", async () => {
    expect(
      await versionAfterNight(
        new Map([
          [1, 0],
          [2, 0.6],
        ]),
      ),
    ).toBe(2);
  });

  it("counts a refused switch and reports when the active version was published", async () => {
    const engine = await engineAfterNight(
      new Map([
        [1, 0.9222],
        [2, 0.723],
      ]),
    );
    expect(engine.timetableVersion).toBe(1);
    expect(engine.counters.versionRefusals).toBe(1);
    expect(engine.activeVersionPublishedOn).toBe("2026-10-19");
  });

  it("takes a version the operator pinned, below every floor", async () => {
    const decisions: VersionDecision[] = [];
    const engine = await engineAfterNight(
      new Map([
        [1, 0.9222],
        [2, 0.5],
      ]),
      (d) => decisions.push(d),
      undefined,
      2,
    );
    expect(engine.timetableVersion).toBe(2);
    expect(engine.counters.versionRefusals).toBe(0);
    expect(decisions.at(-1)).toMatchObject({ reason: "pinned", chosen: 2 });
  });

  it("logs a decision that repeats every tick only once (empty list, expired with nothing newer)", async () => {
    for (const [list, reasons] of [
      [[], ["start"]],
      [[{ ...V1, validTo: "2026-10-20" }], ["start", "expired"]],
    ] as const) {
      const decisions: VersionDecision[] = [];
      const engine = new LiveEngine({
        timetable: new FakeTimetable(new Map(), [...list]),
        reader: new ScriptedReader([]),
        keys: new MemoryKeyStore(1),
        sink: new MemorySink(),
        shapeEpoch: 1,
        firstSequence: 500,
        onVersionDecision: (d) => decisions.push(d),
      });
      await runFor(engine, night - 7200, night - 7190);
      expect(decisions.map((d) => d.reason)).toEqual(reasons);
    }
  });

  it("a switch coverage set under the floor lowers the floor too", async () => {
    const byVersion = new Map([
      [1, [run(1, night - 1200, { serviceDate: "2026-10-27" }, 3, 1200)]],
      [2, [run(2, night + 1200, { serviceDate: "2026-10-27", feedVersionId: 2 })]],
    ]);
    const coverage = new Map([
      [1, 0.91],
      [2, 0.6],
    ]);
    const engine = new LiveEngine({
      timetable: new FakeTimetable(byVersion, [V1], coverage),
      reader: new ScriptedReader([]),
      keys: new MemoryKeyStore(1),
      sink: new MemorySink(),
      shapeEpoch: 1,
      firstSequence: 500,
      switchCoverage: 0.5,
    });
    await runFor(engine, night - 1800, night - 1);
    (engine as unknown as { options: { timetable: TimetableSource } }).options.timetable =
      new FakeTimetable(byVersion, versions, coverage);
    await runFor(engine, night, night + 5);
    expect(engine.timetableVersion).toBe(2);
  });

  it("reports both coverages at every nightly decision, taken or refused", async () => {
    const decisions: VersionDecision[] = [];
    await versionAfterNight(
      new Map([
        [1, 0.9222],
        [2, 0.723],
      ]),
      (d) => decisions.push(d),
    );
    expect(decisions.at(-1)).toMatchObject({
      active: 1,
      activeCoverage: 0.9222,
      chosen: 1,
      candidates: [{ feedVersionId: 2, coverage: 0.723 }],
    });
  });

  it("leaves an active version that is no longer loaded on the next tick (rollback)", async () => {
    const at = night - 7200;
    const engine = new LiveEngine({
      timetable: new FakeTimetable(
        new Map([[1, [run(1, at - 600, { serviceDate: "2026-10-27" }, 3, 1200)]]]),
        [V1],
      ),
      reader: new ScriptedReader([]),
      keys: new MemoryKeyStore(1),
      sink: new MemorySink(),
      shapeEpoch: 1,
      firstSequence: 500,
    });
    await engine.restore({
      sequence: 400,
      keyframeSequence: 390,
      oldestSequence: 300,
      timetableVersion: 2,
      trips: new Map(),
    });
    await runFor(engine, at, at + 2);
    expect(engine.timetableVersion).toBe(1);
    expect(engine.counters.versionSwitches).toBe(1);
  });

  it("leaves a version rolled back during the day within the version refresh interval, with a keyframe", async () => {
    const at = Date.parse("2026-10-27T08:00:00Z") / 1000;
    const byVersion = new Map([
      [1, [run(1, at + 1200, { serviceDate: "2026-10-27" })]],
      [2, [run(2, at + 1200, { serviceDate: "2026-10-27", feedVersionId: 2 })]],
    ]);
    const sink = new MemorySink();
    const engine = new LiveEngine({
      timetable: new FakeTimetable(byVersion, versions),
      reader: new ScriptedReader([]),
      keys: new MemoryKeyStore(1),
      sink,
      shapeEpoch: 1,
      firstSequence: 500,
    });
    await runFor(engine, at, at + 10);
    expect(engine.timetableVersion).toBe(2);
    (engine as unknown as { options: { timetable: TimetableSource } }).options.timetable =
      new FakeTimetable(byVersion, [V1]);
    await runFor(engine, at + 11, at + 11 + VERSIONS_REFRESH_S);
    expect(VERSIONS_REFRESH_S).toBe(300);
    expect(engine.timetableVersion).toBe(1);
    expect(engine.counters.versionSwitches).toBe(1);
    const switchHead = sink.heads.find((h) => h[4] === 1) as HeadEntry;
    expect(switchHead[2]).toBe(switchHead[1]);
    expect(switchHead[0]).toBeLessThanOrEqual(at + 11 + VERSIONS_REFRESH_S);
  });

  it("waits for the new version's packs at the nightly check and switches once they are marked", async () => {
    const withPacks = new Set([1]);
    const decisions: VersionDecision[] = [];
    const sink = new MemorySink();
    const byVersion = new Map([
      [1, [run(1, night - 1200, { serviceDate: "2026-10-27" }, 3, 1200)]],
      [2, [run(2, night + 1200, { serviceDate: "2026-10-27", feedVersionId: 2 })]],
    ]);
    const engine = new LiveEngine({
      timetable: new FakeTimetable(byVersion, versions),
      reader: new ScriptedReader([]),
      keys: new MemoryKeyStore(1),
      sink,
      shapeEpoch: 1,
      firstSequence: 500,
      packsReady: async (version) => withPacks.has(version),
      onVersionDecision: (d) => decisions.push(d),
    });
    await runFor(engine, night - 1800, night - 1);
    expect(engine.timetableVersion).toBe(1);
    expect(decisions[0]).toMatchObject({ reason: "start", chosen: 1 });
    await runFor(engine, night, night + 5);
    expect(engine.timetableVersion).toBe(1);
    expect(engine.counters.versionRefusals).toBe(2);
    expect(decisions.at(-1)).toMatchObject({
      reason: "nightly",
      candidates: [{ feedVersionId: 2, coverage: 1, runs: 1, packs: false }],
      chosen: 1,
    });
    withPacks.add(2);
    await runFor(engine, night + 6, night + 6 + VERSIONS_REFRESH_S);
    expect(engine.timetableVersion).toBe(2);
    expect(engine.counters.versionSwitches).toBe(1);
    expect(engine.counters.versionRefusals).toBe(2);
    expect(decisions.at(-1)).toMatchObject({ reason: "packs", chosen: 2 });
    const switchHead = sink.heads.find((h) => h[4] === 2) as HeadEntry;
    expect(switchHead[2]).toBe(switchHead[1]);
  });

  it("never falls back to a version without packs when the active one is gone", async () => {
    const at = night - 7200;
    const engine = new LiveEngine({
      timetable: new FakeTimetable(
        new Map([
          [1, [run(1, at - 600, { serviceDate: "2026-10-27" }, 3, 1200)]],
          [2, [run(2, at - 600, { serviceDate: "2026-10-27", feedVersionId: 2 }, 3, 1200)]],
        ]),
        versions,
        new Map([
          [1, 0.5],
          [2, 0.5],
        ]),
      ),
      reader: new ScriptedReader([]),
      keys: new MemoryKeyStore(1),
      sink: new MemorySink(),
      shapeEpoch: 1,
      firstSequence: 500,
      packsReady: async (version) => version === 1,
    });
    await engine.restore({
      sequence: 400,
      keyframeSequence: 390,
      oldestSequence: 300,
      timetableVersion: 3,
      trips: new Map(),
    });
    await runFor(engine, at, at + 2);
    expect(engine.timetableVersion).toBe(1);
  });

  it("an expired active version gives way to a newer one, never to an older one", async () => {
    const older: FeedVersionInfo = { ...V1, feedVersionId: 3, publishedOn: "2026-10-12" };
    const expired: FeedVersionInfo = { ...V1, validTo: "2026-10-26" };
    const newer: FeedVersionInfo = { ...V1, feedVersionId: 2, publishedOn: "2026-10-26" };
    const byVersion = new Map([
      [1, [run(1, night - 1200, { serviceDate: "2026-10-27" }, 3, 1200)]],
      [2, [run(2, night + 1200, { serviceDate: "2026-10-27", feedVersionId: 2 })]],
      [3, [run(3, night + 1200, { serviceDate: "2026-10-27", feedVersionId: 3 })]],
    ]);
    const engine = new LiveEngine({
      timetable: new FakeTimetable(byVersion, [V1]),
      reader: new ScriptedReader([]),
      keys: new MemoryKeyStore(1),
      sink: new MemorySink(),
      shapeEpoch: 1,
      firstSequence: 500,
    });
    await runFor(engine, night - 1800, night - 1);
    (engine as unknown as { options: { timetable: TimetableSource } }).options.timetable =
      new FakeTimetable(
        byVersion,
        [older, expired, newer],
        new Map([
          [2, 0.5],
          [3, 1],
        ]),
      );
    await runFor(engine, night, night + 5);
    expect(engine.timetableVersion).toBe(2);
  });

  it("an expired active version stays while the newer one has no packs", async () => {
    const expired: FeedVersionInfo = { ...V1, validTo: "2026-10-26" };
    const newer: FeedVersionInfo = { ...V1, feedVersionId: 2, publishedOn: "2026-10-26" };
    const byVersion = new Map([
      [1, [run(1, night - 1200, { serviceDate: "2026-10-27" }, 3, 1200)]],
      [2, [run(2, night + 1200, { serviceDate: "2026-10-27", feedVersionId: 2 })]],
    ]);
    const engine = new LiveEngine({
      timetable: new FakeTimetable(byVersion, [V1]),
      reader: new ScriptedReader([]),
      keys: new MemoryKeyStore(1),
      sink: new MemorySink(),
      shapeEpoch: 1,
      firstSequence: 500,
      packsReady: async (version) => version === 1,
    });
    await runFor(engine, night - 1800, night - 1);
    (engine as unknown as { options: { timetable: TimetableSource } }).options.timetable =
      new FakeTimetable(byVersion, [expired, newer], new Map([[2, 0.5]]));
    await runFor(engine, night, night + 5);
    expect(engine.timetableVersion).toBe(1);
  });
});

describe("LiveEngine cold start decides as the nightly rule from the best-covered version", () => {
  const night = Date.parse("2026-10-27T02:00:00Z") / 1000;
  const v2: FeedVersionInfo = { ...V1, feedVersionId: 2, publishedOn: "2026-10-26" };
  const byVersion = () =>
    new Map([
      [1, [run(1, night - 1200, { serviceDate: "2026-10-27" }, 3, 1200)]],
      [2, [run(2, night + 1200, { serviceDate: "2026-10-27", feedVersionId: 2 })]],
    ]);

  class RunsTimetable extends FakeTimetable {
    private readonly runCounts: ReadonlyMap<number, number>;
    constructor(
      list: FeedVersionInfo[],
      coverage: ReadonlyMap<number, number>,
      runCounts: ReadonlyMap<number, number>,
    ) {
      super(byVersion(), list, coverage);
      this.runCounts = runCounts;
    }
    override async shapeCoverage(feedVersionId: number, serviceDate: string) {
      const fit = await super.shapeCoverage(feedVersionId, serviceDate);
      return { ...fit, runs: this.runCounts.get(feedVersionId) ?? fit.runs };
    }
  }

  const timetableOf = (
    list: FeedVersionInfo[],
    coverage: Map<number, number>,
    runCounts?: Map<number, number>,
  ): TimetableSource =>
    runCounts === undefined
      ? new FakeTimetable(byVersion(), list, coverage)
      : new RunsTimetable(list, coverage, runCounts);

  async function coldStart(
    coverage: Map<number, number>,
    packs: ReadonlySet<number> = new Set([1, 2]),
    decisions: VersionDecision[] = [],
    runCounts?: Map<number, number>,
    list: FeedVersionInfo[] = [V1, v2],
  ): Promise<number> {
    const engine = new LiveEngine({
      timetable: timetableOf(list, coverage, runCounts),
      reader: new ScriptedReader([]),
      keys: new MemoryKeyStore(1),
      sink: new MemorySink(),
      shapeEpoch: 1,
      firstSequence: 500,
      packsReady: async (version) => packs.has(version),
      onVersionDecision: (d) => decisions.push(d),
    });
    await runFor(engine, night + 3600, night + 3602);
    return engine.timetableVersion;
  }

  async function nightlyFrom(
    active: number,
    coverage: Map<number, number>,
    runCounts?: Map<number, number>,
  ): Promise<number> {
    const engine = new LiveEngine({
      timetable: timetableOf(active === 1 ? [V1] : [V1, v2], coverage, runCounts),
      reader: new ScriptedReader([]),
      keys: new MemoryKeyStore(1),
      sink: new MemorySink(),
      shapeEpoch: 1,
      firstSequence: 500,
      packsReady: async () => true,
      ...(active === 2 ? { pinnedVersion: 2 } : {}),
    });
    await runFor(engine, night - 1800, night - 1799);
    const options = engine as unknown as {
      options: { timetable: TimetableSource; pinnedVersion?: number };
    };
    delete options.options.pinnedVersion;
    options.options.timetable = timetableOf([V1, v2], coverage, runCounts);
    await runFor(engine, night, night + 5);
    return engine.timetableVersion;
  }

  it("takes the older version at floor 0.90 when the newer one is under it (2026-11-07 numbers)", async () => {
    const decisions: VersionDecision[] = [];
    const chosen = await coldStart(
      new Map([
        [1, 0.911],
        [2, 0.8912],
      ]),
      new Set([1, 2]),
      decisions,
    );
    expect(chosen).toBe(1);
    expect(decisions[0]).toMatchObject({
      reason: "start",
      active: 0,
      reference: 1,
      activeCoverage: 0.911,
      floor: SWITCH_COVERAGE_FLOOR,
      candidates: [{ feedVersionId: 2, coverage: 0.8912 }],
      chosen: 1,
    });
  });

  it("takes the newer version within the slack of the better-covered older one (2026-11-06 numbers)", async () => {
    const decisions: VersionDecision[] = [];
    const chosen = await coldStart(
      new Map([
        [1, 0.9222],
        [2, 0.9046],
      ]),
      new Set([1, 2]),
      decisions,
    );
    expect(chosen).toBe(2);
    expect(decisions[0]?.floor).toBeCloseTo(0.9022, 10);
    expect(decisions[0]).toMatchObject({ reference: 1, chosen: 2 });
  });

  it("measures the reference only among versions with packs", async () => {
    expect(
      await coldStart(
        new Map([
          [1, 0.95],
          [2, 0.8],
        ]),
        new Set([2]),
      ),
    ).toBe(2);
  });

  it("falls back to the newest version with packs only when every coverage is 0", async () => {
    expect(
      await coldStart(
        new Map([
          [1, 0],
          [2, 0],
        ]),
      ),
    ).toBe(2);
  });

  it.each([
    [0.911, 0.8912],
    [0.9222, 0.9046],
    [0.9222, 0.9215],
    [0.9222, 0.723],
    [0.91, 0.895],
    [0.97, 0.96],
    [0.96, 0.97],
    [0.9, 0.93],
    [0.93, 0.912],
    [0.85, 0.84],
  ])(
    "cold start equals the nightly choice from the older version (v1 %f, v2 %f)",
    async (c1, c2) => {
      const coverage = new Map([
        [1, c1],
        [2, c2],
      ]);
      expect(await coldStart(coverage)).toBe(await nightlyFrom(1, coverage));
    },
  );

  it.each([
    ["a partial upload", 0.93, 30_000, 0.94, 8_000],
    ["a tiny fully shaped feed", 0.92, 30_000, 1, 100],
    ["a newer version just under the runs floor", 0.93, 30_000, 0.95, 26_999],
  ])(
    "takes no reference under the runs floor of the largest version (%s)",
    async (_name, c1, r1, c2, r2) => {
      const coverage = new Map([
        [1, c1],
        [2, c2],
      ]);
      const runCounts = new Map([
        [1, r1],
        [2, r2],
      ]);
      const decisions: VersionDecision[] = [];
      expect(await coldStart(coverage, new Set([1, 2]), decisions, runCounts)).toBe(1);
      expect(decisions[0]).toMatchObject({ reference: 1, chosen: 1, runsFloor: 0.9 * r1 });
      expect(await nightlyFrom(1, coverage, runCounts)).toBe(1);
    },
  );

  it("takes the newer version as reference when its runs reach the floor of the largest", async () => {
    const decisions: VersionDecision[] = [];
    const chosen = await coldStart(
      new Map([
        [1, 0.93],
        [2, 0.94],
      ]),
      new Set([1, 2]),
      decisions,
      new Map([
        [1, 30_000],
        [2, 27_000],
      ]),
    );
    expect(chosen).toBe(2);
    expect(decisions[0]).toMatchObject({ reference: 2, chosen: 2 });
  });

  it("measures the runs floor among versions at the coverage floor, so a bigger feed with few shapes keeps the reference", async () => {
    const coverage = new Map([
      [1, 0.95],
      [2, 0.8],
    ]);
    const runCounts = new Map([
      [1, 10_000],
      [2, 11_500],
    ]);
    const decisions: VersionDecision[] = [];
    expect(await coldStart(coverage, new Set([1, 2]), decisions, runCounts)).toBe(1);
    expect(decisions[0]).toMatchObject({ reference: 1, chosen: 1 });
    expect(await nightlyFrom(1, coverage, runCounts)).toBe(1);
  });

  it("measures the runs floor only among versions with packs", async () => {
    const decisions: VersionDecision[] = [];
    const chosen = await coldStart(
      new Map([
        [1, 0.93],
        [2, 0.94],
      ]),
      new Set([2]),
      decisions,
      new Map([
        [1, 30_000],
        [2, 8_000],
      ]),
    );
    expect(chosen).toBe(2);
    expect(decisions[0]).toMatchObject({ reference: 2 });
  });

  it("breaks a coverage tie toward the newer version", async () => {
    const decisions: VersionDecision[] = [];
    const coverage = new Map([
      [1, 0.93],
      [2, 0.93],
    ]);
    const runCounts = new Map([
      [1, 30_000],
      [2, 29_000],
    ]);
    expect(await coldStart(coverage, new Set([1, 2]), decisions, runCounts)).toBe(2);
    expect(decisions[0]).toMatchObject({ reference: 2, chosen: 2 });
  });

  it("with a single version takes it as reference whatever its coverage", async () => {
    const decisions: VersionDecision[] = [];
    const chosen = await coldStart(
      new Map([[1, 0.85]]),
      new Set([1]),
      decisions,
      new Map([[1, 5]]),
      [V1],
    );
    expect(chosen).toBe(1);
    expect(decisions[0]).toMatchObject({ reference: 1, candidates: [], chosen: 1 });
  });

  it("with a better-covered newer version under 0.90 equals the nightly choice from that version", async () => {
    const coverage = new Map([
      [1, 0.85],
      [2, 0.87],
    ]);
    expect(await coldStart(coverage)).toBe(await nightlyFrom(2, coverage));
    expect(await coldStart(coverage)).toBe(2);
  });
});

class RecordingPort implements DetailPort {
  readonly updates: LiveTickUpdate[] = [];
  async publish(update: LiveTickUpdate) {
    this.updates.push(update);
  }
  statesOf(id: string): LiveInstanceState[] {
    return this.updates.flatMap((u) => u.changed.filter((s) => s.tripInstanceId === id));
  }
  removedOf(id: string): LiveInstanceState[] {
    return this.updates.flatMap((u) => u.removed.filter((s) => s.tripInstanceId === id));
  }
}

function detailEngine(
  runs: StaticRun[],
  rows: ForecastRow[],
  port: DetailPort,
  onDetailError?: (e: unknown) => void,
) {
  return new LiveEngine({
    timetable: new FakeTimetable(new Map([[1, runs]]), [V1]),
    reader: new ScriptedReader(rows),
    keys: new MemoryKeyStore(1),
    sink: new MemorySink(),
    shapeEpoch: 1,
    firstSequence: 500,
    detail: port,
    detailRetryWait: async () => {},
    ...(onDetailError ? { onDetailError } : {}),
  });
}

function progressAt(states: LiveInstanceState[], t: number): [number | null, number | null] {
  const state = states.filter((s) => s.at <= t).at(-1);
  return [state?.lastPassedIndex ?? null, state?.nextIndex ?? null];
}

class CountingTimetable extends FakeTimetable {
  coverageCalls = 0;
  override async shapeCoverage(feedVersionId: number, serviceDate: string) {
    this.coverageCalls++;
    return super.shapeCoverage(feedVersionId, serviceDate);
  }
}

describe("LiveEngine expired or restored version waiting for packs", () => {
  const night = Date.parse("2026-10-27T02:00:00Z") / 1000;
  const expired: FeedVersionInfo = { ...V1, validTo: "2026-10-26" };
  const newer: FeedVersionInfo = { ...V1, feedVersionId: 2, publishedOn: "2026-10-26" };
  const byVersion = new Map([
    [1, [run(1, night - 1200, { serviceDate: "2026-10-27" }, 3, 1200)]],
    [2, [run(2, night + 1200, { serviceDate: "2026-10-27", feedVersionId: 2 })]],
    [3, [run(3, night + 1200, { serviceDate: "2026-10-27", feedVersionId: 3 })]],
  ]);

  function packEngine(withPacks: Set<number>, counts: { packs: number }) {
    return new LiveEngine({
      timetable: new FakeTimetable(byVersion, [V1]),
      reader: new ScriptedReader([]),
      keys: new MemoryKeyStore(1),
      sink: new MemorySink(),
      shapeEpoch: 1,
      firstSequence: 500,
      packsReady: async (version) => {
        counts.packs++;
        return withPacks.has(version);
      },
    });
  }

  function setTimetable(engine: LiveEngine, timetable: TimetableSource): void {
    (engine as unknown as { options: { timetable: TimetableSource } }).options.timetable =
      timetable;
  }

  it("decides an expired version waiting for packs again only at a version list read", async () => {
    const withPacks = new Set([1]);
    const counts = { packs: 0 };
    const engine = packEngine(withPacks, counts);
    await runFor(engine, night - 1800, night - 1);
    const timetable = new CountingTimetable(byVersion, [expired, newer]);
    setTimetable(engine, timetable);
    counts.packs = 0;
    await runFor(engine, night, night + 599);
    expect(engine.timetableVersion).toBe(1);
    expect(timetable.coverageCalls).toBeLessThanOrEqual(2);
    expect(counts.packs).toBeLessThanOrEqual(4);
    withPacks.add(2);
    await runFor(engine, night + 600, night + 600 + VERSIONS_REFRESH_S);
    expect(engine.timetableVersion).toBe(2);
    expect(engine.counters.versionSwitches).toBe(1);
  });

  it("an expired version never gives way to an older one, with or without a pack gate", async () => {
    const older: FeedVersionInfo = { ...V1, feedVersionId: 3, publishedOn: "2026-10-12" };
    const gated = packEngine(new Set([1, 3]), { packs: 0 });
    await runFor(gated, night - 1800, night - 1);
    setTimetable(gated, new FakeTimetable(byVersion, [older, expired, newer]));
    await runFor(gated, night, night + 5);
    expect(gated.timetableVersion).toBe(1);
    const open = engineFor([], [], new MemorySink(), new MemoryKeyStore(1), [V1], byVersion).engine;
    await runFor(open, night - 1800, night - 1);
    setTimetable(open, new FakeTimetable(byVersion, [older, expired]));
    await runFor(open, night, night + 5);
    expect(open.timetableVersion).toBe(1);
  });

  it("a restored chain decides the packs once, so a late pack build switches within the refresh interval", async () => {
    const at = Date.parse("2026-10-27T09:00:00Z") / 1000;
    const withPacks = new Set([1]);
    const decisions: VersionDecision[] = [];
    const engine = new LiveEngine({
      timetable: new FakeTimetable(byVersion, [V1, newer]),
      reader: new ScriptedReader([]),
      keys: new MemoryKeyStore(1),
      sink: new MemorySink(),
      shapeEpoch: 1,
      firstSequence: 500,
      packsReady: async (version) => withPacks.has(version),
      onVersionDecision: (d) => decisions.push(d),
    });
    await engine.restore({
      sequence: 400,
      keyframeSequence: 390,
      oldestSequence: 300,
      timetableVersion: 1,
      trips: new Map(),
    });
    await runFor(engine, at, at + 5);
    expect(engine.timetableVersion).toBe(1);
    expect(decisions).toMatchObject([
      { reason: "packs", chosen: 1, candidates: [{ feedVersionId: 2, packs: false }] },
    ]);
    withPacks.add(2);
    await runFor(engine, at + 6, at + 6 + VERSIONS_REFRESH_S);
    expect(engine.timetableVersion).toBe(2);
    expect(engine.counters.versionRefusals).toBe(0);
  });
});

describe("LiveEngine timetable switch after a train ended", () => {
  it("never lets a train it already ended back in under the new version", async () => {
    const night = Date.parse("2026-10-27T02:00:00Z") / 1000;
    const ended = run(1, night - 3000, { serviceDate: "2026-10-27" }, 3, 600);
    const renumbered: StaticRun = {
      ...ended,
      feedVersionId: 2,
      tripKey: "t1-v2",
      stopPlaces: [ended.stopPlaces[0] as string, ended.stopPlaces[2] as string],
      arrivals: Float64Array.of(ended.arrivals[0] as number, ended.arrivals[2] as number),
      departures: Float64Array.of(ended.departures[0] as number, ended.departures[2] as number),
      passThrough: new Uint8Array(2),
    };
    const late = delayRow(ended, 2, 0, night - 1200);
    const versions: FeedVersionInfo[] = [
      V1,
      { feedVersionId: 2, publishedOn: "2026-10-26", validFrom: null, validTo: null },
    ];
    const byVersion = new Map([
      [1, [ended]],
      [2, [renumbered]],
    ]);
    const port = new RecordingPort();
    const engine = new LiveEngine({
      timetable: new FakeTimetable(byVersion, [V1]),
      reader: new ScriptedReader([late]),
      keys: new MemoryKeyStore(1),
      sink: new MemorySink(),
      shapeEpoch: 1,
      firstSequence: 500,
      detail: port,
      detailRetryWait: async () => {},
    });
    await runFor(engine, night - 3600, night - 1);
    await engine.detailIdle();
    expect(port.removedOf(ended.instanceId)).toHaveLength(1);
    (engine as unknown as { options: { timetable: TimetableSource } }).options.timetable =
      new FakeTimetable(byVersion, versions);
    await runFor(engine, night, night + 120);
    await engine.detailIdle();
    expect(engine.timetableVersion).toBe(2);
    expect(port.statesOf(ended.instanceId).filter((s) => s.at >= night)).toEqual([]);
    expect(port.removedOf(ended.instanceId)).toHaveLength(1);
  });
});

describe("LiveEngine restart after a train arrived late", () => {
  it("admits a train past its schedule only while its predicted last arrival is ahead", async () => {
    const night = Date.parse("2026-10-27T02:00:00Z") / 1000;
    const arrived = run(22, night - 5460, { serviceDate: "2026-10-27" });
    const stillLate = run(23, night - 5460, { serviceDate: "2026-10-27" });
    const rows = [
      delayRow(arrived, 2, 420, night - 4000),
      delayRow(stillLate, 2, 4800, night - 4000),
    ];
    const port = new RecordingPort();
    const engine = new LiveEngine({
      timetable: new FakeTimetable(new Map([[1, [arrived, stillLate]]]), [V1]),
      reader: new ScriptedReader(rows),
      keys: new MemoryKeyStore(1),
      sink: new MemorySink(),
      shapeEpoch: 1,
      firstSequence: 500,
      detail: port,
      detailRetryWait: async () => {},
    });
    await runFor(engine, night, night + 5);
    await engine.detailIdle();
    expect(port.statesOf(arrived.instanceId)).toEqual([]);
    expect(port.removedOf(arrived.instanceId)).toEqual([]);
    expect(port.statesOf(stillLate.instanceId).length).toBeGreaterThan(0);
  });
});

describe("LiveEngine detail port", () => {
  it("reports progress by arrival at every stop and a final state on removal", async () => {
    const r = run(1, T);
    const port = new RecordingPort();
    const engine = detailEngine([r], [], port);
    await runFor(engine, T - 300, T + 1400);
    await engine.detailIdle();
    const states = port.statesOf(r.instanceId);
    expect(progressAt(states, T - 1)).toEqual([null, 0]);
    expect(progressAt(states, T + 10)).toEqual([0, 1]);
    expect(progressAt(states, T + 599)).toEqual([0, 1]);
    expect(progressAt(states, T + 620)).toEqual([1, 2]);
    expect(progressAt(states, T + 1270)).toEqual([2, null]);
    expect(states.every((s) => s.endsAt === (r.arrivals[2] as number))).toBe(true);
    const removed = port.removedOf(r.instanceId);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ lastPassedIndex: 2, nextIndex: null, key: 1 });
  });

  it("sends the source delay and progress for a train it does not draw", async () => {
    const r = run(2, T, { shape: null, gap: "no_shape", feedVersionId: 1 });
    const rows = [0, 1, 2].map((j) => delayRow(r, j, 120, T - 400));
    const port = new RecordingPort();
    const engine = detailEngine([r], rows, port);
    await runFor(engine, T - 300, T + 1500);
    await engine.detailIdle();
    const states = port.statesOf(r.instanceId);
    expect(states.length).toBeGreaterThanOrEqual(4);
    expect(states.every((s) => s.key === null && s.delaySeconds === 120)).toBe(true);
    expect(states.every((s) => s.feedVersionId === 1 && !s.geometry.available)).toBe(true);
    expect(progressAt(states, T + 119)).toEqual([null, 0]);
    expect(progressAt(states, T + 125)).toEqual([0, 1]);
    expect(progressAt(states, T + 725)).toEqual([1, 2]);
    expect(states.at(-1)?.endsAt).toBe((r.arrivals[2] as number) + 120);
  });

  it("never waits for a slow port inside a tick and merges the queued states", async () => {
    let calls = 0;
    const hanging: DetailPort = {
      publish: () => {
        calls++;
        return new Promise<void>(() => {});
      },
    };
    const runs = Array.from({ length: 4 }, (_, i) => run(i + 1, T + 60 * i));
    const engine = detailEngine(runs, [], hanging);
    const started = performance.now();
    await runFor(engine, T - 300, T + 900);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(calls).toBe(1);
    expect(engine.detailStats?.merged).toBeGreaterThan(0);
  });

  it("keeps ticking when the port fails", async () => {
    const errors: unknown[] = [];
    const failing: DetailPort = {
      publish: async () => {
        throw new Error("valkey down");
      },
    };
    const engine = detailEngine([run(1, T)], [], failing, (e) => errors.push(e));
    await runFor(engine, T - 300, T + 120, 10);
    await engine.detailIdle();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.length).toBeGreaterThan(1);
    expect(engine.detailStats?.failed).toBe(errors.length);
  });
});

function backwardSteps(states: readonly LiveInstanceState[]): string[] {
  let furthest = -1;
  const steps: string[] = [];
  for (const state of states) {
    const passed = state.lastPassedIndex ?? -1;
    if (passed < furthest)
      steps.push(`${state.at - T}: ${state.lastPassedIndex}:${state.nextIndex} after ${furthest}`);
    furthest = Math.max(furthest, passed);
  }
  return steps;
}

describe("LiveEngine progress never goes back", () => {
  it("holds a reached stop of a train it does not draw when a forecast moves that stop later", async () => {
    const r = run(4, T, { shape: null, gap: "no_shape" }, 4);
    const rows = [
      ...[0, 1, 2, 3].map((j) => delayRow(r, j, 0, T - 400)),
      ...[1, 2, 3].map((j) => delayRow(r, j, 400, T + 700)),
    ];
    const port = new RecordingPort();
    const engine = detailEngine([r], rows, port);
    await runFor(engine, T - 300, T + 2400);
    await engine.detailIdle();
    const states = [...port.statesOf(r.instanceId), ...port.removedOf(r.instanceId)];
    expect(progressAt(states, T + 650)).toEqual([1, 2]);
    expect(backwardSteps(states)).toEqual([]);
    expect(progressAt(states, T + 720)).toEqual([1, 2]);
    expect(progressAt(states, (r.arrivals[2] as number) + 400 + 5)).toEqual([2, 3]);
  });

  it("keeps the stations before a hold point passed once the train has left the hold", async () => {
    const r = run(5, T, {}, 3, 1200);
    const rows = [delayRow(r, 1, 240, T + 600)];
    const port = new RecordingPort();
    const engine = detailEngine([r], rows, port);
    await runFor(engine, T - 300, T + 3000);
    await engine.detailIdle();
    expect(engine.counters.plan.holds.hold).toBeGreaterThan(0);
    const states = [...port.statesOf(r.instanceId), ...port.removedOf(r.instanceId)];
    expect(backwardSteps(states)).toEqual([]);
    expect(progressAt(states, (r.arrivals[1] as number) + 240 + 5)).toEqual([1, 2]);
  });
});

describe("LiveEngine progress after a restart at a hold point", () => {
  it("counts the station before a restored plan's hold point as passed", async () => {
    const r = run(6, T, {}, 3, 1200);
    const sink = new MemorySink();
    const keys = new MemoryKeyStore(1);
    const first = new LiveEngine({
      timetable: new FakeTimetable(new Map([[1, [r]]]), [V1]),
      reader: new ScriptedReader([delayRow(r, 1, 240, T + 600)]),
      keys,
      sink,
      shapeEpoch: 1,
      firstSequence: 500,
    });
    await runFor(first, T - 300, T + 1390);
    expect(first.counters.plan.holds.hold).toBeGreaterThan(0);
    const head = sink.latest as Head;
    const port = new RecordingPort();
    const second = new LiveEngine({
      timetable: new FakeTimetable(new Map([[1, [r]]]), [V1]),
      reader: new ScriptedReader([delayRow(r, 1, 600, T + 1385)]),
      keys,
      sink,
      shapeEpoch: 1,
      firstSequence: 500,
      detail: port,
      detailRetryWait: async () => {},
    });
    await second.restore({
      sequence: head.sequence,
      keyframeSequence: head.keyframeSequence,
      oldestSequence: head.oldestSequence,
      timetableVersion: head.timetableVersion,
      trips: new Map(first.currentState),
    });
    await runFor(second, T + 1391, T + 1395);
    await second.detailIdle();
    const states = port.statesOf(r.instanceId);
    expect(states.length).toBeGreaterThan(0);
    expect(progressAt(states, T + 1395)).toEqual([0, 1]);
  });
});

describe("LiveEngine sink failures", () => {
  it("advances the sequence only after the object is written, so no hole is left", async () => {
    class FlakySink extends MemorySink {
      failNextDelta = false;
      override async object(kind: "k" | "d", sequence: number, bytes: Uint8Array) {
        if (kind === "d" && this.failNextDelta) {
          this.failNextDelta = false;
          throw new Error("disk full");
        }
        return super.object(kind, sequence, bytes);
      }
    }
    const sink = new FlakySink();
    const runs = Array.from({ length: 4 }, (_, i) => run(i + 1, T + 60 * i));
    const { engine } = engineFor(runs, [], sink);
    await runFor(engine, T - 700, T - 650);
    const before = engine.latestSequence;
    sink.failNextDelta = true;
    let failed = 0;
    for (let now = T - 649; now <= T - 300; now++) {
      await engine.tick(now).catch(() => failed++);
    }
    expect(failed).toBe(1);
    const deltas = [...sink.objects.keys()]
      .filter((p) => p.startsWith("d/"))
      .map((p) => Number(p.slice(2, -4)))
      .filter((sequence) => sequence > before)
      .sort((a, b) => a - b);
    expect(deltas[0]).toBe(before + 1);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas).toEqual(deltas.map((_, i) => before + 1 + i));
  });
});

describe("LiveEngine version choice", () => {
  it("takes the higher feed version id of two published on the same day, in any input order", async () => {
    const runs = [run(1, T)];
    const a: FeedVersionInfo = { ...V1, feedVersionId: 7 };
    const b: FeedVersionInfo = { ...V1, feedVersionId: 9 };
    for (const order of [
      [a, b],
      [b, a],
    ]) {
      const byVersion = new Map([
        [7, runs],
        [9, runs],
      ]);
      const { engine } = engineFor(
        runs,
        [],
        new MemorySink(),
        new MemoryKeyStore(1),
        order,
        byVersion,
      );
      await engine.tick(T - 300);
      expect(engine.timetableVersion).toBe(9);
    }
  });
});

describe("LiveEngine detail for trains it does not draw", () => {
  it("notes a growing delay between arrivals, from 15 s on", async () => {
    const r = run(3, T, { shape: null, gap: "no_shape" }, 2, 3000);
    const rows = [
      delayRow(r, 1, 60, T + 100),
      delayRow(r, 1, 70, T + 200),
      delayRow(r, 1, 300, T + 300),
      delayRow(r, 1, 600, T + 400),
    ];
    const port = new RecordingPort();
    const engine = detailEngine([r], rows, port);
    await runFor(engine, T - 300, T + 500);
    await engine.detailIdle();
    const delays = port.statesOf(r.instanceId).map((s) => s.delaySeconds);
    expect(delays).toContain(300);
    expect(delays).toContain(600);
    expect(delays).not.toContain(70);
    expect(port.statesOf(r.instanceId).at(-1)?.endsAt).toBe((r.arrivals[1] as number) + 600);
  });
});

describe("LiveEngine pack sets", () => {
  it("names the shapes of the state and of the runs it admits before a time", async () => {
    const runs = [
      run(1, T + 600),
      run(2, T + 1500),
      run(3, T + 3000),
      run(4, T + 1600, { shape: null }),
    ];
    const { engine } = engineFor(runs);
    await runFor(engine, T, T + 2);
    expect([...engine.currentState.values()].map((trip) => trip.shapeId)).toEqual([101]);
    expect(engine.shapesAhead(T + 600)).toEqual([101]);
    expect(engine.shapesAhead(T + 1500 - ENTRY_LEAD_S + 1)).toEqual([101, 102]);
    expect(engine.shapesAhead(T + 7200)).toEqual([101, 102, 103]);
  });

  it("puts the published pack sets into the head, and none without them", async () => {
    let sets: PackSets | null = null;
    const { engine, sink } = engineFor(
      [run(1, T + 600)],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      {
        packSets: () => sets,
      },
    );
    await engine.tick(T);
    expect(sink.latest?.packSets).toBeUndefined();
    sets = { epoch: 1, latest: 2_988_206, first: 2_988_205, parts: 3 };
    await engine.tick(T + 1);
    expect(sink.latest?.packSets).toEqual(sets);
  });
});

describe("LiveEngine pack sets across the 03:00 switch", () => {
  it("names the old version's shapes before the switch and the new version's after it", async () => {
    const night = Date.parse("2026-10-27T02:00:00Z") / 1000;
    const lateRun = run(1, night - 1200, { serviceDate: "2026-10-27" }, 3, 1200);
    const v2Run = run(2, night + 1200, { serviceDate: "2026-10-27", feedVersionId: 2 });
    const versions: FeedVersionInfo[] = [
      V1,
      { feedVersionId: 2, publishedOn: "2026-10-19", validFrom: null, validTo: null },
    ];
    const byVersion = new Map([
      [1, [lateRun]],
      [2, [{ ...lateRun, feedVersionId: 2, tripKey: "t1-v2" }, v2Run]],
    ]);
    const engine = new LiveEngine({
      timetable: new FakeTimetable(byVersion, [V1]),
      reader: new ScriptedReader([]),
      keys: new MemoryKeyStore(1),
      sink: new MemorySink(),
      shapeEpoch: 1,
      firstSequence: 500,
    });
    await runFor(engine, night - 300, night - 1);
    expect(engine.shapesAhead(night + 1200)).toEqual([101]);
    (engine as unknown as { options: { timetable: TimetableSource } }).options.timetable =
      new FakeTimetable(byVersion, versions);
    await runFor(engine, night, night + 5);
    expect(engine.timetableVersion).toBe(2);
    expect(engine.shapesAhead(night + 1200)).toEqual([101, 102]);
  });
});
