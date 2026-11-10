import type { TrainDetail } from "@gerlines/schema";
import {
  DETAIL_CONFIRMED_KEY,
  DETAIL_FEEDS_KEY,
  DETAIL_TTL_S,
  trainDetailKey,
  trainLeftKey,
} from "./keys.ts";

/** The part of an iovalkey pipeline the detail store uses. */
export interface ValkeyPipeline {
  set(key: string, value: string, mode: "EX", seconds: number): ValkeyPipeline;
  hset(key: string, values: Record<string, string>): ValkeyPipeline;
  del(...keys: string[]): ValkeyPipeline;
  expire(key: string, seconds: number): ValkeyPipeline;
  exec(): Promise<[Error | null, unknown][] | null>;
}

export interface ValkeyWriter {
  pipeline(): ValkeyPipeline;
}

/** Seconds a detail stays readable: until 15 min after its run ends (Unix seconds), at least 15 min. */
export function runTtlSeconds(endsAt: number, now: number, minimum = DETAIL_TTL_S): number {
  return Math.max(minimum, Math.ceil(endsAt - now) + DETAIL_TTL_S);
}

export interface DetailStore {
  /**
   * Writes each detail under its key with its TTL in seconds (by trip instance), else the default,
   * and for a train that left the running set the moment it left (epoch ms) beside it; a train
   * written without one is running again, so its marker goes.
   */
  write(
    details: readonly TrainDetail[],
    ttlS?: ReadonlyMap<string, number>,
    leftAt?: ReadonlyMap<string, number>,
  ): Promise<void>;
  /** Deletes the stored details of trains whose new state could not be built. */
  discard(tripInstanceIds: readonly string[]): Promise<void>;
  /** Records the tick time and the newest payload per source, read by the API for `asOf`. */
  confirm(at: number, feeds: ReadonlyMap<string, number>): Promise<void>;
}

export class StoreWriteError extends Error {
  override readonly name = "StoreWriteError";
}

async function run(pipeline: ValkeyPipeline): Promise<void> {
  const replies = await pipeline.exec();
  const failed = replies?.find(([error]) => error !== null);
  if (failed?.[0]) throw new StoreWriteError(failed[0].message);
}

export class ValkeyDetailStore implements DetailStore {
  private readonly client: ValkeyWriter;
  private readonly ttlS: number;

  constructor(client: ValkeyWriter, ttlS = DETAIL_TTL_S) {
    this.client = client;
    this.ttlS = ttlS;
  }

  async write(
    details: readonly TrainDetail[],
    ttlS?: ReadonlyMap<string, number>,
    leftAt?: ReadonlyMap<string, number>,
  ): Promise<void> {
    if (details.length === 0) return;
    const pipeline = this.client.pipeline();
    for (const detail of details) {
      const id = detail.tripInstanceId;
      const seconds = ttlS?.get(id) ?? this.ttlS;
      pipeline.set(trainDetailKey(id), JSON.stringify(detail), "EX", seconds);
      const left = leftAt?.get(id);
      if (left === undefined) pipeline.del(trainLeftKey(id));
      else pipeline.set(trainLeftKey(id), new Date(left).toISOString(), "EX", seconds);
    }
    await run(pipeline);
  }

  async discard(tripInstanceIds: readonly string[]): Promise<void> {
    if (tripInstanceIds.length === 0) return;
    const keys = tripInstanceIds.flatMap((id) => [trainDetailKey(id), trainLeftKey(id)]);
    await run(this.client.pipeline().del(...keys));
  }

  async confirm(at: number, feeds: ReadonlyMap<string, number>): Promise<void> {
    const pipeline = this.client.pipeline();
    pipeline.set(DETAIL_CONFIRMED_KEY, new Date(at).toISOString(), "EX", this.ttlS);
    if (feeds.size > 0) {
      const values = Object.fromEntries(
        [...feeds].map(([source, observed]) => [source, new Date(observed).toISOString()]),
      );
      pipeline.hset(DETAIL_FEEDS_KEY, values);
      pipeline.expire(DETAIL_FEEDS_KEY, this.ttlS);
    }
    await run(pipeline);
  }
}
