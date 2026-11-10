import type { MapLibreOverlay } from "@deck.gl/maplibre";
import type { Map as MapLibreMap } from "maplibre-gl";
import { buildLayer } from "./layers.ts";
import { ARCHITECTURE_THRESHOLDS, type LodThresholds, type TierOpacity, tierPlan } from "./lod.ts";
import { roundSummary } from "./probe.ts";
import type {
  RecycledChannel,
  Tier,
  WorkerFrameReply,
  WorkerFrameRequest,
  WorkerInit,
  WorkerReady,
  WorkerReply,
} from "./protocol.ts";
import type { FocusConfig } from "./scene.ts";
import { round, type Summary, summarize } from "./stats.ts";

const SIM_EPOCH_SECONDS = 1000;
const MARGIN_RATIO = 0.2;
const TRAIN_LENGTH_METRES = 10 * 25;
const CARS_PER_TRAIN = 10;

export interface RendererConfig {
  trainCount: number;
  tiers: Tier[] | "auto";
  thresholds: LodThresholds;
  baseHeightMetres: number;
  focus: FocusConfig | null;
  workerSlowdown: number;
}

export interface RendererStats {
  repliesPerSecond: number;
  workerMs: { total: Summary; advance: Summary; select: Summary; emit: Summary };
  roundTripMs: Summary;
  mainUpdateMs: Summary;
  visibleTrains: Summary;
  instances: Record<string, Summary>;
  transferredKilobytesPerFrame: Summary;
  byZoom: ZoneStats[];
}

export interface ZoneStats {
  zoomFrom: number;
  replies: number;
  workerP50: number;
  workerP95: number;
  visibleMean: number;
  instancesMean: number;
}

const ZONE_WIDTH = 0.5;

interface Collected {
  total: number[];
  advance: number[];
  select: number[];
  emit: number[];
  roundTrip: number[];
  mainUpdate: number[];
  visible: number[];
  bytes: number[];
  instances: Record<string, number[]>;
  zooms: number[];
  instanceTotals: number[];
  startedAt: number;
}

function emptyCollected(): Collected {
  return {
    total: [],
    advance: [],
    select: [],
    emit: [],
    roundTrip: [],
    mainUpdate: [],
    visible: [],
    bytes: [],
    instances: {},
    zooms: [],
    instanceTotals: [],
    startedAt: performance.now(),
  };
}

export class TrainRenderer {
  private readonly worker: Worker;
  private config: RendererConfig = {
    trainCount: 0,
    tiers: [],
    thresholds: ARCHITECTURE_THRESHOLDS,
    baseHeightMetres: 0,
    focus: null,
    workerSlowdown: 1,
  };
  private running = false;
  private pending = false;
  private frameId = 0;
  private postedAt = 0;
  private simStart = 0;
  private held: RecycledChannel[][] = [];
  private plan: TierOpacity[] = [];
  private collected: Collected = emptyCollected();
  private readyResolver: ((ready: WorkerReady) => void) | null = null;
  private readonly map: MapLibreMap;
  private readonly overlay: MapLibreOverlay;
  private readonly fixtureUrl: string;

  constructor(map: MapLibreMap, overlay: MapLibreOverlay, fixtureUrl: string) {
    this.map = map;
    this.overlay = overlay;
    this.fixtureUrl = fixtureUrl;
    this.worker = new Worker(new URL("./worker/motion.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      if (event.data.type === "ready") this.readyResolver?.(event.data);
      else this.onFrame(event.data);
    };
  }

  configure(config: RendererConfig): Promise<WorkerReady> {
    this.stop();
    this.config = config;
    const init: WorkerInit = {
      type: "init",
      fixtureUrl: this.fixtureUrl,
      trainCount: config.trainCount,
      carsPerTrain: CARS_PER_TRAIN,
      baseHeightMetres: config.baseHeightMetres,
      focus: config.focus,
      workerSlowdown: config.workerSlowdown,
    };
    return new Promise((resolve) => {
      this.readyResolver = resolve;
      this.worker.postMessage(init);
    });
  }

  start(): void {
    this.simStart = performance.now();
    this.pending = false;
    this.running = true;
    requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    this.pending = false;
    this.held = [];
    this.overlay.setProps({ layers: [] });
  }

  resetStats(): void {
    this.collected = emptyCollected();
  }

  private readonly tick = (): void => {
    if (!this.running) return;
    requestAnimationFrame(this.tick);
    if (this.pending) return;
    this.pending = true;
    this.postFrame();
  };

  private postFrame(): void {
    const bounds = this.map.getBounds();
    this.plan =
      this.config.tiers === "auto"
        ? tierPlan(this.map.getZoom(), this.config.thresholds)
        : this.config.tiers.map((tier) => ({ tier, opacity: 1 }));
    const recycle: RecycledChannel[] = this.held
      .splice(0, Math.max(0, this.held.length - 1))
      .flat();
    const request: WorkerFrameRequest = {
      type: "frame",
      frameId: ++this.frameId,
      nowSeconds: SIM_EPOCH_SECONDS + (performance.now() - this.simStart) / 1000,
      bounds: {
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
      },
      marginRatio: MARGIN_RATIO,
      tiers: this.plan.map((entry) => entry.tier),
      trainLengthMetres: TRAIN_LENGTH_METRES,
      recycle,
    };
    this.postedAt = performance.now();
    this.worker.postMessage(
      request,
      recycle.map((channel) => channel.buffer),
    );
  }

  private onFrame(reply: WorkerFrameReply): void {
    const received = performance.now();
    if (!this.running) return;
    const opacityOf = (tier: Tier) => this.plan.find((entry) => entry.tier === tier)?.opacity ?? 1;
    const layers = reply.tiers.map((payload) => buildLayer(payload, opacityOf(payload.tier)));
    this.overlay.setProps({ layers });
    const finished = performance.now();
    this.held.push(
      reply.tiers.flatMap((payload) =>
        Object.values(payload.channels).map(({ key, buffer }) => ({ key, buffer })),
      ),
    );
    this.pending = false;
    this.record(reply, received - this.postedAt, finished - received);
  }

  private record(reply: WorkerFrameReply, roundTripMs: number, mainUpdateMs: number): void {
    const c = this.collected;
    c.total.push(reply.timings.totalMs);
    c.advance.push(reply.timings.advanceMs);
    c.select.push(reply.timings.selectMs);
    c.emit.push(reply.timings.emitMs);
    c.roundTrip.push(roundTripMs);
    c.mainUpdate.push(mainUpdateMs);
    c.visible.push(reply.visibleCount);
    c.bytes.push(reply.transferredBytes / 1024);
    c.zooms.push(this.map.getZoom());
    c.instanceTotals.push(reply.tiers.reduce((sum, payload) => sum + payload.count, 0));
    for (const payload of reply.tiers) {
      const list = c.instances[payload.tier] ?? [];
      list.push(payload.count);
      c.instances[payload.tier] = list;
    }
  }

  snapshot(): RendererStats {
    const c = this.collected;
    const seconds = (performance.now() - c.startedAt) / 1000;
    return {
      repliesPerSecond: round(c.total.length / seconds, 1),
      workerMs: {
        total: roundSummary(summarize(c.total)),
        advance: roundSummary(summarize(c.advance)),
        select: roundSummary(summarize(c.select)),
        emit: roundSummary(summarize(c.emit)),
      },
      roundTripMs: roundSummary(summarize(c.roundTrip)),
      mainUpdateMs: roundSummary(summarize(c.mainUpdate)),
      visibleTrains: roundSummary(summarize(c.visible)),
      instances: Object.fromEntries(
        Object.entries(c.instances).map(([tier, values]) => [
          tier,
          roundSummary(summarize(values)),
        ]),
      ),
      transferredKilobytesPerFrame: roundSummary(summarize(c.bytes)),
      byZoom: this.zoneStats(),
    };
  }

  private zoneStats(): ZoneStats[] {
    const c = this.collected;
    const zones = new Map<number, number[]>();
    c.zooms.forEach((zoom, index) => {
      const key = Math.floor(zoom / ZONE_WIDTH) * ZONE_WIDTH;
      const list = zones.get(key) ?? [];
      list.push(index);
      zones.set(key, list);
    });
    return [...zones.entries()]
      .sort(([a], [b]) => a - b)
      .map(([zoomFrom, indices]) => {
        const worker = summarize(indices.map((index) => c.total[index] ?? 0));
        return {
          zoomFrom,
          replies: indices.length,
          workerP50: round(worker.p50),
          workerP95: round(worker.p95),
          visibleMean: Math.round(summarize(indices.map((index) => c.visible[index] ?? 0)).mean),
          instancesMean: Math.round(
            summarize(indices.map((index) => c.instanceTotals[index] ?? 0)).mean,
          ),
        };
      });
  }
}
