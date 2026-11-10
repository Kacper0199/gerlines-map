import type { Clock } from "../clock.ts";
import type { FetchRecord } from "../storage/sidecar.ts";
import { payloadsInOrder, type StoredPayload } from "./payload-stream.ts";
import type { Processor } from "./processor.ts";

/** Virtual time that runs `speed` times faster than the wall clock from `start`; speed 0 never waits. */
export class VirtualClock implements Clock {
  readonly start: number;
  readonly speed: number;
  private readonly wall: Clock;
  private readonly wallStart: number;
  private skipped = 0;

  constructor(start: number, speed: number, wall: Clock) {
    this.start = start;
    this.speed = speed;
    this.wall = wall;
    this.wallStart = wall.now();
  }

  now(): number {
    if (this.speed <= 0) return this.start + this.skipped;
    return this.start + (this.wall.now() - this.wallStart) * this.speed + this.skipped;
  }

  /** Moves virtual time to `instant`: waits for it at speed N, or jumps there at speed 0. */
  async until(instant: number, signal?: AbortSignal): Promise<void> {
    const ahead = instant - this.now();
    if (ahead <= 0) return;
    if (this.speed <= 0) {
      this.skipped += ahead;
      return;
    }
    await this.wall.sleep(ahead / this.speed, signal);
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return this.until(this.now() + ms, signal);
  }
}

/** Deterministic pseudo-random numbers (mulberry32) so a shuffled replay can be repeated. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function shuffle<T>(items: T[], random: () => number): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [items[index], items[other]] = [items[other] as T, items[index] as T];
  }
  return items;
}

export interface ReplayPlan {
  readonly rounds: readonly (readonly FetchRecord[])[];
  readonly duplicates: number;
}

/**
 * Delivery plan of a shuffled replay: every payload goes to one random round, a share of them is
 * delivered once more in a random round as a duplicate. Each round streams oldest first in small
 * batches whose items arrive in random order, so rounds after the first bring late payloads.
 */
export function shuffledPlan(
  records: readonly FetchRecord[],
  rounds: number,
  duplicateShare: number,
  random: () => number,
): ReplayPlan {
  const plan: FetchRecord[][] = Array.from({ length: rounds }, () => []);
  let duplicates = 0;
  for (const record of records) {
    plan[Math.floor(random() * rounds)]?.push(record);
    if (random() < duplicateShare) {
      plan[Math.floor(random() * rounds)]?.push(record);
      duplicates += 1;
    }
  }
  return { rounds: plan, duplicates };
}

export interface ReplayResult {
  readonly delivered: number;
  readonly batches: number;
  readonly virtualStart: number;
  readonly virtualEnd: number;
}

async function deliver(
  processor: Processor,
  payloads: AsyncIterable<StoredPayload>,
  clock: VirtualClock,
  batchSize: number,
  random: (() => number) | null,
): Promise<{ delivered: number; batches: number }> {
  let batch: StoredPayload[] = [];
  let delivered = 0;
  let batches = 0;
  const flushBatch = async () => {
    if (batch.length === 0) return;
    await processor.processBatch(random ? shuffle(batch, random) : batch);
    delivered += batch.length;
    batches += 1;
    batch = [];
  };
  for await (const item of payloads) {
    const at = Date.parse(item.record.observedAt);
    if (random === null && at > clock.now()) {
      await flushBatch();
      await clock.until(at);
    }
    batch.push(item);
    if (batch.length >= batchSize) await flushBatch();
  }
  await flushBatch();
  return { delivered, batches };
}

/**
 * Streams recorded payloads through the processor. In order: a payload is delivered once the virtual
 * clock passes the instant it represents. Shuffled: the rounds of the plan one after the other.
 */
export async function replay(options: {
  readonly root: string;
  readonly processor: Processor;
  readonly records: readonly FetchRecord[];
  readonly bySegment: ReadonlyMap<string, readonly FetchRecord[]>;
  readonly clock: VirtualClock;
  readonly plan?: ReplayPlan;
  readonly random?: () => number;
}): Promise<ReplayResult> {
  const { root, processor, clock, bySegment } = options;
  let delivered = 0;
  let batches = 0;
  if (!options.plan) {
    const result = await deliver(
      processor,
      payloadsInOrder(root, options.records, bySegment),
      clock,
      1,
      null,
    );
    delivered += result.delivered;
    batches += result.batches;
  } else {
    const random = options.random ?? Math.random;
    for (const round of options.plan.rounds) {
      const result = await deliver(
        processor,
        payloadsInOrder(root, round, bySegment),
        clock,
        8,
        random,
      );
      delivered += result.delivered;
      batches += result.batches;
      await processor.flush();
    }
  }
  await processor.flush({ releaseAll: true });
  return { delivered, batches, virtualStart: clock.start, virtualEnd: clock.now() };
}
