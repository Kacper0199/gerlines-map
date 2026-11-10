import type { Clock } from "../clock.ts";
import { TokenBucket } from "../policy/token-bucket.ts";
import { DEFAULT_PROVIDER_LIMIT, type ProviderLimit } from "../sources.ts";
import { Semaphore } from "./semaphore.ts";

/** A claim on a provider shared with other processes: null while this process holds it, else who does. */
export interface ProviderLease {
  hold(): Promise<string | null>;
}

export type Admission = { readonly ran: true } | { readonly ran: false; readonly heldBy?: string };

export interface ProviderGateOptions {
  readonly clock: Clock;
  readonly limits: Readonly<Record<string, ProviderLimit>>;
  readonly inFlight: Semaphore;
  readonly leases?: Readonly<Record<string, ProviderLease>>;
}

/**
 * Admits each request of a provider: after any pause the provider asked for (429 or 503), with the
 * provider's lease when one is shared with other processes, within its token bucket and the shared
 * in-flight slots. A `serial` provider has its own lane of one and takes its token only once it holds a
 * shared slot, so the bucket spaces the requests as they are sent, not as they queue.
 */
export class ProviderGate {
  private readonly options: ProviderGateOptions;
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly lanes = new Map<string, Semaphore>();
  private readonly pausedUntil = new Map<string, number>();

  constructor(options: ProviderGateOptions) {
    this.options = options;
  }

  run(provider: string, signal: AbortSignal, task: () => Promise<void>): Promise<Admission> {
    if (!this.limit(provider).serial) return this.admit(provider, signal, task);
    return this.lane(provider).run(() => this.admit(provider, signal, task));
  }

  /** Holds every later request of the provider back for `ms`; a shorter pause never shortens a longer one. */
  pause(provider: string, ms: number): void {
    const until = this.options.clock.now() + ms;
    this.pausedUntil.set(provider, Math.max(this.pausedUntil.get(provider) ?? 0, until));
  }

  private async admit(
    provider: string,
    signal: AbortSignal,
    task: () => Promise<void>,
  ): Promise<Admission> {
    await this.waitOutPause(provider, signal);
    if (signal.aborted) return { ran: false };
    const heldBy = await this.options.leases?.[provider]?.hold();
    if (heldBy) return { ran: false, heldBy };
    if (this.limit(provider).serial) {
      return this.options.inFlight.run(async () => {
        await this.takeToken(provider, signal);
        if (signal.aborted) return { ran: false };
        await task();
        return { ran: true };
      });
    }
    await this.takeToken(provider, signal);
    if (signal.aborted) return { ran: false };
    await this.options.inFlight.run(task);
    return { ran: true };
  }

  private async waitOutPause(provider: string, signal: AbortSignal): Promise<void> {
    const { clock } = this.options;
    for (;;) {
      const wait = (this.pausedUntil.get(provider) ?? 0) - clock.now();
      if (wait <= 0 || signal.aborted) return;
      await clock.sleep(wait, signal);
    }
  }

  private takeToken(provider: string, signal: AbortSignal): Promise<void> {
    return this.options.clock.sleep(this.bucket(provider).take(), signal);
  }

  private limit(provider: string): ProviderLimit {
    return this.options.limits[provider] ?? DEFAULT_PROVIDER_LIMIT;
  }

  private lane(provider: string): Semaphore {
    let lane = this.lanes.get(provider);
    if (!lane) {
      lane = new Semaphore(1);
      this.lanes.set(provider, lane);
    }
    return lane;
  }

  private bucket(provider: string): TokenBucket {
    let bucket = this.buckets.get(provider);
    if (!bucket) {
      bucket = new TokenBucket(this.limit(provider), () => this.options.clock.now());
      this.buckets.set(provider, bucket);
    }
    return bucket;
  }
}
