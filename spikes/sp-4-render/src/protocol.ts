import type { Bounds, FocusConfig } from "./scene.ts";

export type Tier = "dots" | "icons" | "slices" | "cars";
export const TIERS: readonly Tier[] = ["dots", "icons", "slices", "cars"];

export type ChannelKind = "f64" | "f32" | "u8" | "u32";

export interface ChannelPayload {
  key: string;
  kind: ChannelKind;
  buffer: ArrayBuffer;
  length: number;
}

export interface TierPayload {
  tier: Tier;
  count: number;
  vertexCount: number;
  channels: Record<string, ChannelPayload>;
}

export interface RecycledChannel {
  key: string;
  buffer: ArrayBuffer;
}

export interface WorkerInit {
  type: "init";
  fixtureUrl: string;
  trainCount: number;
  carsPerTrain: number;
  baseHeightMetres: number;
  focus: FocusConfig | null;
  workerSlowdown: number;
}

export interface WorkerFrameRequest {
  type: "frame";
  frameId: number;
  nowSeconds: number;
  bounds: Bounds;
  marginRatio: number;
  tiers: Tier[];
  trainLengthMetres: number;
  recycle: RecycledChannel[];
}

export type WorkerRequest = WorkerInit | WorkerFrameRequest;

export interface WorkerReady {
  type: "ready";
  trainCount: number;
  segmentCount: number;
  shapeVertices: number;
  initMs: number;
}

export interface FrameTimings {
  advanceMs: number;
  selectMs: number;
  emitMs: number;
  totalMs: number;
}

export interface WorkerFrameReply {
  type: "frame";
  frameId: number;
  tiers: TierPayload[];
  timings: FrameTimings;
  trainsTotal: number;
  visibleCount: number;
  transferredBytes: number;
}

export type WorkerReply = WorkerReady | WorkerFrameReply;
