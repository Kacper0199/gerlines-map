import { type DataStatus, STATUS_CACHE_S } from "@gerlines/schema/status";
import { throttledLog } from "../trains/routes.ts";
import { buildDataStatus, type LiveFreshness } from "./build.ts";
import { STATUS_FEEDS, type StatusFeed } from "./feeds.ts";
import type { LiveFreshnessReader, RecorderStore } from "./store.ts";

export const STATUS_CACHE_MS = STATUS_CACHE_S * 1000;

export class StatusUnavailableError extends Error {
  override readonly name = "StatusUnavailableError";
  /** Seconds until the service reads again; the route sends them as Retry-After. */
  readonly retryAfterS: number;

  constructor(message: string, retryAfterS = STATUS_CACHE_S) {
    super(message);
    this.retryAfterS = retryAfterS;
  }
}

export interface StatusServiceOptions {
  readonly store: RecorderStore;
  readonly live?: LiveFreshnessReader | undefined;
  readonly logger: { error(line: string): void };
  readonly now?: () => number;
  readonly feeds?: readonly StatusFeed[];
}

interface Held {
  readonly at: number;
  readonly value: Promise<DataStatus>;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

/**
 * One answer per 30 s for every client: concurrent requests share one read, and a failed database
 * read is held for its 30 s too, so a slow or stopped database gets one read per 30 s and every
 * request in between is refused with the seconds left. The live store is optional; when it fails,
 * the answer says the live engine has no reading instead of failing. Logs name the error class
 * only, so no address or path of a store reaches them through a driver message.
 */
export class StatusService {
  private readonly store: RecorderStore;
  private readonly live: LiveFreshnessReader | undefined;
  private readonly now: () => number;
  private readonly feeds: readonly StatusFeed[];
  private readonly logStore: (line: string) => void;
  private readonly logLive: (line: string) => void;
  private held: Held | null = null;

  constructor({ store, live, logger, now = Date.now, feeds = STATUS_FEEDS }: StatusServiceOptions) {
    this.store = store;
    this.live = live;
    this.now = now;
    this.feeds = feeds;
    this.logStore = throttledLog(logger, now);
    this.logLive = throttledLog(logger, now);
  }

  /** The answer and the seconds it stays current. */
  async status(): Promise<{ readonly status: DataStatus; readonly maxAgeS: number }> {
    const at = this.now();
    if (!this.held || at - this.held.at >= STATUS_CACHE_MS) {
      const value = this.read(at);
      value.catch(() => undefined);
      this.held = { at, value };
    }
    const { at: readAt, value } = this.held;
    const secondsLeft = () =>
      Math.max(1, Math.ceil((readAt + STATUS_CACHE_MS - this.now()) / 1000));
    try {
      return { status: await value, maxAgeS: secondsLeft() };
    } catch (error) {
      if (error instanceof StatusUnavailableError) {
        throw new StatusUnavailableError(error.message, secondsLeft());
      }
      throw error;
    }
  }

  private async read(at: number): Promise<DataStatus> {
    const sources = this.feeds.flatMap((feed) => feed.sources);
    const prefixes = this.feeds.flatMap((feed) => (feed.prefix === undefined ? [] : [feed.prefix]));
    const [recorded, live] = await Promise.all([
      this.store.recorded(sources, prefixes).catch((error: unknown) => {
        this.logStore(`status: recorder rows unreadable (${errorName(error)})`);
        throw new StatusUnavailableError("recorder rows unreadable");
      }),
      this.readLive(),
    ]);
    return buildDataStatus({ recorded, live }, at, this.feeds);
  }

  private async readLive(): Promise<LiveFreshness | null> {
    if (!this.live) return null;
    try {
      return await this.live.freshness();
    } catch (error) {
      this.logLive(`status: live store unreadable (${errorName(error)})`);
      return null;
    }
  }
}
