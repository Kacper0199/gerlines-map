export interface StatsCacheOptions {
  readonly maxEntries?: number;
  readonly now?: () => number;
}

interface Entry {
  readonly expiresAt: number;
  readonly value: Promise<unknown>;
}

/**
 * Answers kept in process for a while, keyed by route and query. Concurrent requests for the same
 * key share one database read; a failed read is dropped at once so the next request retries.
 * The oldest entry goes first when the cache is full.
 */
export class StatsCache {
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor({ maxEntries = 500, now = Date.now }: StatsCacheOptions = {}) {
    this.maxEntries = maxEntries;
    this.now = now;
  }

  get size(): number {
    return this.entries.size;
  }

  /** True while an unexpired answer, or a read still running, is held for `key`. */
  holds(key: string): boolean {
    const found = this.entries.get(key);
    return found !== undefined && found.expiresAt > this.now();
  }

  read<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const found = this.entries.get(key);
    if (found && found.expiresAt > this.now()) return found.value as Promise<T>;
    if (found) this.entries.delete(key);
    const value = load();
    this.entries.set(key, { expiresAt: this.now() + ttlMs, value });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return value;
  }
}
