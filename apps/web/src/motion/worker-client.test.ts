import { describe, expect, it, vi } from "vitest";
import type { Frame, Palette } from "./frame.ts";
import type { DataStatus, WorkerMessage, WorkerRequest } from "./protocol.ts";
import { createMotionClient, type WorkerLike } from "./worker-client.ts";

const PALETTE = {
  fill: { hsr: [1, 1, 1] },
  land: [0, 0, 0],
} as unknown as Palette;

const EMPTY_FRAME: Frame = { groups: [], selected: null };

function fakeWorker() {
  const sent: WorkerRequest[] = [];
  let listener: ((event: MessageEvent<WorkerMessage>) => void) | undefined;
  const worker: WorkerLike = {
    postMessage: (message) => {
      sent.push(message);
    },
    addEventListener: (_type, callback) => {
      listener = callback;
    },
    terminate: vi.fn(),
  };
  return {
    worker,
    sent,
    deliver: (message: WorkerMessage) => {
      listener?.({ data: message } as MessageEvent<WorkerMessage>);
    },
  };
}

function setup() {
  const fake = fakeWorker();
  const onFrame = vi.fn();
  const onStatus = vi.fn();
  const client = createMotionClient(fake.worker, { onFrame, onStatus });
  return { ...fake, client, onFrame, onStatus };
}

describe("motion client", () => {
  it("lets the held shape packs go with one message", () => {
    const { client, sent } = setup();
    client.releasePacks();
    expect(sent).toEqual([{ type: "release-packs" }]);
  });

  it("asks for one frame at a time and the next one after the frame arrived", () => {
    const { client, sent, deliver } = setup();

    expect(client.requestFrame(1000)).toBe(true);
    expect(client.requestFrame(1016)).toBe(false);
    deliver({ type: "frame", frame: EMPTY_FRAME, selectionPath: undefined });
    expect(client.requestFrame(1032)).toBe(true);

    expect(sent.filter((message) => message.type === "tick")).toEqual([
      { type: "tick", now: 1000 },
      { type: "tick", now: 1032 },
    ]);
  });

  it("hands frames and statuses to the listeners", () => {
    const { deliver, onFrame, onStatus, client } = setup();
    const status: DataStatus = {
      state: "live",
      dataTimeMs: 1,
      trips: 2,
      realtime: 1,
      untracked: 0,
      counts: { hsr: 0, ld: 0, night: 0, rfast: 2, reg: 0, sbahn: 0, foreign: 0 },
      error: undefined,
    };
    client.requestFrame(0);

    deliver({ type: "frame", frame: EMPTY_FRAME, selectionPath: undefined });
    deliver({ type: "status", status });

    expect(onFrame).toHaveBeenCalledWith(EMPTY_FRAME, undefined, undefined, undefined, undefined);
    expect(onStatus).toHaveBeenCalledWith(status);
  });

  it("forwards selection and palette changes", () => {
    const { client, sent } = setup();

    client.select("trip-1");
    client.select(null);
    client.setPalette(PALETTE);

    expect(sent).toEqual([
      { type: "select", id: "trip-1" },
      { type: "select", id: null },
      { type: "palette", palette: PALETTE },
    ]);
  });

  it("forwards the categories the legend hides", () => {
    const { client, sent } = setup();

    client.setHiddenCategories(["foreign", "reg"]);

    expect(sent).toEqual([{ type: "categories", hidden: ["foreign", "reg"] }]);
  });

  it("forwards the colour mode", () => {
    const { client, sent } = setup();

    client.setColourMode("delay");

    expect(sent).toEqual([{ type: "colour-mode", mode: "delay" }]);
  });

  it("forwards the hidden operator groups", () => {
    const { client, sent } = setup();

    client.setHiddenOperatorGroups(["db", "other"]);

    expect(sent).toEqual([{ type: "operator-groups", hidden: ["db", "other"] }]);
  });

  it("tells the worker when the tab is hidden or visible", () => {
    const { client, sent } = setup();

    client.setHidden(true);
    client.setHidden(false);

    expect(sent).toEqual([
      { type: "visibility", hidden: true },
      { type: "visibility", hidden: false },
    ]);
  });

  it("starts the live worker with its configuration", () => {
    const { client, sent } = setup();
    const config = { baseUrl: "/live/v1", pollMs: 1000, timeScale: 10, replay: true, probe: true };

    client.startLive(PALETTE, config);

    expect(sent).toEqual([{ type: "init-live", palette: PALETTE, config }]);
  });

  it("hands live selection info to its listener when there is one", () => {
    const fake = fakeWorker();
    const onLiveSelection = vi.fn();
    createMotionClient(fake.worker, {
      onFrame: vi.fn(),
      onStatus: vi.fn(),
      onLiveSelection,
    });

    fake.deliver({ type: "live-selection", info: null });

    expect(onLiveSelection).toHaveBeenCalledWith(null);
    expect(() => setup().deliver({ type: "live-selection", info: null })).not.toThrow();
  });

  it("answers continuity reports and diagnostics requests from the worker's replies", async () => {
    const { client, sent, deliver } = setup();
    const report = { measuredTrains: 3 } as never;
    const data = { trains: 7 } as never;

    expect(await client.continuity("start", 0.5)).toBeNull();
    const reported = client.continuity("report");
    deliver({ type: "continuity", report });
    const diagnosed = client.diagnostics();
    deliver({ type: "diagnostics", data });

    expect(await reported).toBe(report);
    expect(await diagnosed).toBe(data);
    expect(sent).toEqual([
      { type: "continuity", action: "start", sample: 0.5 },
      { type: "continuity", action: "report" },
      { type: "diagnostics" },
    ]);
  });

  it("terminates the worker", () => {
    const { client, worker } = setup();

    client.terminate();

    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("matches each nearest answer to its request, in any order", async () => {
    const { client, sent, deliver } = setup();
    const first = client.nearest({ lon: 8, lat: 50, count: 20 });
    const second = client.nearest({ lon: 9, lat: 51, count: 5 });
    const requests = sent.filter((message) => message.type === "nearest");
    expect(requests).toHaveLength(2);
    const [a, b] = requests as Extract<WorkerRequest, { type: "nearest" }>[];
    expect(a?.id).not.toBe(b?.id);
    deliver({ type: "nearest-trains", id: b?.id as number, result: { inView: 2, trains: [] } });
    deliver({ type: "nearest-trains", id: a?.id as number, result: { inView: 7, trains: [] } });
    await expect(first).resolves.toEqual({ inView: 7, trains: [] });
    await expect(second).resolves.toEqual({ inView: 2, trains: [] });
  });

  it("ignores an answer nobody asked for", () => {
    const { deliver } = setup();
    expect(() =>
      deliver({ type: "nearest-trains", id: 999, result: { inView: 0, trains: [] } }),
    ).not.toThrow();
  });

  it("tells the worker when the reduced motion preference changes", () => {
    const { client, sent } = setup();
    client.setReducedMotion(true);
    client.setReducedMotion(false);
    expect(sent).toEqual([
      { type: "reduced-motion", reduced: true },
      { type: "reduced-motion", reduced: false },
    ]);
  });

  it("rejects the nearest requests still waiting when the worker is terminated", async () => {
    const { client } = setup();
    const waiting = client.nearest({ lon: 8, lat: 50, count: 20 });
    client.terminate();
    await expect(waiting).rejects.toThrow(/terminated/);
  });
});
