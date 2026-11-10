import type { Clock } from "../clock.ts";
import { HeartbeatLock, LockLostError, type LockOwner } from "../recorder/lock.ts";

/** The lease file in the recordings folder, which the recorder container and the host CLI both see. */
export const IRIS_LEASE_PATH = ".db-timetables.lease";
export const IRIS_PROVIDER = "db-timetables";

const STALE_AFTER_MS = 90_000;
const RENEW_EVERY_MS = 20_000;

export interface IrisLeaseOptions {
  readonly root: string;
  readonly clock: Clock;
  readonly pid?: number;
  readonly host?: string;
  readonly renewEveryMs?: number;
}

function describeOwner(owner: LockOwner): string {
  return `IRIS lease is held by pid ${owner.pid} on ${owner.host} since ${owner.startedAt}`;
}

/**
 * The one claim on the DB Timetables budget (60 requests per minute for the whole application) shared by
 * every IRIS poller: the recorder and the `db-apis` CLI. A holder renews it at least every 20 s; a lease
 * not renewed for 90 s may be taken over.
 */
export class IrisLease {
  private readonly lock: HeartbeatLock;
  private readonly clock: Clock;
  private readonly renewEveryMs: number;
  private renewedAt: number | null = null;

  constructor(options: IrisLeaseOptions) {
    this.clock = options.clock;
    this.renewEveryMs = options.renewEveryMs ?? RENEW_EVERY_MS;
    this.lock = new HeartbeatLock({
      root: options.root,
      path: IRIS_LEASE_PATH,
      clock: options.clock,
      staleAfterMs: STALE_AFTER_MS,
      ...(options.pid === undefined ? {} : { pid: options.pid }),
      ...(options.host === undefined ? {} : { host: options.host }),
    });
  }

  /** Takes or renews the lease: null while this process holds it, else who does. */
  async hold(): Promise<string | null> {
    const now = this.clock.now();
    if (this.renewedAt !== null && (await this.renew(now))) return null;
    const owner = await this.lock.tryAcquire();
    if (owner !== null) return describeOwner(owner);
    this.renewedAt = now;
    return null;
  }

  async release(): Promise<void> {
    if (this.renewedAt === null) return;
    this.renewedAt = null;
    await this.lock.release();
  }

  private async renew(now: number): Promise<boolean> {
    if (now - (this.renewedAt ?? 0) < this.renewEveryMs) return true;
    try {
      await this.lock.heartbeat();
      this.renewedAt = now;
      return true;
    } catch (error) {
      if (!(error instanceof LockLostError)) throw error;
      this.renewedAt = null;
      return false;
    }
  }
}

/**
 * Runs an IRIS poll only with the lease: refuses to start while another process holds it, renews it while
 * the task runs, aborts the task's signal when a renewal finds it taken over, and releases it at the end.
 */
export async function withIrisLease<T>(
  options: IrisLeaseOptions,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const lease = new IrisLease(options);
  const heldBy = await lease.hold();
  if (heldBy) {
    throw new Error(`${heldBy}; only one IRIS poller may use the 60 per minute budget`);
  }
  const controller = new AbortController();
  const renew = async () => {
    const holder = await lease.hold().catch((error: unknown) => String(error));
    if (holder) controller.abort(new Error(holder));
  };
  const timer = setInterval(() => void renew(), options.renewEveryMs ?? RENEW_EVERY_MS);
  try {
    return await task(controller.signal);
  } finally {
    clearInterval(timer);
    await lease.release();
  }
}
