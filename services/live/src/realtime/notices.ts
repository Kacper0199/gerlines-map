import pg from "pg";

/** WP-2.3b's channel for a source's rows of some service days written again (`notifyRebuilt`). */
export const REBUILD_CHANNEL = "realtime_rebuild";

/**
 * A rebuild of `foldSourceId`'s rows of `serviceDates`. Null in either field means anything may have
 * changed (a notice that could not be read, or notices lost while the listener was disconnected).
 */
export interface RebuildNotice {
  readonly foldSourceId: string | null;
  readonly serviceDates: readonly string[] | null;
}

export const EVERYTHING: RebuildNotice = { foldSourceId: null, serviceDates: null };

/** Rebuild notices received since the last drain. */
export interface RebuildNotices {
  drain(): RebuildNotice[];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Reads a notice payload; anything unexpected becomes a notice for everything. */
export function parseRebuildNotice(payload: string | undefined): RebuildNotice {
  let value: unknown;
  try {
    value = JSON.parse(payload ?? "");
  } catch {
    return EVERYTHING;
  }
  if (typeof value !== "object" || value === null) return EVERYTHING;
  const { foldSourceId, serviceDates } = value as Record<string, unknown>;
  if (typeof foldSourceId !== "string" || foldSourceId.trim() === "") return EVERYTHING;
  if (!Array.isArray(serviceDates) || serviceDates.length === 0) return EVERYTHING;
  if (!serviceDates.every((day) => typeof day === "string" && DAY.test(day))) return EVERYTHING;
  return { foldSourceId, serviceDates: [...(serviceDates as string[])].sort() };
}

/** A queue fed by hand (tests) or by a listener. */
export class NoticeQueue implements RebuildNotices {
  private pending: RebuildNotice[] = [];

  push(notice: RebuildNotice): void {
    this.pending.push(notice);
  }

  drain(): RebuildNotice[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}

export interface ListenerOptions {
  readonly connectionString: string;
  readonly applicationName?: string;
  readonly log?: (fields: Record<string, unknown>) => void;
  /** First wait before a reconnect (ms), doubled up to `maxRetryMs`. */
  readonly retryMs?: number;
  readonly maxRetryMs?: number;
  /** How often (ms) the connection is probed with `SELECT 1` (a half-open TCP never ends). */
  readonly probeMs?: number;
}

/** A probe or LISTEN that takes longer than this (ms) counts as a lost connection. */
const LISTEN_QUERY_TIMEOUT_MS = 10_000;

/**
 * `LISTEN realtime_rebuild` on a connection of its own. A notice is delivered when its rebuild
 * commits. When the connection is lost it reconnects with backoff and then queues a notice for
 * everything, since notices sent meanwhile are gone. TCP keepalive and a periodic probe find a
 * half-open connection, which would otherwise never fire `error` or `end`.
 */
export class RebuildListener extends NoticeQueue {
  readonly #options: ListenerOptions;
  #client: pg.Client | null = null;
  #closed = false;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #probe: ReturnType<typeof setInterval> | null = null;
  #wait: number;

  constructor(options: ListenerOptions) {
    super();
    this.#options = options;
    this.#wait = options.retryMs ?? 1_000;
  }

  /** Connects and listens; throws when the first connection fails. */
  async start(): Promise<void> {
    await this.#connect();
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#retry) clearTimeout(this.#retry);
    this.#stopProbe();
    const client = this.#client;
    this.#client = null;
    await client?.end().catch(() => undefined);
  }

  async #connect(): Promise<void> {
    const client = new pg.Client({
      connectionString: this.#options.connectionString,
      application_name: this.#options.applicationName ?? "gerlines-live-listen",
      keepAlive: true,
      keepAliveInitialDelayMillis: 30_000,
      query_timeout: LISTEN_QUERY_TIMEOUT_MS,
    });
    client.on("notification", (message) => {
      if (message.channel === REBUILD_CHANNEL) this.push(parseRebuildNotice(message.payload));
    });
    client.on("error", (error) => this.#lost(client, error));
    client.on("end", () => this.#lost(client, null));
    try {
      await client.connect();
      await client.query(`LISTEN ${REBUILD_CHANNEL}`);
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
    this.#client = client;
    this.#wait = this.#options.retryMs ?? 1_000;
    this.#startProbe(client);
  }

  #startProbe(client: pg.Client): void {
    this.#stopProbe();
    this.#probe = setInterval(() => {
      client.query("SELECT 1").catch((error: unknown) => this.#lost(client, error));
    }, this.#options.probeMs ?? 60_000);
    this.#probe.unref();
  }

  #stopProbe(): void {
    if (this.#probe) clearInterval(this.#probe);
    this.#probe = null;
  }

  #lost(client: pg.Client, error: unknown): void {
    if (this.#closed || this.#client !== client) return;
    this.#client = null;
    this.#stopProbe();
    client.end().catch(() => undefined);
    this.#options.log?.({ msg: "rebuild listener lost", error: error ? String(error) : null });
    this.#schedule();
  }

  #schedule(): void {
    if (this.#closed) return;
    const wait = this.#wait;
    this.#wait = Math.min(wait * 2, this.#options.maxRetryMs ?? 30_000);
    this.#retry = setTimeout(() => {
      this.#retry = null;
      this.#connect().then(
        () => {
          this.push(EVERYTHING);
          this.#options.log?.({ msg: "rebuild listener reconnected" });
        },
        (error: unknown) => {
          this.#options.log?.({ msg: "rebuild listener reconnect failed", error: String(error) });
          this.#schedule();
        },
      );
    }, wait);
  }
}
