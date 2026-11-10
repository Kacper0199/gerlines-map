import { localDate } from "@gerlines/schema/service-day";
import type { PlaceRecord } from "./records.ts";
import { SearchIndex } from "./search-index.ts";
import { nextTurn, type Pause, runSliced, SLICE_SIZE } from "./slices.ts";
import type { TimetableSearchSource } from "./timetable-source.ts";
import { validating } from "./valid-records.ts";

export const SEARCH_RETRY_MS = 60_000;
export const SEARCH_LOAD_TIMEOUT_MS = 120_000;
export const SEARCH_VERSION_CHECK_MS = 3_600_000;
export const SEARCH_MAX_STALE_MS = 3 * 3_600_000;

export interface SearchServiceOptions {
  readonly timetable: TimetableSearchSource;
  readonly places: () => Promise<readonly PlaceRecord[]>;
  readonly now?: () => number;
  readonly logger?: { error(line: string): void };
  readonly retryMs?: number;
  readonly loadTimeoutMs?: number;
  readonly pause?: Pause;
  readonly sliceSize?: number;
}

/**
 * Runs `work` until `ms` have passed, then aborts its signal and stops waiting. A source starts no
 * further query once the signal is aborted; a statement already running ends at the statement
 * timeout (30 s), well before the retry pause (60 s), so a retry does not overlap the old load.
 */
function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`the load did not finish within ${ms} ms`);
      controller.abort(error);
      reject(error);
    }, ms);
  });
  return Promise.race([work(controller.signal), deadline]).finally(() => clearTimeout(timer));
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Holds the index of the current Berlin service day. The first request of a new day starts the
 * reload in the background and keeps answering from the old day until the new one is ready; a
 * failed or hung load is retried after a minute, never on every request. Once an hour the loaded
 * timetable version is compared with the database, so a version loaded mid-day is picked up. An
 * index of an earlier day is served for at most three hours into the new day. A broken places file
 * leaves out places only. Records are checked and the index is built in slices with a turn of the
 * event loop between them, so requests are answered while a day is prepared.
 */
export class SearchService {
  private readonly options: SearchServiceOptions;
  private readonly now: () => number;
  private index: SearchIndex | null = null;
  private loading: Promise<void> | null = null;
  private failedAt = Number.NEGATIVE_INFINITY;
  private places: Promise<readonly PlaceRecord[]> | null = null;
  private checkedAt = Number.NEGATIVE_INFINITY;
  private staleSince: number | null = null;

  constructor(options: SearchServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /** The index to answer from, or null while the first load runs or after it failed. */
  current(): SearchIndex | null {
    const now = this.now();
    const today = localDate(now);
    if (this.index === null || this.index.serviceDate === today) {
      this.staleSince = null;
      if (this.index !== null) this.checkVersion(today, now);
      else void this.refresh(today);
      return this.index;
    }
    this.staleSince ??= now;
    void this.refresh(today);
    return now - this.staleSince < SEARCH_MAX_STALE_MS ? this.index : null;
  }

  private checkVersion(today: string, now: number): void {
    const read = this.options.timetable.version;
    if (!read || now - this.checkedAt < SEARCH_VERSION_CHECK_MS || this.loading) return;
    this.checkedAt = now;
    const loaded = this.index?.timetableVersion;
    void read
      .call(this.options.timetable, today)
      .then((version) => {
        if (version !== loaded) void this.refresh(today);
      })
      .catch((error: unknown) => {
        this.options.logger?.error(`search timetable version check failed: ${describe(error)}`);
      });
  }

  /** Loads today's index (used at start so the first request already has one). */
  async ready(): Promise<void> {
    await this.refresh(localDate(this.now()));
  }

  private refresh(serviceDate: string): Promise<void> {
    if (this.loading) return this.loading;
    const retryMs = this.options.retryMs ?? SEARCH_RETRY_MS;
    if (this.now() - this.failedAt < retryMs) return Promise.resolve();
    this.loading = this.load(serviceDate).finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async load(serviceDate: string): Promise<void> {
    try {
      this.places ??= this.options.places().catch((error: unknown) => {
        this.places = null;
        this.options.logger?.error(
          `search places failed: ${describe(error)}: answering without places`,
        );
        return [];
      });
      const placesLoad = this.places;
      const [timetable, places] = await withDeadline(
        (signal) => Promise.all([this.options.timetable.load(serviceDate, signal), placesLoad]),
        this.options.loadTimeoutMs ?? SEARCH_LOAD_TIMEOUT_MS,
      );
      const pause = this.options.pause ?? nextTurn;
      const sliceSize = this.options.sliceSize ?? SLICE_SIZE;
      const { data, dropped } = await runSliced(
        validating({ ...timetable, places }, sliceSize),
        pause,
      );
      const counts = Object.entries(dropped).filter(([, count]) => count > 0);
      if (counts.length > 0) {
        const list = counts.map(([kind, count]) => `${count} ${kind}`).join(", ");
        this.options.logger?.error(
          `search index for ${serviceDate} dropped invalid records: ${list}`,
        );
      }
      this.index = await SearchIndex.build(data, { pause, sliceSize });
      this.checkedAt = this.now();
    } catch (error) {
      this.failedAt = this.now();
      this.places = null;
      this.options.logger?.error(`search index for ${serviceDate} failed: ${describe(error)}`);
    }
  }
}
