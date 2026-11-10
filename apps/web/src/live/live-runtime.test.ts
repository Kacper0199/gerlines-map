import { lonLatToMercator } from "@gerlines/geo";
import { decodeShapePack, encodeShapePack, shapePackToObject } from "@gerlines/live-frame";
import { describe, expect, it } from "vitest";
import { markerLiftM } from "../map/terrain/elevation.ts";
import type { Palette } from "../motion/frame.ts";
import type {
  ContinuityMessage,
  DiagnosticsMessage,
  FrameMessage,
  LiveConfig,
  LiveSelectionMessage,
  NearestMessage,
  SelectionDrawnMessage,
  StatusMessage,
  WorkerMessage,
} from "../motion/protocol.ts";
import { latOf, lonOf } from "./geometry.ts";
import {
  createLiveRuntime,
  type LiveEnvironment,
  SAFETY_POLL_MS,
  STALE_AFTER_MS,
  STALE_HEAD_RETRY_MS,
} from "./live-runtime.ts";
import type { PushSocket } from "./push-channel.ts";
import {
  delta,
  encodeHead,
  head,
  keyframe,
  ObjectStore,
  SHAPE_X0,
  SHAPE_Y,
  stop,
  straightPack,
  TIME_BASE,
  trip,
} from "./test-frames.ts";

const PALETTE: Palette = {
  fill: {
    hsr: [1, 1, 1],
    ld: [2, 2, 2],
    night: [3, 3, 3],
    rfast: [4, 4, 4],
    reg: [5, 5, 5],
    sbahn: [6, 6, 6],
    foreign: [7, 7, 7],
  },
  land: [9, 9, 9],
};
const CONFIG: LiveConfig = {
  baseUrl: "/live/v1",
  pollMs: 1000,
  timeScale: 1,
  replay: false,
  probe: false,
};
const T0 = TIME_BASE;
const RUN = [
  stop(T0, T0 + 60),
  stop(T0 + 600, T0 + 660),
  stop(T0 + 1200, T0 + 1260),
  stop(T0 + 2400),
];

interface Server {
  readonly objects: ObjectStore;
  headBytes: Uint8Array | null;
  headStatus: number;
  packs: Set<number>;
  requests: string[];
  hold: Promise<void> | null;
  headOverride?: (() => Response) | undefined;
  headHold?: Promise<void> | undefined;
  packHeights?: { readonly start: number; readonly slope: number } | undefined;
  /** URLs fetched with a deadline signal. */
  signalled: string[];
}

function bodyOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function serveHead(server: Server): Promise<Response> {
  if (server.headHold) await server.headHold;
  if (server.headOverride) return server.headOverride();
  const ready = server.headStatus === 200 && server.headBytes;
  return ready
    ? new Response(bodyOf(server.headBytes as Uint8Array), { status: 200 })
    : new Response(null, { status: server.headStatus === 200 ? 404 : server.headStatus });
}

async function serve(server: Server, url: string): Promise<Response> {
  server.requests.push(url);
  const path = url.replace("/live/v1/", "");
  if (path === "head") return serveHead(server);
  if (path.startsWith("s/")) {
    const number = Number(path.split("/")[2]?.replace(".bin", ""));
    return server.packs.has(number)
      ? new Response(bodyOf(straightPack(number, 40_000, 3, number, server.packHeights)), {
          status: 200,
        })
      : new Response(null, { status: 404 });
  }
  if (server.hold) await server.hold;
  const bytes = await server.objects.read(path);
  return bytes ? new Response(bodyOf(bytes), { status: 200 }) : new Response(null, { status: 404 });
}

class FakeSocket implements PushSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  send(): void {}

  close(): void {
    this.closed = true;
  }

  says(...lines: unknown[]): void {
    this.onmessage?.({ data: lines.map((line) => JSON.stringify(line)).join("\n") });
  }

  subscribed(): void {
    this.onopen?.();
    this.says({ id: 1, connect: { ping: 25, pong: true } }, { id: 2, subscribe: {} });
  }

  notice(seq: number, keyframe = 10, oldest = 11): void {
    this.says({
      push: { channel: "live:frames", pub: { data: { seq, keyframe, oldest, tv: 1 } } },
    });
  }

  drops(): void {
    this.closed = true;
    this.onclose?.({ code: 1006 });
  }
}

function setup(startMs = (T0 + 100) * 1000) {
  let wall = startMs;
  const posted: WorkerMessage[] = [];
  const transfers: Transferable[][] = [];
  const timers = new Map<number, { callback: () => void; atMs: number }>();
  let nextTimer = 1;
  const server: Server = {
    objects: new ObjectStore(),
    headBytes: null,
    headStatus: 200,
    packs: new Set([7]),
    requests: [],
    hold: null,
    signalled: [],
  };
  const environment: LiveEnvironment = {
    now: () => wall,
    perf: () => wall,
    post: (message, transfer) => {
      posted.push(structuredClone(message, { transfer }));
      transfers.push(transfer);
    },
    fetch: async (url, init) => {
      if (init?.signal) server.signalled.push(url);
      return serve(server, url);
    },
    setTimeout: (callback, ms) => {
      const id = nextTimer++;
      timers.set(id, { callback, atMs: wall + ms });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
  };
  const sockets: FakeSocket[] = [];
  environment.openSocket = (url) => {
    const socket = new FakeSocket(url);
    sockets.push(socket);
    return socket;
  };
  environment.random = () => 1;
  const runtime = createLiveRuntime(environment);
  const settle = async () => {
    for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    runtime,
    server,
    sockets,
    posted,
    transfers,
    settle,
    advance: (ms: number) => {
      wall += ms;
    },
    now: () => wall,
    fireTimers: async () => {
      for (const [id, timer] of [...timers]) {
        if (timer.atMs <= wall) {
          timers.delete(id);
          timer.callback();
        }
      }
      await settle();
    },
    statuses: () =>
      posted.filter((m): m is StatusMessage => m.type === "status").map((m) => m.status),
    frames: () => posted.filter((m): m is FrameMessage => m.type === "frame"),
    pending: () => timers.size,
  };
}

function publish(server: Server, sequence: number, keyframeSequence: number, oldest: number) {
  server.headBytes = encodeHead(head(sequence, keyframeSequence, oldest));
}

function seed(server: Server) {
  server.objects.putKeyframe(keyframe(10, [trip(1, { stops: RUN }), trip(2, { stops: RUN })]));
  publish(server, 10, 10, 11);
}

/** 100 ms ticks after the head poll fires that let the worker apply a removal frame (3 s). */
const TICKS_TO_APPLY_REMOVAL = 30;

describe("live runtime", () => {
  it("is loading until the first head, then draws the trains of the keyframe", async () => {
    const t = setup();
    seed(t.server);
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    expect(t.statuses().at(-1)).toMatchObject({ state: "loading", framed: false });
    await t.settle();
    t.advance(1000);
    t.runtime.handle({ type: "tick", now: 0 });
    t.runtime.handle({ type: "diagnostics" });
    const [frame] = t.frames().slice(-1);
    expect(frame?.frame.groups[0]?.count).toBe(2);
    expect(t.statuses().at(-1)).toMatchObject({
      state: "live",
      trips: 2,
      framed: true,
      error: undefined,
    });
    const diagnostics = t.posted.find((m): m is DiagnosticsMessage => m.type === "diagnostics");
    expect(diagnostics?.data).toMatchObject({ trains: 2, sequence: 10, followErrors: 0 });
    expect(diagnostics?.data.shapes.loaded).toBe(1);
    expect(t.server.signalled).toContain("/live/v1/s/3/7.bin");
  });

  it("reads the head and the keyframe at once but holds the shape packs until they are released", async () => {
    const t = setup();
    seed(t.server);
    t.runtime.handle({
      type: "init-live",
      palette: PALETTE,
      config: { ...CONFIG, holdPacks: true },
    });
    await t.settle();
    expect(t.server.requests).toContain("/live/v1/head");
    expect(t.server.requests).toContain("/live/v1/k/10.bin");
    expect(t.server.requests.filter((url) => url.includes("/s/"))).toEqual([]);
    t.runtime.handle({ type: "tick", now: 0 });
    expect(t.frames().at(-1)?.frame.groups[0]?.count ?? 0).toBe(0);

    t.runtime.handle({ type: "release-packs" });
    await t.settle();
    expect(t.server.requests.filter((url) => url.includes("/s/")).length).toBeGreaterThan(0);
    t.advance(1000);
    t.runtime.handle({ type: "tick", now: 0 });
    expect(t.frames().at(-1)?.frame.groups[0]?.count).toBe(2);
  });

  it("is not framed while the keyframe is applied but none of its trains is drawn yet", async () => {
    const t = setup();
    seed(t.server);
    t.runtime.handle({
      type: "init-live",
      palette: PALETTE,
      config: { ...CONFIG, holdPacks: true },
    });
    await t.settle();
    t.advance(1000);
    t.runtime.handle({ type: "tick", now: 0 });
    expect(t.statuses().at(-1)).toMatchObject({ trips: 0, framed: false });

    t.runtime.handle({ type: "release-packs" });
    await t.settle();
    t.advance(1000);
    t.runtime.handle({ type: "tick", now: 0 });
    expect(t.statuses().at(-1)).toMatchObject({ state: "live", trips: 2, framed: true });
  });

  it("is framed with zero trains when the keyframe holds none", async () => {
    const t = setup();
    t.server.objects.putKeyframe(keyframe(10, []));
    publish(t.server, 10, 10, 11);
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    t.advance(1000);
    t.runtime.handle({ type: "tick", now: 0 });
    expect(t.statuses().at(-1)).toMatchObject({ state: "live", trips: 0, framed: true });
  });

  it("loads the shapes of the base set the head names instead of single packs", async () => {
    const t = setup();
    t.server.objects.putKeyframe(
      keyframe(10, [trip(1, { stops: RUN }), trip(2, { stops: RUN, shapeId: 8 })]),
    );
    t.server.headBytes = encodeHead({
      ...head(10, 10, 11),
      packSets: { epoch: 3, latest: 2_995_000, first: 2_995_000, parts: 1 },
    });
    const shapes = [7, 8].flatMap(
      (number) => shapePackToObject(decodeShapePack(straightPack(number))).shapes,
    );
    t.server.objects.putRaw(
      "sets/3/b/2995000/0.bin",
      encodeShapePack({
        kind: "shapePack",
        timetableVersion: 1,
        shapeEpoch: 3,
        shapes,
        coding: "compact",
      }),
    );
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    t.advance(1000);
    t.runtime.handle({ type: "tick", now: 0 });
    expect(t.frames().at(-1)?.frame.groups[0]?.count).toBe(2);
    expect(t.server.requests.filter((url) => url.includes("/s/"))).toEqual([]);
    expect(t.server.requests).toContain("/live/v1/sets/3/b/2995000/0.bin");
    t.runtime.handle({ type: "diagnostics" });
    const diagnostics = t.posted.find((m): m is DiagnosticsMessage => m.type === "diagnostics");
    expect(diagnostics?.data.packSets).toMatchObject({
      sets: 1,
      shapes: 2,
      failures: 0,
      failuresByCode: {},
    });
    expect(diagnostics?.data.packSets?.longestSliceMs).toBeGreaterThanOrEqual(0);
    expect(t.server.signalled).toEqual(
      expect.arrayContaining([
        "/live/v1/head",
        "/live/v1/sets/3/b/2995000/0.bin",
        "/live/v1/k/10.bin",
      ]),
    );
  });

  it("answers a tick with an empty frame before the first head so the loop keeps running", () => {
    const t = setup();
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    t.runtime.handle({ type: "tick", now: 0 });
    expect(t.frames()).toHaveLength(1);
    expect(t.frames()[0]?.frame.groups).toEqual([]);
  });

  it("transfers the frame buffers", async () => {
    const t = setup();
    seed(t.server);
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    t.runtime.handle({ type: "tick", now: 0 });
    const last = t.transfers.at(-1) ?? [];
    expect(last.length).toBe(10);
  });

  it("follows later heads with deltas and polls again after the interval", async () => {
    const t = setup();
    seed(t.server);
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    t.server.objects.putDelta(delta(11, [trip(3, { stops: RUN })], [1]));
    publish(t.server, 11, 10, 11);
    t.advance(1000);
    await t.fireTimers();
    t.runtime.handle({ type: "tick", now: 0 });
    expect(t.frames().at(-1)?.frame.groups[0]?.ids).toEqual(["live:1", "live:2"]);
    for (let i = 0; i < 30; i++) {
      t.advance(100);
      t.runtime.handle({ type: "tick", now: 0 });
    }
    const lastIds = t
      .frames()
      .map((message) => message.frame.groups[0]?.ids)
      .filter((ids) => ids !== undefined)
      .at(-1);
    expect(lastIds).toEqual(["live:2", "live:3"]);
    expect(t.server.requests.filter((r) => r.includes("/d/"))).toEqual(["/live/v1/d/11.bin"]);
  });

  it("sends the stops of the selected trip with its route and again only when their times change", async () => {
    const t = setup();
    seed(t.server);
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    t.runtime.handle({ type: "select", id: "live:2" });
    const sent = () =>
      t
        .frames()
        .filter((message) => message.selectionStops)
        .map((message) => message.selectionStops);
    for (let i = 0; i < 4; i++) {
      t.advance(1000);
      t.runtime.handle({ type: "tick", now: 0 });
    }
    expect(sent()).toHaveLength(1);
    expect(sent()[0]?.arrivals[0]).toBe(T0);
    expect(t.frames().find((message) => message.selectionStops)?.selectionPath).toBeDefined();

    const later = RUN.map((entry) => ({
      ...entry,
      arrival: (entry.arrival ?? 0) + 300,
      departure: (entry.departure ?? 0) + 300,
    }));
    t.server.objects.putDelta(delta(11, [trip(2, { stops: later })]));
    publish(t.server, 11, 10, 11);
    t.advance(1000);
    await t.fireTimers();
    for (let i = 0; i < 6; i++) {
      t.advance(1000);
      t.runtime.handle({ type: "tick", now: 0 });
    }
    expect(sent()).toHaveLength(2);
    expect(sent()[1]?.arrivals[0]).toBe(T0 + 300);
    expect(
      t
        .frames()
        .filter((message) => message.selectionStops)
        .at(-1)?.selectionPath,
    ).toBeUndefined();
  });

  it("reports the replay as recorded data", async () => {
    const t = setup();
    seed(t.server);
    t.runtime.handle({
      type: "init-live",
      palette: PALETTE,
      config: { ...CONFIG, replay: true, timeScale: 10 },
    });
    await t.settle();
    expect(t.statuses().at(-1)?.state).toBe("recorded");
  });

  it("reports when the newest head arrived that moved the time, and none for a replay", async () => {
    const t = setup();
    seed(t.server);
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    const first = t.now();
    expect(t.statuses().at(-1)?.frameWallMs).toBe(first);
    t.advance(STALE_AFTER_MS / 3);
    await t.fireTimers();
    t.runtime.handle({ type: "tick", now: 0 });
    expect(t.statuses().at(-1)?.frameWallMs).toBe(first);
    publish(t.server, 11, 10, 11);
    t.advance(1000);
    await t.fireTimers();
    t.runtime.handle({ type: "tick", now: 0 });
    expect(t.statuses().at(-1)?.frameWallMs).toBe(t.now());
    const replay = setup();
    seed(replay.server);
    replay.runtime.handle({
      type: "init-live",
      palette: PALETTE,
      config: { ...CONFIG, replay: true, timeScale: 10 },
    });
    await replay.settle();
    expect(replay.statuses().at(-1)?.frameWallMs).toBeUndefined();
  });

  it("shows an error when the server is unreachable and recovers", async () => {
    const t = setup();
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    expect(t.statuses().at(-1)).toMatchObject({ state: "error", error: "upstream_unavailable" });
    seed(t.server);
    t.advance(1000);
    await t.fireTimers();
    expect(t.statuses().at(-1)?.state).toBe("live");
  });

  it("reports a head it cannot read", async () => {
    const t = setup();
    t.server.headBytes = Uint8Array.from([1, 2, 3, 4, 5, 6]);
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    expect(t.statuses().at(-1)).toMatchObject({ state: "error", error: "unreadable" });
  });

  it("says no live server runs when the head is a web page, as from a dev server without a live target", async () => {
    const t = setup();
    t.server.headOverride = () =>
      new Response("<!doctype html><html></html>", {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    expect(t.statuses().at(-1)).toMatchObject({
      state: "error",
      error: "no_live_server",
      trips: 0,
    });
    t.server.headOverride = undefined;
    seed(t.server);
    t.advance(1000);
    await t.fireTimers();
    expect(t.statuses().at(-1)?.state).toBe("live");
  });

  it("reads a head served without a content type", async () => {
    const t = setup();
    seed(t.server);
    const bytes = t.server.headBytes as Uint8Array;
    t.server.headOverride = () => {
      const response = new Response(bodyOf(bytes), { status: 200 });
      response.headers.delete("Content-Type");
      return response;
    };
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    expect(t.statuses().at(-1)?.state).toBe("live");
  });

  it("marks data stale when the head stops advancing", async () => {
    const t = setup();
    seed(t.server);
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    for (let i = 0; i < 4; i++) {
      t.advance(STALE_AFTER_MS / 3);
      await t.fireTimers();
    }
    expect(t.statuses().at(-1)?.state).toBe("stale");
  });

  it("keeps the trains, the selection and a forward clock while the head is frozen, then shows stale", async () => {
    const t = setup();
    seed(t.server);
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    t.runtime.handle({ type: "select", id: "live:2" });
    const lons: number[] = [];
    const planTimes: number[] = [];
    let wipes = 0;
    let ended = 0;
    for (let step = 1; step <= 40; step++) {
      t.advance(5000);
      await t.fireTimers();
      t.runtime.handle({ type: "tick", now: 0 });
      t.runtime.handle({ type: "diagnostics" });
      const diagnostics = t.posted
        .filter((m): m is DiagnosticsMessage => m.type === "diagnostics")
        .at(-1);
      planTimes.push(diagnostics?.data.planTime ?? Number.NaN);
      const group = t.frames().at(-1)?.frame.groups[0];
      if ((group?.count ?? 0) < 2) wipes++;
      lons.push(group?.positions[0] ?? Number.NaN);
      ended = t.posted.filter(
        (m): m is LiveSelectionMessage => m.type === "live-selection" && m.info === null,
      ).length;
    }
    expect(wipes).toBe(0);
    expect(ended).toBe(0);
    expect(t.frames().at(-1)?.frame.selected?.id).toBe("live:2");
    for (let i = 1; i < planTimes.length; i++) {
      expect(planTimes[i]).toBeGreaterThanOrEqual(planTimes[i - 1] as number);
      expect(lons[i]).toBeGreaterThanOrEqual((lons[i - 1] as number) - 1e-9);
    }
    expect(t.statuses().at(-1)?.state).toBe("stale");
    seed(t.server);
    t.server.headBytes = encodeHead({ ...head(10, 10, 11), timeBase: T0 + 10 + 200 });
    t.advance(1000);
    await t.fireTimers();
    t.runtime.handle({ type: "tick", now: 0 });
    expect(t.statuses().at(-1)?.state).toBe("live");
    expect(t.frames().at(-1)?.frame.groups[0]?.count).toBe(2);
  }, 30_000);

  it("applies a delta when the display clock reaches its time, not when it arrives", async () => {
    const t = setup();
    seed(t.server);
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    t.server.objects.putDelta(delta(11, [trip(3, { stops: RUN })]));
    t.server.objects.putDelta(delta(12, [trip(4, { stops: RUN })]));
    publish(t.server, 12, 10, 11);
    t.advance(1000);
    await t.fireTimers();
    const idsNow = () => t.frames().at(-1)?.frame.groups[0]?.ids ?? [];
    t.runtime.handle({ type: "tick", now: 0 });
    expect(idsNow()).toEqual(["live:1", "live:2"]);
    const appearedAt = new Map<string, number>();
    for (let i = 1; i <= 60; i++) {
      t.advance(100);
      t.runtime.handle({ type: "tick", now: 0 });
      for (const id of idsNow()) if (!appearedAt.has(id)) appearedAt.set(id, i * 100);
    }
    const third = appearedAt.get("live:3") as number;
    const fourth = appearedAt.get("live:4") as number;
    expect(third).toBeGreaterThan(0);
    expect(fourth - third).toBeGreaterThanOrEqual(900);
    expect(fourth - third).toBeLessThanOrEqual(1100);
  });

  it("recovers from a missing delta by reloading the keyframe", async () => {
    const t = setup();
    seed(t.server);
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    publish(t.server, 12, 10, 11);
    t.advance(1000);
    await t.fireTimers();
    expect(t.statuses().at(-1)?.state).toBe("live");
    t.server.objects.putDelta(delta(11, [trip(3, { stops: RUN })]));
    t.server.objects.putDelta(delta(12, []));
    t.advance(1000);
    await t.fireTimers();
    for (let i = 0; i < 40; i++) {
      t.advance(100);
      t.runtime.handle({ type: "tick", now: 0 });
    }
    t.runtime.handle({ type: "diagnostics" });
    const data = t.posted
      .filter((m): m is DiagnosticsMessage => m.type === "diagnostics")
      .at(-1)?.data;
    expect(data?.followErrors).toBe(1);
    expect(data?.sequence).toBe(12);
    expect(data?.trains).toBe(3);
  });

  it("drops the trains of the old time line when the server's time goes back and stays back", async () => {
    const t = setup();
    seed(t.server);
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    t.runtime.handle({ type: "tick", now: 0 });
    expect(t.frames().at(-1)?.frame.groups[0]?.count).toBe(2);
    t.server.objects.putKeyframe(keyframe(3, [trip(9, { stops: RUN })]));
    t.server.headBytes = encodeHead({ ...head(3, 3, 4), timeBase: T0 - 7200 });
    t.advance(1000);
    await t.fireTimers();
    t.runtime.handle({ type: "tick", now: 0 });
    expect(t.frames().at(-1)?.frame.groups[0]?.count).toBe(2);
    t.advance(1000);
    await t.fireTimers();
    t.runtime.handle({ type: "tick", now: 0 });
    expect(t.frames().at(-1)?.frame.groups[0]?.ids).toEqual(["live:9"]);
    expect(t.statuses().at(-1)?.timelineEpoch).toBe(1);
  });

  it("stays loading while no keyframe is applied and reports an error after repeated chain errors", async () => {
    const t = setup();
    publish(t.server, 10, 10, 11);
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    expect(t.statuses().at(-1)).toMatchObject({
      state: "loading",
      framed: false,
      error: undefined,
    });
    t.advance(1000);
    await t.fireTimers();
    expect(t.statuses().at(-1)).toMatchObject({
      state: "error",
      framed: false,
      error: "unreadable",
    });
    t.server.objects.putKeyframe(keyframe(10, [trip(1, { stops: RUN })]));
    t.advance(1000);
    await t.fireTimers();
    await t.settle();
    t.advance(1000);
    t.runtime.handle({ type: "tick", now: 0 });
    expect(t.statuses().at(-1)).toMatchObject({ state: "live", framed: true, error: undefined });
  });

  it("goes back to loading when the time line restarts and is framed again with its keyframe", async () => {
    const t = setup();
    seed(t.server);
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    t.advance(1000);
    t.runtime.handle({ type: "tick", now: 0 });
    expect(t.statuses().at(-1)).toMatchObject({ state: "live", framed: true });
    t.server.headBytes = encodeHead({ ...head(3, 3, 4), timeBase: T0 - 7200 });
    t.advance(1000);
    await t.fireTimers();
    t.advance(1000);
    await t.fireTimers();
    expect(t.statuses().at(-1)).toMatchObject({
      state: "loading",
      framed: false,
      timelineEpoch: 1,
    });
    t.server.objects.putKeyframe(keyframe(3, [trip(9, { stops: RUN })]));
    t.advance(1000);
    await t.fireTimers();
    await t.settle();
    t.advance(1000);
    t.runtime.handle({ type: "tick", now: 0 });
    expect(t.statuses().at(-1)).toMatchObject({ state: "live", framed: true, timelineEpoch: 1 });
  });

  it("ignores a head from another edge that is far behind for one poll and keeps the chain", async () => {
    const t = setup();
    seed(t.server);
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    const fresh = head(10, 10, 11);
    const behind = { ...head(3, 3, 4), timeBase: T0 - 7200 };
    t.server.objects.putKeyframe(keyframe(3, [trip(9, { stops: RUN })]));
    for (let poll = 0; poll < 6; poll++) {
      t.server.headBytes = encodeHead(poll % 2 === 0 ? behind : fresh);
      t.advance(1000);
      await t.fireTimers();
      t.runtime.handle({ type: "tick", now: 0 });
      expect(t.frames().at(-1)?.frame.groups[0]?.count).toBe(2);
    }
    t.runtime.handle({ type: "diagnostics" });
    const data = t.posted.filter((m): m is DiagnosticsMessage => m.type === "diagnostics").at(-1);
    expect(data?.data.sequence).toBe(10);
  });

  it("does not let the join cycle raise the display lag", async () => {
    const t = setup();
    seed(t.server);
    let release!: () => void;
    t.server.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    t.advance(2000);
    release();
    await t.settle();
    t.runtime.handle({ type: "diagnostics" });
    const data = t.posted.filter((m): m is DiagnosticsMessage => m.type === "diagnostics").at(-1);
    expect(data?.data.displayLagS).toBeCloseTo(0.5 + 1.5, 6);
  });

  it("selects a train, sends its route once and says when it ends", async () => {
    const t = setup();
    seed(t.server);
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    t.runtime.handle({ type: "select", id: "live:2" });
    t.runtime.handle({ type: "tick", now: 0 });
    const first = t.frames().at(-1);
    expect(first?.frame.selected?.id).toBe("live:2");
    expect(first?.selectionPath?.length).toBe(82);
    t.runtime.handle({ type: "tick", now: 0 });
    expect(t.frames().at(-1)?.selectionPath).toBeUndefined();
    const info = t.posted.find((m): m is LiveSelectionMessage => m.type === "live-selection");
    expect(info?.info).toMatchObject({ key: 2, line: "RE 1", trainNumber: 4711, category: "reg" });
    t.server.objects.putDelta(delta(11, [], [2]));
    publish(t.server, 11, 10, 11);
    t.advance(1000);
    await t.fireTimers();
    for (let i = 0; i < 30; i++) {
      t.advance(100);
      t.runtime.handle({ type: "tick", now: 0 });
    }
    const ended = t.posted
      .filter((m): m is LiveSelectionMessage => m.type === "live-selection")
      .at(-1);
    expect(ended?.info).toBeNull();
    expect(t.frames().at(-1)?.frame.selected).toBeNull();
  });

  it("ends the selection at once for a train an earlier frame removed, as one past its last stop", async () => {
    const t = setup();
    seed(t.server);
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    t.server.objects.putDelta(delta(11, [], [2]));
    publish(t.server, 11, 10, 11);
    t.advance(1000);
    await t.fireTimers();
    for (let i = 0; i < TICKS_TO_APPLY_REMOVAL; i++) {
      t.advance(100);
      t.runtime.handle({ type: "tick", now: 0 });
    }
    t.runtime.handle({ type: "select", id: "live:2" });
    t.runtime.handle({ type: "tick", now: 0 });
    expect(t.frames().at(-1)?.frame.selected).toBeNull();
    const info = t.posted.filter((m): m is LiveSelectionMessage => m.type === "live-selection");
    expect(info.at(-1)?.info).toBeNull();
    const drawn = t.posted.filter((m) => m.type === "selection-drawn").at(-1);
    expect(drawn).toMatchObject({ key: 2, drawn: false });
  });

  it("keeps the selection while the new time line loads and when its keyframe holds the train", async () => {
    const t = setup();
    seed(t.server);
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    t.runtime.handle({ type: "select", id: "live:2" });
    t.runtime.handle({ type: "tick", now: 0 });
    expect(t.frames().at(-1)?.frame.selected?.id).toBe("live:2");
    t.server.objects.putKeyframe(keyframe(3, [trip(2, { stops: RUN }), trip(9, { stops: RUN })]));
    t.server.headBytes = encodeHead({ ...head(3, 3, 4), timeBase: T0 - 7200 });
    t.advance(1000);
    await t.fireTimers();
    let release: () => void = () => undefined;
    t.server.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.advance(1000);
    await t.fireTimers();
    t.runtime.handle({ type: "tick", now: 0 });
    t.runtime.handle({ type: "tick", now: 0 });
    const during = t.posted.filter(
      (m): m is LiveSelectionMessage => m.type === "live-selection" && m.info === null,
    );
    expect(during).toHaveLength(0);
    t.server.hold = null;
    release();
    await t.settle();
    t.runtime.handle({ type: "tick", now: 0 });
    const reloaded = t.frames().at(-1);
    expect(reloaded?.frame.selected?.id).toBe("live:2");
    expect(reloaded?.selectionPath?.length).toBe(82);
    const ended = t.posted.filter(
      (m): m is LiveSelectionMessage => m.type === "live-selection" && m.info === null,
    );
    expect(ended).toHaveLength(0);
  });

  it("ends the selection after a new time line whose keyframe lacks the train", async () => {
    const t = setup();
    seed(t.server);
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    t.runtime.handle({ type: "select", id: "live:2" });
    t.runtime.handle({ type: "tick", now: 0 });
    t.server.objects.putKeyframe(keyframe(3, [trip(9, { stops: RUN })]));
    t.server.headBytes = encodeHead({ ...head(3, 3, 4), timeBase: T0 - 7200 });
    for (let poll = 0; poll < 2; poll++) {
      t.advance(1000);
      await t.fireTimers();
    }
    t.runtime.handle({ type: "tick", now: 0 });
    const ended = t.posted
      .filter((m): m is LiveSelectionMessage => m.type === "live-selection")
      .at(-1);
    expect(ended?.info).toBeNull();
  });

  it("keeps a selection made while the first keyframe is still loading and shows the train when it arrives", async () => {
    const t = setup();
    seed(t.server);
    let release: () => void = () => undefined;
    t.server.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    t.runtime.handle({ type: "select", id: "live:2" });
    for (let i = 0; i < 5; i++) {
      t.advance(100);
      t.runtime.handle({ type: "tick", now: 0 });
    }
    const early = t.posted.filter(
      (m): m is LiveSelectionMessage => m.type === "live-selection" && m.info === null,
    );
    expect(early).toHaveLength(0);
    t.server.hold = null;
    release();
    await t.settle();
    t.runtime.handle({ type: "tick", now: 0 });
    expect(t.frames().at(-1)?.frame.selected?.id).toBe("live:2");
  });

  it("shows a train selected before the live source started, as from a shared link", async () => {
    const t = setup();
    seed(t.server);
    t.runtime.handle({ type: "select", id: "live:2" });
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    t.runtime.handle({ type: "tick", now: 0 });
    expect(t.frames().at(-1)?.frame.selected?.id).toBe("live:2");
    const ended = t.posted.filter(
      (m): m is LiveSelectionMessage => m.type === "live-selection" && m.info === null,
    );
    expect(ended).toHaveLength(0);
  });

  it("tells whether the selected train is drawn: not while it waits for its track, yes once it has one", async () => {
    const t = setup();
    t.server.packs = new Set();
    seed(t.server);
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    t.runtime.handle({ type: "select", id: "live:2" });
    t.runtime.handle({ type: "tick", now: 0 });
    t.runtime.handle({ type: "tick", now: 0 });
    const drawn = () =>
      t.posted.filter((m): m is SelectionDrawnMessage => m.type === "selection-drawn");
    expect(drawn().map((m) => m.drawn)).toEqual([false]);
    expect(drawn().map((m) => m.key)).toEqual([2]);
    t.server.packs = new Set([7]);
    t.advance(61_000);
    t.runtime.handle({ type: "select", id: null });
    t.runtime.handle({ type: "select", id: "live:1" });
    t.runtime.handle({ type: "tick", now: 0 });
    expect(drawn().map((m) => m.drawn)).toEqual([false, false]);
    expect(drawn().map((m) => m.key)).toEqual([2, 1]);
  });

  it("says a selected train is drawn once, and not before the first keyframe is in", async () => {
    const t = setup();
    seed(t.server);
    let release: () => void = () => undefined;
    t.server.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    t.runtime.handle({ type: "select", id: "live:2" });
    t.runtime.handle({ type: "tick", now: 0 });
    const drawn = () =>
      t.posted.filter((m): m is SelectionDrawnMessage => m.type === "selection-drawn");
    expect(drawn()).toHaveLength(0);
    t.server.hold = null;
    release();
    await t.settle();
    t.runtime.handle({ type: "tick", now: 0 });
    t.runtime.handle({ type: "tick", now: 0 });
    expect(drawn().map((m) => m.drawn)).toEqual([true]);
  });

  it("keeps the selection of a train that waits for its shape", async () => {
    const t = setup();
    t.server.packs = new Set();
    seed(t.server);
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    t.runtime.handle({ type: "select", id: "live:2" });
    t.runtime.handle({ type: "tick", now: 0 });
    const ended = t.posted.filter(
      (m): m is LiveSelectionMessage => m.type === "live-selection" && m.info === null,
    );
    expect(ended).toHaveLength(0);
  });

  it("ignores a selection id of another source", async () => {
    const t = setup();
    seed(t.server);
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    t.runtime.handle({ type: "select", id: "20261024_12:00_de-DELFI_a" });
    t.runtime.handle({ type: "tick", now: 0 });
    expect(t.frames().at(-1)?.frame.selected).toBeNull();
  });

  it("stops polling while hidden and polls at once when shown", async () => {
    const t = setup();
    seed(t.server);
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    t.runtime.handle({ type: "visibility", hidden: true });
    expect(t.pending()).toBe(0);
    const before = t.server.requests.length;
    t.runtime.handle({ type: "visibility", hidden: false });
    await t.settle();
    expect(t.server.requests.length).toBeGreaterThan(before);
  });

  it("answers a nearest request with the shown trains by distance and their count in view", async () => {
    const t = setup();
    seed(t.server);
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    t.advance(1000);
    t.runtime.handle({ type: "tick", now: 0 });
    const centre = { lon: lonOf(SHAPE_X0), lat: latOf(SHAPE_Y) };
    t.runtime.handle({ type: "nearest", id: 5, request: { ...centre, count: 1 } });
    const answer = t.posted.findLast((m): m is NearestMessage => m.type === "nearest-trains");
    expect(answer?.id).toBe(5);
    expect(answer?.result.inView).toBe(2);
    expect(answer?.result.trains).toHaveLength(1);
    expect(answer?.result.trains[0]?.id).toMatch(/^live:[12]$/);
    t.runtime.handle({ type: "categories", hidden: ["reg"] });
    t.runtime.handle({ type: "nearest", id: 6, request: { ...centre, count: 20 } });
    const hidden = t.posted.findLast((m): m is NearestMessage => m.type === "nearest-trains");
    expect(hidden?.id).toBe(6);
    expect(hidden?.result).toEqual({ inView: 0, trains: [] });
  });

  it("counts in view by the area it is given", async () => {
    const t = setup();
    seed(t.server);
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    t.advance(1000);
    t.runtime.handle({ type: "tick", now: 0 });
    const lon = lonOf(SHAPE_X0);
    const lat = latOf(SHAPE_Y);
    const far = [
      [lon + 5, lat + 5],
      [lon + 6, lat + 5],
      [lon + 6, lat + 6],
    ] as const;
    t.runtime.handle({ type: "nearest", id: 9, request: { lon, lat, count: 20, area: far } });
    const answer = t.posted.findLast((m): m is NearestMessage => m.type === "nearest-trains");
    expect(answer?.result.inView).toBe(0);
  });

  it("answers a nearest request before the first head with an empty list", () => {
    const t = setup();
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    t.runtime.handle({ type: "nearest", id: 1, request: { lon: 8, lat: 50, count: 20 } });
    expect(t.posted.findLast((m): m is NearestMessage => m.type === "nearest-trains")).toEqual({
      type: "nearest-trains",
      id: 1,
      result: { inView: 0, trains: [] },
    });
  });

  it("hides categories and recolours on request", async () => {
    const t = setup();
    seed(t.server);
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    t.runtime.handle({ type: "categories", hidden: ["reg"] });
    t.runtime.handle({ type: "tick", now: 0 });
    expect(t.frames().at(-1)?.frame.groups[0]?.count).toBe(0);
    t.runtime.handle({ type: "categories", hidden: [] });
    t.runtime.handle({
      type: "palette",
      palette: { ...PALETTE, fill: { ...PALETTE.fill, reg: [200, 0, 0] } },
    });
    t.runtime.handle({ type: "tick", now: 0 });
    expect(Array.from(t.frames().at(-1)?.frame.groups[0]?.fillColors.subarray(0, 3) ?? [])).toEqual(
      [200, 0, 0],
    );
  });

  it("colours by delay class once the mode is set, also when it arrives before the start", async () => {
    const t = setup();
    seed(t.server);
    const delay = {
      ok: [21, 21, 21],
      minor: [22, 22, 22],
      major: [23, 23, 23],
      severe: [24, 24, 24],
      none: [25, 25, 25],
      foreign: [26, 26, 26],
    } as const;
    t.runtime.handle({ type: "colour-mode", mode: "delay" });
    t.runtime.handle({ type: "init-live", palette: { ...PALETTE, delay }, config: CONFIG });
    await t.settle();
    t.runtime.handle({ type: "tick", now: 0 });
    const group = t.frames().at(-1)?.frame.groups[0];
    expect(Array.from(group?.fillColors.subarray(0, 3) ?? [])).toEqual([25, 25, 25]);
    const status = t.statuses().at(-1);
    expect(status?.delayCounts?.none).toBe(status?.trips);
  });

  it("colours by operator group and hides a group once the message arrives, also before the start", async () => {
    const t = setup();
    seed(t.server);
    const operator = {
      db: [31, 31, 31],
      transdev: [32, 32, 32],
      kvvh: [33, 33, 33],
      netinera: [34, 34, 34],
      hlb: [35, 35, 35],
      sweg: [36, 36, 36],
      other: [39, 39, 39],
      unknown: [40, 40, 40],
    } as const;
    t.runtime.handle({ type: "colour-mode", mode: "operator" });
    t.runtime.handle({ type: "operator-groups", hidden: [] });
    t.runtime.handle({ type: "init-live", palette: { ...PALETTE, operator }, config: CONFIG });
    await t.settle();
    t.runtime.handle({ type: "tick", now: 0 });
    const group = t.frames().at(-1)?.frame.groups[0];
    expect(Array.from(group?.fillColors.subarray(0, 3) ?? [])).toEqual([40, 40, 40]);
    const status = t.statuses().at(-1);
    expect(status?.operatorCounts?.unknown).toBe(status?.trips);
    t.runtime.handle({ type: "operator-groups", hidden: ["unknown"] });
    t.runtime.handle({ type: "tick", now: 0 });
    expect(t.frames().at(-1)?.frame.groups[0]?.count).toBe(0);
  });

  it("draws without jumps or stalls at 10x with heads of whole seconds that reach it 0.2 to 1.2 s late", async () => {
    const t = setup();
    const trips = Array.from({ length: 20 }, (_, i) => trip(100 + i, { stops: RUN }));
    t.server.objects.putKeyframe(keyframe(10, trips));
    let seed = 12345;
    const lagWallMs = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return 200 + (seed / 0x100000000) * 1000;
    };
    const virtual = () =>
      Math.floor(T0 + 100 + ((t.now() - lagWallMs() - (T0 + 100) * 1000) / 1000) * 10);
    const publishTime = () => {
      t.server.headBytes = encodeHead({ ...head(10, 10, 11), timeBase: virtual() });
    };
    publishTime();
    t.runtime.handle({
      type: "init-live",
      palette: PALETTE,
      config: { ...CONFIG, timeScale: 10, replay: true },
    });
    await t.settle();
    t.runtime.handle({ type: "continuity", action: "start", sample: 1 });
    let nextHead = t.now() + 1000;
    for (let frame = 0; frame < 60 * 40; frame++) {
      t.advance(frame % 3 === 0 ? 17 : 16);
      if (t.now() >= nextHead) {
        publishTime();
        await t.fireTimers();
        nextHead += 1000;
      }
      t.runtime.handle({ type: "tick", now: 0 });
    }
    t.runtime.handle({ type: "continuity", action: "report" });
    const report = t.posted
      .filter((m): m is ContinuityMessage => m.type === "continuity")
      .at(-1)?.report;
    expect(report?.measuredTrains).toBe(20);
    expect(report?.judgedPairs).toBeGreaterThan(20 * 2000);
    expect(report).toMatchObject({ jumps: 0, stalls: 0, backwardSteps: 0, offTrackFrames: 0 });
  });

  it("applies every delta within a tick of its time at 10x with a head every plan second", async () => {
    const t = setup();
    const trips = [1, 2, 3, 4, 5].map((key) => trip(key, { stops: RUN }));
    t.server.objects.putKeyframe(keyframe(10, trips));
    for (let sequence = 11; sequence <= 60; sequence++) {
      const key = 1 + (sequence % 5);
      t.server.objects.putDelta(
        delta(sequence, [trip(key, { stops: RUN, realtime: sequence % 2 === 0 })]),
      );
    }
    const start = t.now();
    const published = () =>
      Math.min(60, Math.max(10, Math.floor(10 + ((t.now() - start) / 1000) * 10)));
    const publish = () => {
      t.server.headBytes = encodeHead(head(published(), 10, 11));
    };
    publish();
    t.runtime.handle({
      type: "init-live",
      palette: PALETTE,
      config: { ...CONFIG, timeScale: 10, replay: true, pollMs: 100 },
    });
    await t.settle();
    for (let frame = 0; frame < 60 * 9; frame++) {
      t.advance(16);
      if (frame % 6 === 0) {
        publish();
        await t.fireTimers();
      }
      t.runtime.handle({ type: "tick", now: 0 });
    }
    t.runtime.handle({ type: "diagnostics" });
    const data = t.posted
      .filter((m): m is DiagnosticsMessage => m.type === "diagnostics")
      .at(-1)?.data;
    expect(data?.sequence).toBe(60);
    expect(data?.applyLagS.count).toBeGreaterThanOrEqual(45);
    expect(data?.applyLagS.max).toBeLessThan(0.35);
    expect(data?.displayLagS).toBeCloseTo(0.5 + 1.5 * 10, 6);
  }, 30_000);

  it("applies every delta within a tick of its time at 1x when fetches take half a second", async () => {
    const t = setup();
    const trips = [1, 2, 3].map((key) => trip(key, { stops: RUN }));
    t.server.objects.putKeyframe(keyframe(10, trips));
    for (let sequence = 11; sequence <= 40; sequence++) {
      t.server.objects.putDelta(
        delta(sequence, [trip(1 + (sequence % 3), { stops: RUN, realtime: sequence % 2 === 0 })]),
      );
    }
    const start = t.now();
    const published = () => Math.min(40, Math.max(10, 10 + Math.floor((t.now() - start) / 1000)));
    t.server.headBytes = encodeHead(head(10, 10, 11));
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    for (let frame = 0; frame < 60 * 25; frame++) {
      t.advance(16);
      if (frame % 63 === 0) {
        t.server.headBytes = encodeHead(head(published(), 10, 11));
        await t.fireTimers();
      }
      t.runtime.handle({ type: "tick", now: 0 });
    }
    t.runtime.handle({ type: "diagnostics" });
    const data = t.posted
      .filter((m): m is DiagnosticsMessage => m.type === "diagnostics")
      .at(-1)?.data;
    expect(data?.applyLagS.count).toBeGreaterThanOrEqual(20);
    expect(data?.applyLagS.max).toBeLessThan(0.35);
  }, 30_000);

  it("survives a network blip without resetting the chain or showing an error", async () => {
    const t = setup();
    seed(t.server);
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    t.server.objects.putDelta(delta(11, [trip(3, { stops: RUN })]));
    publish(t.server, 11, 10, 11);
    t.server.headStatus = 200;
    const original = t.server.objects.read;
    t.server.objects.read = async (path: string) => {
      if (path === "d/11.bin") throw new TypeError("network");
      return original(path);
    };
    t.advance(1000);
    await t.fireTimers();
    expect(t.statuses().at(-1)?.error).toBeUndefined();
    t.server.objects.read = original;
    t.advance(1000);
    await t.fireTimers();
    t.runtime.handle({ type: "diagnostics" });
    const data = t.posted
      .filter((m): m is DiagnosticsMessage => m.type === "diagnostics")
      .at(-1)?.data;
    expect(data?.sequence).toBe(11);
    expect(data?.followErrors).toBe(0);
    expect(data?.bytesFetched).toBeGreaterThan(0);
    expect(t.server.requests.filter((r) => r.endsWith("/k/10.bin"))).toHaveLength(1);
  });

  it("measures continuity of the drawn frames on request", async () => {
    const t = setup();
    seed(t.server);
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    t.runtime.handle({ type: "continuity", action: "start", sample: 1 });
    for (let i = 0; i < 120; i++) {
      t.advance(16);
      t.runtime.handle({ type: "tick", now: 0 });
    }
    t.runtime.handle({ type: "continuity", action: "report" });
    const report = t.posted
      .filter((m): m is ContinuityMessage => m.type === "continuity")
      .at(-1)?.report;
    expect(report?.measuredTrains).toBe(2);
    expect(report?.frames).toBeGreaterThan(200);
    expect(report).toMatchObject({ jumps: 0, stalls: 0, backwardSteps: 0 });
  });
});

describe("live runtime on the relief", () => {
  const BAKED = { start: 300, slope: 0.01 };
  const VIEW = {
    zoom: 11,
    lon: lonOf(SHAPE_X0 + 2_000),
    lat: latOf(SHAPE_Y),
    radiusM: 1000,
    fineRadiusM: 500,
    ready: [],
    selection: [1, 2, 3] as [number, number, number],
  };

  async function selectedOnRelief() {
    const t = setup();
    t.server.packHeights = BAKED;
    seed(t.server);
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    t.runtime.handle({ type: "select", id: "live:2" });
    t.advance(1000);
    t.runtime.handle({ type: "tick", now: 0 });
    return t;
  }

  const lastFrame = (t: Awaited<ReturnType<typeof selectedOnRelief>>) =>
    t.frames().at(-1) as FrameMessage;
  const tick = (t: Awaited<ReturnType<typeof selectedOnRelief>>) => {
    t.advance(100);
    t.runtime.handle({ type: "tick", now: 0 });
    return lastFrame(t);
  };

  it("draws at sea level and sends the route without heights until the page asks for relief", async () => {
    const t = await selectedOnRelief();
    const first = t.frames().find((message) => message.selectionPath);
    expect(first?.selectionHeights).toBeUndefined();
    expect(first?.selectionStops?.vertices.length).toBeGreaterThan(1);
    expect(first?.frame.selected?.z).toBe(0);
    expect(first?.frame.groups[0]?.positions[2]).toBe(0);
  });

  it("lifts the trains and resends the route with heights when the elevation message arrives", async () => {
    const t = await selectedOnRelief();
    expect(tick(t).selectionPath).toBeUndefined();

    t.runtime.handle({ type: "elevation", scale: 1.5 });
    const frame = tick(t);

    expect(frame.selectionPath).toBeDefined();
    expect(frame.selectionHeights).toHaveLength((frame.selectionPath?.length ?? 0) / 2);
    expect(frame.selectionHeights?.[0]).toBeCloseTo(BAKED.start * 1.5, 3);
    expect(frame.frame.selected?.z).toBeGreaterThanOrEqual(BAKED.start * 1.5 - 1e-3);
    expect(frame.frame.groups[0]?.positions[2]).toBeGreaterThanOrEqual(BAKED.start * 1.5 - 1e-3);
    expect(tick(t).selectionPath).toBeUndefined();
  });

  it("raises the markers by the lift of the view the page last sent", async () => {
    const t = await selectedOnRelief();
    t.runtime.handle({ type: "elevation", scale: 1.5 });
    t.runtime.handle({ type: "view", view: { ...VIEW, zoom: 11, pitch: 0 } });
    const near = tick(t).frame.selected?.z as number;
    t.runtime.handle({ type: "view", view: { ...VIEW, zoom: 11, pitch: 60 } });
    const tilted = tick(t).frame.selected?.z as number;
    t.runtime.handle({ type: "view", view: { ...VIEW, zoom: 13.5, pitch: 0 } });
    const mesh = tick(t).frame.selected?.z as number;

    expect(tilted - near).toBeCloseTo(
      markerLiftM(11, VIEW.lat, 60) - markerLiftM(11, VIEW.lat, 0),
      3,
    );
    expect(near).toBeGreaterThan(0);
    const bakedHere = (near - markerLiftM(11, VIEW.lat, 0)) / 1.5;
    expect(mesh).toBeCloseTo(bakedHere * 1.5 + markerLiftM(13.5, VIEW.lat, 0), 0);
  });

  it("returns to sea level and resends the route without heights when the relief goes off", async () => {
    const t = await selectedOnRelief();
    t.runtime.handle({ type: "elevation", scale: 1.5 });
    tick(t);
    t.runtime.handle({ type: "elevation", scale: 0 });
    const frame = tick(t);

    expect(frame.selectionPath).toBeDefined();
    expect(frame.selectionHeights).toBeUndefined();
    expect(frame.frame.selected?.z).toBe(0);
    expect(frame.frame.groups[0]?.positions[2]).toBe(0);
  });

  it("sends the track of the shapes in view at zoom 12 and more, again when the view moves on", async () => {
    const t = await selectedOnRelief();
    expect(t.frames().some((message) => message.deck)).toBe(false);

    t.runtime.handle({ type: "elevation", scale: 1.5 });
    t.runtime.handle({
      type: "view",
      view: { ...VIEW, zoom: 13, radiusM: 40_000, fineRadiusM: 20_000 },
    });
    const first = tick(t);
    expect(first.deck?.counts.length).toBeGreaterThan(0);
    expect(first.deck?.paths.length).toBe(3 * (first.deck?.counts.reduce((a, b) => a + b, 0) ?? 0));

    expect(tick(t).deck).toBeUndefined();
    t.advance(5000);
    expect(tick(t).deck).toBeUndefined();

    t.runtime.handle({
      type: "view",
      view: { ...VIEW, zoom: 13, lon: VIEW.lon + 2, radiusM: 40_000, fineRadiusM: 20_000 },
    });
    t.advance(1000);
    const moved = tick(t).deck;
    expect(moved?.counts).toHaveLength(0);
    t.advance(1000);
    expect(tick(t).deck).toBeUndefined();
  });

  it("clears the track again and again without a detached buffer, so frames keep coming", async () => {
    const t = await selectedOnRelief();
    t.runtime.handle({ type: "elevation", scale: 1.5 });
    const deckView = { ...VIEW, zoom: 13, radiusM: 40_000, fineRadiusM: 20_000 };
    const flatView = { ...VIEW, zoom: 11, radiusM: 40_000, fineRadiusM: 20_000 };
    for (let round = 0; round < 4; round++) {
      t.runtime.handle({ type: "view", view: deckView });
      t.advance(1000);
      expect(tick(t).deck?.counts.length).toBeGreaterThan(0);
      t.runtime.handle({ type: "view", view: flatView });
      expect(tick(t).deck?.counts).toHaveLength(0);
    }
  });

  it("sends nothing below zoom 12 and clears the track once when the relief goes off", async () => {
    const t = await selectedOnRelief();
    t.runtime.handle({ type: "elevation", scale: 1.5 });
    t.runtime.handle({
      type: "view",
      view: { ...VIEW, zoom: 11, radiusM: 40_000, fineRadiusM: 20_000 },
    });
    expect(tick(t).deck).toBeUndefined();

    t.runtime.handle({
      type: "view",
      view: { ...VIEW, zoom: 13, radiusM: 40_000, fineRadiusM: 20_000 },
    });
    expect(tick(t).deck?.counts.length).toBeGreaterThan(0);
    t.runtime.handle({ type: "elevation", scale: 0 });
    expect(tick(t).deck?.counts).toHaveLength(0);
    t.advance(2000);
    expect(tick(t).deck).toBeUndefined();
  });
});

describe("live runtime speed of the selected train", () => {
  const CLOCK_AT_START = T0 + 9;

  async function selected(secondsIntoRun: number) {
    const t = setup();
    const first = CLOCK_AT_START - secondsIntoRun;
    const stops = [
      stop(first, first + 60),
      stop(first + 600, first + 660),
      stop(first + 1200, first + 1260),
      stop(first + 2400),
    ];
    t.server.objects.putKeyframe(keyframe(10, [trip(2, { stops })]));
    publish(t.server, 10, 10, 11);
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    t.runtime.handle({ type: "select", id: "live:2" });
    return t;
  }

  const infos = (t: Awaited<ReturnType<typeof selected>>) =>
    t.posted
      .filter((m): m is LiveSelectionMessage => m.type === "live-selection")
      .flatMap((m) => (m.info ? [m.info] : []));

  function run(t: Awaited<ReturnType<typeof selected>>, seconds: number, stepMs = 100) {
    for (let i = 0; i < (seconds * 1000) / stepMs; i++) {
      t.advance(stepMs);
      t.runtime.handle({ type: "tick", now: 0 });
    }
  }

  it("sends the speed of the plan with the selection, at most once a second", async () => {
    const t = await selected(330);
    run(t, 10);
    const sent = infos(t);
    expect(sent.length).toBeGreaterThanOrEqual(9);
    expect(sent.length).toBeLessThanOrEqual(11);
    for (const info of sent) {
      expect(info.speedMps).toBeGreaterThan(5);
      expect(info.speedMps).toBeLessThanOrEqual(160 / 3.6 + 1e-9);
    }
  });

  it("equals the speed of the marker the frames draw along the track (the fixture shape counts its arc in Mercator metres)", async () => {
    const t = await selected(330);
    run(t, 3);
    const at = () => {
      const selection = t.frames().at(-1)?.frame.selected;
      if (!selection) throw new Error("no selected frame");
      return lonLatToMercator(selection.lon, selection.lat);
    };
    const before = at();
    const sentBefore = infos(t).length;
    run(t, 4);
    const after = at();
    const arcMoved = Math.hypot(after.x - before.x, after.y - before.y);
    const sent = infos(t).slice(sentBefore);
    const mean = sent.reduce((sum, info) => sum + (info.speedMps ?? 0), 0) / sent.length;
    expect(mean).toBeGreaterThan(5);
    expect(Math.abs(arcMoved / 4 - mean) / mean).toBeLessThan(0.02);
  });

  it("is zero while the train dwells at a stop", async () => {
    const t = await selected(630);
    run(t, 6);
    const sent = infos(t);
    expect(sent.length).toBeGreaterThan(0);
    for (const info of sent) expect(info.speedMps).toBe(0);
  });

  it("is zero at the origin before the first departure", async () => {
    const t = await selected(-30);
    run(t, 3);
    expect(infos(t).at(-1)?.speedMps).toBe(0);
  });

  it("has no value once the plan has ended", async () => {
    const t = await selected(2395);
    run(t, 8);
    const sent = infos(t);
    expect(sent.at(0)?.speedMps).not.toBeNull();
    expect(sent.at(-1)?.speedMps).toBeNull();
  });

  it("withdraws the speed once while the selection waits for a new time line", async () => {
    const t = await selected(330);
    run(t, 3);
    expect(infos(t).at(-1)?.speedMps).toBeGreaterThan(5);
    t.server.objects.putKeyframe(keyframe(3, [trip(2, { stops: RUN }), trip(9, { stops: RUN })]));
    t.server.headBytes = encodeHead({ ...head(3, 3, 4), timeBase: T0 - 7200 });
    t.advance(1000);
    await t.fireTimers();
    let release: () => void = () => undefined;
    t.server.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.advance(1000);
    await t.fireTimers();
    const before = infos(t).length;
    run(t, 3);
    const withdrawn = infos(t).slice(before);
    expect(withdrawn).toHaveLength(1);
    expect(withdrawn[0]?.speedMps).toBeNull();
    expect(withdrawn[0]?.key).toBe(2);
    t.server.hold = null;
    release();
    await t.settle();
  });
});

describe("live runtime with push notices", () => {
  const PUSH_CONFIG: LiveConfig = { ...CONFIG, pushUrl: "/connection/websocket" };

  async function joined() {
    const t = setup();
    seed(t.server);
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: PUSH_CONFIG });
    await t.settle();
    const heads = () => t.server.requests.filter((url) => url === "/live/v1/head").length;
    const socket = () => t.sockets.at(-1) as FakeSocket;
    const step = async (ms: number) => {
      t.advance(ms);
      await t.fireTimers();
    };
    return { ...t, heads, socket, step };
  }

  async function subscribed() {
    const t = await joined();
    t.socket().subscribed();
    await t.settle();
    return t;
  }

  function diagnostics(t: Awaited<ReturnType<typeof joined>>) {
    t.runtime.handle({ type: "diagnostics" });
    return t.posted.filter((m): m is DiagnosticsMessage => m.type === "diagnostics").at(-1)?.data;
  }

  it("has no channel without a push url and polls as before", async () => {
    const t = setup();
    seed(t.server);
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    expect(t.sockets).toHaveLength(0);
  });

  it("polls the head every second while the channel is not up", async () => {
    const t = await joined();
    expect(t.sockets).toHaveLength(1);
    expect(t.socket().url).toBe("/connection/websocket");
    expect(t.heads()).toBe(1);
    await t.step(1000);
    await t.step(1000);
    expect(t.heads()).toBe(3);
  });

  it("reads the head when the channel comes up, then on a notice or after the safety interval", async () => {
    const t = await subscribed();
    expect(t.heads()).toBe(2);
    await t.step(1000);
    await t.step(SAFETY_POLL_MS - 2000);
    expect(t.heads()).toBe(2);

    t.server.objects.putDelta(delta(11, [trip(3, { stops: RUN })], [1]));
    publish(t.server, 11, 10, 11);
    t.socket().notice(11);
    await t.settle();
    expect(t.heads()).toBe(3);
    expect(t.server.requests.filter((url) => url.includes("/d/"))).toEqual(["/live/v1/d/11.bin"]);

    t.socket().notice(11);
    await t.settle();
    expect(t.heads()).toBe(3);
    await t.step(SAFETY_POLL_MS - 1);
    expect(t.heads()).toBe(3);
    await t.step(1);
    expect(t.heads()).toBe(4);
    expect(diagnostics(t)).toMatchObject({
      push: { up: true, silent: false, notices: 2, connects: 1 },
      headReads: { total: 4, onNotice: 1 },
    });
  });

  it("polls every second again as soon as the channel drops", async () => {
    const t = await subscribed();
    await t.step(1000);
    expect(t.heads()).toBe(2);
    t.socket().drops();
    await t.step(1000);
    expect(t.heads()).toBe(3);
    await t.step(1000);
    expect(t.heads()).toBe(4);
    expect(t.sockets).toHaveLength(2);
    t.socket().subscribed();
    await t.settle();
    expect(t.heads()).toBe(5);
    await t.step(1000);
    expect(t.heads()).toBe(5);
  });

  it("reads a head that is older than its notice again soon, a few times at most", async () => {
    const t = await subscribed();
    t.server.objects.putDelta(delta(11, [trip(3, { stops: RUN })], [1]));
    t.socket().notice(11);
    await t.settle();
    expect(t.heads()).toBe(3);
    await t.step(STALE_HEAD_RETRY_MS);
    expect(t.heads()).toBe(4);
    publish(t.server, 11, 10, 11);
    await t.step(STALE_HEAD_RETRY_MS);
    expect(t.heads()).toBe(5);
    expect(t.server.requests.filter((url) => url.includes("/d/"))).toEqual(["/live/v1/d/11.bin"]);
    await t.step(1000);
    expect(t.heads()).toBe(5);

    t.socket().notice(12);
    await t.settle();
    for (let i = 0; i < 6; i++) await t.step(STALE_HEAD_RETRY_MS);
    expect(t.heads()).toBe(10);
    await t.step(1000);
    expect(t.heads()).toBe(10);
  });

  it("reads again right after a read in flight when a notice comes during it", async () => {
    const t = await subscribed();
    let release = () => {};
    t.server.headHold = new Promise((resolve) => {
      release = () => resolve();
    });
    t.server.objects.putDelta(delta(11, [trip(3, { stops: RUN })], [1]));
    t.socket().notice(11);
    await t.settle();
    t.server.objects.putDelta(delta(12, [], [3]));
    t.socket().notice(12);
    publish(t.server, 11, 10, 11);
    release();
    t.server.headHold = undefined;
    await t.settle();
    expect(t.heads()).toBe(3);
    publish(t.server, 12, 10, 11);
    await t.fireTimers();
    expect(t.heads()).toBe(4);
    expect(t.server.requests.filter((url) => url.includes("/d/"))).toEqual([
      "/live/v1/d/11.bin",
      "/live/v1/d/12.bin",
    ]);
  });

  it("polls every second when the channel is up but frames come without notices", async () => {
    const t = await subscribed();
    t.server.objects.putDelta(delta(11, [trip(3, { stops: RUN })], [1]));
    publish(t.server, 11, 10, 11);
    await t.step(SAFETY_POLL_MS);
    expect(t.heads()).toBe(3);
    await t.step(1000);
    expect(t.heads()).toBe(4);
    expect(diagnostics(t)?.push).toMatchObject({ up: true, silent: true });

    t.server.objects.putDelta(delta(12, [], [3]));
    publish(t.server, 12, 10, 11);
    t.socket().notice(12);
    await t.settle();
    expect(t.heads()).toBe(5);
    await t.step(1000);
    expect(t.heads()).toBe(5);
    expect(diagnostics(t)?.push).toMatchObject({ up: true, silent: false });
  });

  it("closes the channel while the page is hidden and opens it again when shown", async () => {
    const t = await subscribed();
    t.runtime.handle({ type: "visibility", hidden: true });
    expect(t.socket().closed).toBe(true);
    t.socket().notice(11);
    await t.step(SAFETY_POLL_MS * 2);
    expect(t.heads()).toBe(2);
    t.runtime.handle({ type: "visibility", hidden: false });
    await t.settle();
    expect(t.sockets).toHaveLength(2);
    expect(t.heads()).toBe(3);
  });
});
