import { describe, expect, it } from "vitest";
import type { Palette } from "../motion/frame.ts";
import type {
  FrameMessage,
  LiveConfig,
  LiveSelectionMessage,
  PlaybackMessage,
  StatusMessage,
  WorkerMessage,
} from "../motion/protocol.ts";
import { createLiveRuntime, type LiveEnvironment } from "./live-runtime.ts";
import type { PushSocket } from "./push-channel.ts";
import {
  delta,
  encodeHead,
  head,
  keyframe,
  ObjectStore,
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
const START = TIME_BASE;
const RUN = [
  stop(START, START + 60),
  stop(START + 600, START + 660),
  stop(START + 1200, START + 1260),
  stop(START + 2400),
];
const REVISION = "abcdef012345";

function bodyOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function window(sequences = 360): { store: ObjectStore; index: unknown } {
  const store = new ObjectStore();
  const heads: number[][] = [];
  for (let sequence = 1; sequence <= sequences; sequence++) {
    const time = START + 10 * sequence;
    const base = Math.floor((sequence - 1) / 6) * 6 + 1;
    if (sequence === base) {
      store.putKeyframe({
        ...keyframe(sequence, [trip(1, { stops: RUN }), trip(2, { stops: RUN })]),
        timeBase: time,
      });
    }
    if (sequence > 1) {
      store.putDelta({ ...delta(sequence, [trip(1, { stops: RUN })]), timeBase: time });
    }
    heads.push([time, sequence, base, Math.max(2, base - 5), 1]);
  }
  return {
    store,
    index: {
      data: {
        format: 1,
        start: START,
        end: START + 3600,
        revision: REVISION,
        shapeEpoch: 3,
        heads,
      },
    },
  };
}

async function serveUrl(url: string, rendered: ReturnType<typeof window>, live: ObjectStore) {
  const none = () => new Response(null, { status: 404 });
  const object = async (store: ObjectStore, path: string) => {
    const bytes = await store.read(path);
    return bytes ? new Response(bodyOf(bytes), { status: 200 }) : none();
  };
  if (url === "/live/v1/head") {
    return new Response(bodyOf(encodeHead(head(10, 10, 11))), { status: 200 });
  }
  if (url.startsWith("/live/v1/s/")) {
    return new Response(bodyOf(straightPack(7, 40_000, 3, 7)), { status: 200 });
  }
  if (url === `/playback/v1/w/${START}`) {
    return new Response(JSON.stringify(rendered.index), { status: 200 });
  }
  if (url.startsWith("/playback/v1/w/")) {
    return object(rendered.store, url.replace(`/playback/v1/w/${START}/${REVISION}/`, ""));
  }
  if (url.startsWith("/live/v1/k/") || url.startsWith("/live/v1/d/")) {
    return object(live, url.replace("/live/v1/", ""));
  }
  return none();
}

function setup() {
  let wall = (START + 100) * 1000;
  const posted: WorkerMessage[] = [];
  const requests: string[] = [];
  const timers = new Map<number, { callback: () => void; atMs: number }>();
  let nextTimer = 1;
  const rendered = window();
  const live = new ObjectStore();
  live.putKeyframe(keyframe(10, [trip(5, { stops: RUN })]));
  const environment: LiveEnvironment = {
    now: () => wall,
    perf: () => wall,
    post: (message, transfer) => {
      posted.push(structuredClone(message, { transfer }));
    },
    fetch: async (url) => {
      requests.push(url);
      return serveUrl(url, rendered, live);
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
  const sockets: { closed: boolean; socket: PushSocket }[] = [];
  environment.openSocket = () => {
    const socket: PushSocket = {
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: () => {},
      close: () => {
        entry.closed = true;
      },
    };
    const entry = { closed: false, socket };
    sockets.push(entry);
    return socket;
  };
  environment.random = () => 1;
  const runtime = createLiveRuntime(environment);
  const settle = async () => {
    for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    runtime,
    sockets,
    posted,
    requests,
    settle,
    advance: (ms: number) => {
      wall += ms;
    },
    fireTimers: async () => {
      for (const [id, timer] of [...timers]) {
        if (timer.atMs <= wall) {
          timers.delete(id);
          timer.callback();
        }
      }
      await settle();
    },
    tick: async (ms = 100, times = 1) => {
      for (let i = 0; i < times; i++) {
        wall += ms;
        runtime.handle({ type: "tick", now: 0 });
        await settle();
      }
    },
    statuses: () =>
      posted.filter((m): m is StatusMessage => m.type === "status").map((m) => m.status),
    playbackStates: () =>
      posted.filter((m): m is PlaybackMessage => m.type === "playback").map((m) => m.state),
    frames: () => posted.filter((m): m is FrameMessage => m.type === "frame"),
  };
}

async function started(speed = 1, config: LiveConfig = CONFIG) {
  const t = setup();
  t.runtime.handle({ type: "init-live", palette: PALETTE, config });
  await t.settle();
  t.advance(1000);
  t.runtime.handle({ type: "tick", now: 0 });
  t.runtime.handle({
    type: "playback",
    command: { action: "start", at: START + 100, speed, playing: true },
  });
  await t.settle();
  await t.tick(100, 12);
  return t;
}

describe("playback in the live runtime", () => {
  it("draws the trains of the hour at the instant and reports the playback state", async () => {
    const t = await started();
    const last = t.frames().at(-1);
    expect(last?.frame.groups[0]?.count).toBe(2);
    const state = t.playbackStates().at(-1);
    expect(state?.phase).toBe("playing");
    expect(state?.windowStart).toBe(START);
    expect(t.statuses().at(-1)?.state).toBe("recorded");
    const planTime = (t.statuses().at(-1)?.dataTimeMs ?? 0) / 1000;
    expect(Math.abs(planTime - (state?.position ?? 0))).toBeLessThan(2);
    expect(t.requests.some((url) => url.includes(`/playback/v1/w/${START}/${REVISION}/k/`))).toBe(
      true,
    );
  });

  it("stops asking the live source while it plays", async () => {
    const t = await started();
    const before = t.requests.filter((url) => url === "/live/v1/head").length;
    t.advance(5000);
    await t.fireTimers();
    await t.tick(1000, 5);
    expect(t.requests.filter((url) => url === "/live/v1/head")).toHaveLength(before);
  });

  it("runs the plan clock at the speed and holds it when paused", async () => {
    const t = await started(10);
    const first = t.statuses().at(-1)?.dataTimeMs ?? 0;
    await t.tick(1000, 3);
    const second = t.statuses().at(-1)?.dataTimeMs ?? 0;
    expect(second - first).toBeGreaterThan(25_000);
    t.runtime.handle({ type: "playback", command: { action: "pause" } });
    await t.tick(1000, 2);
    const held = t.statuses().at(-1)?.dataTimeMs ?? 0;
    await t.tick(1000, 3);
    expect(t.statuses().at(-1)?.dataTimeMs).toBe(held);
  });

  it("reports the virtual clock as the plan time", async () => {
    const t = await started();
    t.runtime.handle({ type: "diagnostics" });
    const message = t.posted.find((m) => m.type === "diagnostics");
    const planTime = message?.type === "diagnostics" ? message.data.planTime : null;
    const position = t.playbackStates().at(-1)?.position ?? 0;
    expect(Math.abs((planTime ?? 0) - position)).toBeLessThan(2);
  });

  it("returns to the live source on stop and says the playback is over", async () => {
    const t = await started();
    t.runtime.handle({ type: "playback", command: { action: "stop" } });
    expect(t.playbackStates().at(-1)).toBeNull();
    await t.tick(100, 10);
    await t.fireTimers();
    await t.tick(100, 10);
    expect(t.requests.filter((url) => url === "/live/v1/head").length).toBeGreaterThan(1);
    expect(t.statuses().at(-1)?.state).toBe("live");
    const ids = t
      .frames()
      .map((message) => message.frame.groups[0]?.ids)
      .filter((value) => value !== undefined)
      .at(-1);
    expect(ids).toEqual(["live:5"]);
  });

  it("closes the push channel while it plays and opens it again on stop", async () => {
    const t = await started(1, { ...CONFIG, pushUrl: "/connection/websocket" });
    expect(t.sockets).toHaveLength(1);
    expect(t.sockets[0]?.closed).toBe(true);
    const before = t.requests.filter((url) => url === "/live/v1/head").length;
    t.sockets[0]?.socket.onmessage?.({
      data: JSON.stringify({
        push: {
          channel: "live:frames",
          pub: { data: { seq: 11, keyframe: 10, oldest: 1, tv: 1 } },
        },
      }),
    });
    await t.tick(100, 5);
    expect(t.requests.filter((url) => url === "/live/v1/head")).toHaveLength(before);
    t.runtime.handle({ type: "playback", command: { action: "stop" } });
    await t.tick(100, 10);
    await t.fireTimers();
    expect(t.sockets).toHaveLength(2);
    expect(t.sockets[1]?.closed).toBe(false);
    expect(t.requests.filter((url) => url === "/live/v1/head").length).toBeGreaterThan(before);
  });

  it("seeks to another instant and plays on from it", async () => {
    const t = await started();
    t.runtime.handle({ type: "playback", command: { action: "seek", at: START + 2000 } });
    await t.tick(100, 20);
    const state = t.playbackStates().at(-1);
    expect(state?.position).toBeGreaterThanOrEqual(START + 2000);
    expect(state?.phase).toBe("playing");
  });

  it("does not fade under reduced motion and swaps at once", async () => {
    const t = await started(1, { ...CONFIG, reducedMotion: true });
    const from = t.frames().length;
    t.runtime.handle({ type: "playback", command: { action: "seek", at: START + 2000 } });
    await t.tick(100, 8);
    const alphas = t
      .frames()
      .slice(from)
      .flatMap((message) => [
        ...(message.frame.groups[0]?.fillColors.filter((_, i) => i % 4 === 3) ?? []),
      ]);
    expect(alphas.length).toBeGreaterThan(0);
    expect(alphas.every((alpha) => alpha === 0 || alpha === 255)).toBe(true);
    expect(alphas.at(-1)).toBe(255);
  });

  it("follows a change of the reduced motion preference while the page is open: the next playback does not fade", async () => {
    const t = setup();
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    t.advance(1000);
    t.runtime.handle({ type: "tick", now: 0 });
    t.runtime.handle({ type: "reduced-motion", reduced: true });
    const from = t.frames().length;
    t.runtime.handle({
      type: "playback",
      command: { action: "start", at: START + 100, speed: 1, playing: true },
    });
    await t.settle();
    await t.tick(100, 12);
    const alphas = t
      .frames()
      .slice(from)
      .flatMap((message) => [
        ...(message.frame.groups[0]?.fillColors.filter((_, i) => i % 4 === 3) ?? []),
      ]);
    expect(alphas.length).toBeGreaterThan(0);
    expect(alphas.every((alpha) => alpha === 0 || alpha === 255)).toBe(true);
  });

  it("fades the trains out and in around a seek by default", async () => {
    const t = await started();
    const from = t.frames().length;
    t.runtime.handle({ type: "playback", command: { action: "seek", at: START + 2000 } });
    await t.tick(40, 30);
    const alphas = t
      .frames()
      .slice(from)
      .flatMap((message) => [
        ...(message.frame.groups[0]?.fillColors.filter((_, i) => i % 4 === 3) ?? []),
      ]);
    expect(alphas.some((alpha) => alpha > 0 && alpha < 255)).toBe(true);
    expect(alphas.at(-1)).toBe(255);
  });
});

describe("the clock follows the trains on screen", () => {
  function planTimeOf(t: Awaited<ReturnType<typeof started>>): number {
    t.posted.length = 0;
    t.runtime.handle({ type: "diagnostics" });
    const message = t.posted.find((m) => m.type === "diagnostics");
    return message?.type === "diagnostics" ? (message.data.planTime ?? Number.NaN) : Number.NaN;
  }

  async function livePlaying() {
    const t = setup();
    t.runtime.handle({ type: "init-live", palette: PALETTE, config: CONFIG });
    await t.settle();
    t.advance(1000);
    t.runtime.handle({ type: "tick", now: 0 });
    await t.tick(100, 3);
    return t;
  }

  it("keeps the live clock for the live trains while they fade out on entering", async () => {
    const t = await livePlaying();
    const live = planTimeOf(t);
    t.runtime.handle({
      type: "playback",
      command: { action: "start", at: START + 2000, speed: 1, playing: true },
    });
    await t.tick(20, 2);
    expect(Math.abs(planTimeOf(t) - live)).toBeLessThan(5);
    expect(planTimeOf(t)).toBeLessThan(START + 1000);
    await t.tick(100, 12);
    expect(Math.abs(planTimeOf(t) - (START + 2000))).toBeLessThan(5);
  });

  it("keeps the playback clock for the playback trains while they fade out on leaving", async () => {
    const t = await started();
    const played = planTimeOf(t);
    t.runtime.handle({ type: "playback", command: { action: "stop" } });
    await t.tick(20, 2);
    expect(Math.abs(planTimeOf(t) - played)).toBeLessThan(5);
    await t.tick(100, 12);
    expect(planTimeOf(t)).not.toBeNaN();
  });
});

describe("a paused playback", () => {
  it("draws the trains at full opacity after a seek while paused", async () => {
    const t = await started();
    t.runtime.handle({ type: "playback", command: { action: "pause" } });
    await t.tick(100, 3);
    const from = t.frames().length;
    t.runtime.handle({ type: "playback", command: { action: "seek", at: START + 1000 } });
    await t.tick(100, 30);
    const alphas = t
      .frames()
      .slice(from)
      .flatMap((message) => [
        ...(message.frame.groups[0]?.fillColors.filter((_, i) => i % 4 === 3) ?? []),
      ]);
    expect(t.playbackStates().at(-1)?.phase).toBe("paused");
    expect(alphas.at(-1)).toBe(255);
  });
});

describe("the speed of the selected train in a playback", () => {
  const speeds = (t: Awaited<ReturnType<typeof started>>) =>
    t.posted
      .filter((m): m is LiveSelectionMessage => m.type === "live-selection")
      .flatMap((m) => (m.info ? [m.info.speedMps] : []));

  it("is the speed of the train, not of the clock: 10x plays the same number as 1x", async () => {
    const fast = await started(10);
    fast.runtime.handle({ type: "playback", command: { action: "seek", at: START + 300 } });
    await fast.tick(100, 20);
    fast.runtime.handle({ type: "select", id: "live:2" });
    await fast.tick(100, 25);
    const slow = await started(1);
    slow.runtime.handle({ type: "playback", command: { action: "seek", at: START + 300 } });
    await slow.tick(100, 20);
    slow.runtime.handle({ type: "select", id: "live:2" });
    await slow.tick(100, 25);
    const fastSpeed = speeds(fast).at(-1) as number;
    const slowSpeed = speeds(slow).at(-1) as number;
    expect(slowSpeed).toBeGreaterThan(5);
    expect(fastSpeed).toBeGreaterThan(5);
    expect(fastSpeed).toBeLessThanOrEqual(160 / 3.6 + 1e-9);
    expect(Math.abs(fastSpeed - slowSpeed)).toBeLessThan(1);
  });

  it("is zero in a dwell and missing after the plan, at the seeked instant", async () => {
    const t = await started(1);
    t.runtime.handle({ type: "select", id: "live:2" });
    t.runtime.handle({ type: "playback", command: { action: "seek", at: START + 630 } });
    await t.tick(100, 40);
    expect(speeds(t).at(-1)).toBe(0);
    t.runtime.handle({ type: "playback", command: { action: "seek", at: START + 2500 } });
    await t.tick(100, 40);
    expect(speeds(t).at(-1)).toBeNull();
  });

  it("holds the value of the paused instant", async () => {
    const t = await started(1);
    t.runtime.handle({ type: "select", id: "live:2" });
    t.runtime.handle({ type: "playback", command: { action: "seek", at: START + 300 } });
    await t.tick(100, 30);
    t.runtime.handle({ type: "playback", command: { action: "pause" } });
    await t.tick(100, 15);
    const held = speeds(t).at(-1);
    await t.tick(1000, 4);
    expect(held).toBeGreaterThan(5);
    expect(speeds(t).at(-1)).toBe(held);
  });
});
