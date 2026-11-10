import { fetchFixture, type LoadedFixture, prepareFixture } from "../fixture.ts";
import type {
  ChannelPayload,
  Tier,
  TierPayload,
  WorkerFrameReply,
  WorkerFrameRequest,
  WorkerInit,
  WorkerReady,
  WorkerRequest,
} from "../protocol.ts";
import { DEFAULT_SCENE_CONFIG, type Emission, Scene } from "../scene.ts";
import { ChannelPool } from "./pool.ts";
import { busyWait, slowdownWaitMs } from "./slowdown.ts";

const pool = new ChannelPool();
let fixture: LoadedFixture | undefined;
let scene: Scene | undefined;
let lastNowSeconds = Number.NaN;
let slowdown = 1;

function post(message: WorkerReady | WorkerFrameReply, transfer: Transferable[] = []): void {
  globalThis.postMessage(message, { transfer });
}

async function initialize(request: WorkerInit): Promise<void> {
  const started = performance.now();
  fixture ??= prepareFixture(await fetchFixture(request.fixtureUrl));
  scene = new Scene(fixture.store, fixture.durations, fixture.categories, fixture.categoryRgba, {
    ...DEFAULT_SCENE_CONFIG,
    trainCount: request.trainCount,
    carsPerTrain: request.carsPerTrain,
    baseHeightMetres: request.baseHeightMetres,
    focus: request.focus,
  });
  lastNowSeconds = Number.NaN;
  slowdown = Math.max(1, Math.round(request.workerSlowdown));
  post({
    type: "ready",
    trainCount: request.trainCount,
    segmentCount: fixture.durations.length,
    shapeVertices: fixture.store.cumulative.length,
    initMs: performance.now() - started,
  });
}

function emit(active: Scene, tier: Tier, trainLengthMetres: number): Emission {
  pool.begin(tier);
  switch (tier) {
    case "dots":
      return active.emitDots(pool);
    case "icons":
      return active.emitIcons(pool);
    case "slices":
      return active.emitSlices(pool, trainLengthMetres);
    case "cars":
      return active.emitCars(pool);
  }
}

function payloadFor(tier: Tier, emission: Emission): TierPayload {
  const channels: Record<string, ChannelPayload> = {};
  for (const channel of pool.take()) {
    channels[channel.key.slice(tier.length + 1)] = channel;
  }
  return { tier, count: emission.count, vertexCount: emission.vertexCount ?? 0, channels };
}

interface PassResult {
  tiers: TierPayload[];
  transfer: Transferable[];
  transferredBytes: number;
  advanceMs: number;
  selectMs: number;
  emitMs: number;
}

function pass(active: Scene, request: WorkerFrameRequest, dt: number): PassResult {
  const started = performance.now();
  active.advance(request.nowSeconds, dt);
  const advanced = performance.now();
  active.select(request.bounds, request.marginRatio);
  const selected = performance.now();
  const tiers: TierPayload[] = [];
  const transfer: Transferable[] = [];
  let transferredBytes = 0;
  for (const tier of request.tiers) {
    const payload = payloadFor(tier, emit(active, tier, request.trainLengthMetres));
    tiers.push(payload);
    for (const channel of Object.values(payload.channels)) {
      transfer.push(channel.buffer);
      transferredBytes += channel.buffer.byteLength;
    }
  }
  const finished = performance.now();
  return {
    tiers,
    transfer,
    transferredBytes,
    advanceMs: advanced - started,
    selectMs: selected - advanced,
    emitMs: finished - selected,
  };
}

function frame(request: WorkerFrameRequest): void {
  if (!scene) return;
  const started = performance.now();
  pool.recycle(request.recycle);
  const dt = Number.isNaN(lastNowSeconds) ? 1 / 60 : request.nowSeconds - lastNowSeconds;
  lastNowSeconds = request.nowSeconds;
  const result = pass(scene, request, dt);
  busyWait(slowdownWaitMs(result.advanceMs + result.selectMs + result.emitMs, slowdown));
  const finished = performance.now();
  post(
    {
      type: "frame",
      frameId: request.frameId,
      tiers: result.tiers,
      timings: {
        advanceMs: result.advanceMs * slowdown,
        selectMs: result.selectMs * slowdown,
        emitMs: result.emitMs * slowdown,
        totalMs: finished - started,
      },
      trainsTotal: scene.trainCount,
      visibleCount: scene.visibleCount,
      transferredBytes: result.transferredBytes,
    },
    result.transfer,
  );
}

globalThis.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.type === "init") void initialize(request);
  else frame(request);
};
