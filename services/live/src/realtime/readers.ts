import type { DB } from "@gerlines/db";
import { addDays, localDate } from "@gerlines/schema/service-day";
import { type Kysely, sql } from "kysely";
import { timed } from "../metrics.ts";
import type { RebuildNotice, RebuildNotices } from "./notices.ts";
import { BackgroundReloads, type ReloadTarget } from "./reloads.ts";
import type { ForecastRow, SeenRow } from "./store.ts";

/** One step of realtime for the engine's store. */
export interface RealtimeChunk {
  readonly rows: readonly ForecastRow[];
  /** When sources reported instances, whether or not their predictions changed (F-02). */
  readonly seen?: readonly SeenRow[];
  /**
   * The rows are what `sourceId` (every source when null) now holds for `instanceIds` after a
   * rebuild: they replace what the store held, rows the rebuild deleted included.
   */
  readonly reload?: { readonly sourceId: string | null; readonly instanceIds: readonly string[] };
}

/** A source of realtime up to an instant: the history of a replay, or the live cursor. */
export interface RealtimeReader {
  /**
   * What became known after the previous call and no later than `now` (Unix seconds), in order,
   * as bounded chunks: the caller applies each chunk before the next is read, so a long catch-up
   * (startup, restart) never holds all its rows at once.
   */
  read(now: number): AsyncIterable<RealtimeChunk>;
}

/** The longest span of observations (s) one History query reads. */
export const HISTORY_WINDOW_S = 900;
/** Instance ids per sighting or reload query. */
const ID_BATCH = 2_000;
/** Rows the FollowReader gathers before it hands a chunk over. */
const FOLLOW_CHUNK_ROWS = 20_000;
/**
 * Payloads one read loads at most: each costs one query (p50 89 ms), so after a processor
 * outage the backlog is caught up over many ticks (about 2 min for 6 h) instead of one tick of minutes.
 */
export const FOLLOW_MAX_PAYLOADS = 20;
/** How often (s) the FollowReader refreshes sightings of every instance it delivered. */
export const SEEN_REFRESH_S = 60;
/** A service day is observed from two days before to four days after it (WP-2.3b swap window). */
const OBSERVED_BEFORE_DAY_S = 2 * 86_400;
const OBSERVED_AFTER_DAY_S = 4 * 86_400;
/** Instances of service days older than this many days before `now` are forgotten by readers. */
const KNOWN_DAYS = 2;

interface Row {
  trip_instance_id: string;
  service_date: string;
  stop_index: number;
  source_id: string;
  observed: number;
  arrival: number | null;
  departure: number | null;
  arrival_delay_s: number | null;
  departure_delay_s: number | null;
  cancelled: boolean;
  explicit: boolean;
  stop_place_id: string | null;
}

function toForecast(row: Row): ForecastRow {
  return {
    instanceId: row.trip_instance_id,
    serviceDate: row.service_date,
    stopIndex: row.stop_index,
    sourceId: row.source_id,
    observedAt: row.observed,
    predictedArrival: row.arrival === null ? null : Math.round(row.arrival),
    predictedDeparture: row.departure === null ? null : Math.round(row.departure),
    arrivalDelay: row.arrival_delay_s,
    departureDelay: row.departure_delay_s,
    cancelled: row.cancelled,
    explicit: row.explicit,
    stopPlaceId: row.stop_place_id,
  };
}

const COLUMNS = sql`
  f.trip_instance_id::text AS trip_instance_id, f.service_date::text AS service_date, f.stop_index,
  f.source_id, extract(epoch FROM f.observed_at)::float8 AS observed,
  extract(epoch FROM f.predicted_arrival)::float8 AS arrival,
  extract(epoch FROM f.predicted_departure)::float8 AS departure,
  f.arrival_delay_s, f.departure_delay_s, f.cancelled, f.explicit,
  e.stop_place_id::text AS stop_place_id`;

const JOIN_EVENT = sql`
  LEFT JOIN stop_event e
    ON e.service_date = f.service_date AND e.trip_instance_id = f.trip_instance_id
   AND e.stop_index = f.stop_index AND e.source_id = f.source_id`;

const ORDER = sql`ORDER BY f.observed_at, f.source_id, f.trip_instance_id, f.stop_index`;

const isoDate = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);

function* batches<T>(items: readonly T[], size = ID_BATCH): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

/**
 * When sources reported these instances (`trip_instance_source`, written by WP-2.3b about once a
 * minute per instance and source).
 */
export async function readSightings(db: Kysely<DB>, ids: readonly string[]): Promise<SeenRow[]> {
  const out: SeenRow[] = [];
  for (const part of batches(ids)) {
    const result = await timed("sightings", () =>
      sql<{ id: string; source_id: string; first: number; last: number }>`
        SELECT trip_instance_id::text AS id, source_id,
               extract(epoch FROM first_observed_at)::float8 AS first,
               extract(epoch FROM last_observed_at)::float8 AS last
          FROM trip_instance_source
         WHERE trip_instance_id = ANY(${part}::uuid[])
         ORDER BY trip_instance_id, source_id`.execute(db),
    );
    for (const row of result.rows) {
      out.push({
        instanceId: row.id,
        sourceId: row.source_id,
        firstSeen: row.first,
        lastSeen: row.last,
      });
    }
  }
  return out;
}

interface NewestQuery {
  readonly ids: readonly string[];
  readonly sourceId: string | null;
  readonly days: readonly string[] | null;
  /** Observation window [from, to) in Unix seconds, never after `asOf`. */
  readonly from: number;
  readonly to: number;
  readonly asOf: number;
}

/** The newest row per (instance, stop, source) observed in the window, as of `asOf`. */
async function readNewest(
  db: Kysely<DB>,
  query: NewestQuery,
  metric: string,
): Promise<ForecastRow[]> {
  const result = await timed(metric, () =>
    sql<Row>`
      SELECT DISTINCT ON (f.trip_instance_id, f.stop_index, f.source_id) ${COLUMNS}
        FROM stop_event_forecast f ${JOIN_EVENT}
       WHERE f.trip_instance_id = ANY(${query.ids}::uuid[])
         AND f.observed_at >= to_timestamp(${query.from}) AND f.observed_at < to_timestamp(${query.to})
         AND f.observed_at <= to_timestamp(${query.asOf})
         ${query.sourceId === null ? sql`` : sql`AND f.source_id = ${query.sourceId}`}
         ${query.days === null ? sql`` : sql`AND f.service_date = ANY(${query.days}::date[])`}
       ORDER BY f.trip_instance_id, f.stop_index, f.source_id, f.observed_at DESC`.execute(db),
  );
  return result.rows.map(toForecast);
}

/**
 * Startup state: the newest row per (instance, stop, source) as of `asOf` for the service
 * days around it (yesterday, today, tomorrow), observed from two days before the first of them.
 * Rows are written only on change, so a cancellation or an unchanged delay set long before the
 * start would be missing from a read of the last hours.
 */
export async function* readSnapshot(db: Kysely<DB>, asOf: number): AsyncIterable<RealtimeChunk> {
  const today = localDate(asOf * 1000);
  const days = [addDays(today, -1), today, addDays(today, 1)];
  const instances = await timed("snapshot_ids", () =>
    sql<{ id: string }>`
      SELECT trip_instance_id::text AS id FROM trip_instance
       WHERE service_date = ANY(${days}::date[]) ORDER BY 1`.execute(db),
  );
  const from = Date.parse(`${days[0]}T00:00:00Z`) / 1000 - OBSERVED_BEFORE_DAY_S;
  for (const ids of batches(instances.rows.map((row) => row.id))) {
    const rows = await readNewest(
      db,
      { ids, sourceId: null, days, from, to: asOf + 1, asOf },
      "snapshot",
    );
    if (rows.length === 0) continue;
    const seen = await readSightings(db, [...new Set(rows.map((row) => row.instanceId))]);
    yield seen.length > 0 ? { rows, seen } : { rows };
  }
}

/** Instance ids a reader delivered rows for, by service day, forgotten some days later. */
class KnownInstances {
  private readonly days = new Map<string, Set<string>>();

  /** Adds ids and returns those not known before. */
  add(rows: readonly ForecastRow[]): string[] {
    const fresh: string[] = [];
    for (const row of rows) {
      let day = this.days.get(row.serviceDate);
      if (!day) {
        day = new Set();
        this.days.set(row.serviceDate, day);
      }
      if (day.has(row.instanceId)) continue;
      day.add(row.instanceId);
      fresh.push(row.instanceId);
    }
    return fresh;
  }

  forgetBefore(now: number): void {
    const oldest = isoDate(now - KNOWN_DAYS * 86_400);
    for (const day of [...this.days.keys()]) if (day < oldest) this.days.delete(day);
  }

  /** Ids of the given service days (every day when null), sorted. */
  ids(days: ReadonlySet<string> | null = null): string[] {
    const out: string[] = [];
    for (const [day, ids] of this.days) if (days === null || days.has(day)) out.push(...ids);
    return out.sort();
  }
}

/**
 * State as of T from `stop_event_forecast` (rows with `observed_at ≤ T`), read ahead by
 * `prefetchSeconds` and in windows of at most HISTORY_WINDOW_S while catching up. For renders of
 * replayed days and later for playback (WP-7.6). Sightings come once per instance as they stand at
 * the end (the store counts them only up to the instant it evaluates).
 */
export class HistoryReader implements RealtimeReader {
  private readonly db: Kysely<DB>;
  private readonly prefetchSeconds: number;
  private cursor: number;
  private fetchedTo: number;
  private buffer: ForecastRow[] = [];
  private position = 0;
  private readonly known = new KnownInstances();

  constructor(db: Kysely<DB>, from: number, prefetchSeconds = 60) {
    this.db = db;
    this.cursor = from;
    this.fetchedTo = from;
    this.prefetchSeconds = prefetchSeconds;
  }

  async *read(now: number): AsyncIterable<RealtimeChunk> {
    if (this.cursor >= now) return;
    this.cursor = now;
    this.known.forgetBefore(now);
    for (;;) {
      const out = this.take(now);
      if (out.length > 0) {
        const fresh = this.known.add(out);
        const seen = fresh.length > 0 ? await readSightings(this.db, fresh) : [];
        yield seen.length > 0 ? { rows: out, seen } : { rows: out };
      }
      if (this.position < this.buffer.length || this.fetchedTo >= now) return;
      await this.fetch(
        Math.max(
          this.fetchedTo + this.prefetchSeconds,
          Math.min(now, this.fetchedTo + HISTORY_WINDOW_S),
        ),
      );
    }
  }

  /** Buffered rows observed no later than `now`. */
  private take(now: number): ForecastRow[] {
    const out: ForecastRow[] = [];
    while (this.position < this.buffer.length) {
      const row = this.buffer[this.position] as ForecastRow;
      if (row.observedAt > now) break;
      out.push(row);
      this.position++;
    }
    return out;
  }

  private async fetch(to: number): Promise<void> {
    const from = this.fetchedTo;
    const result = await timed("forecast_window", () =>
      sql<Row>`
        SELECT ${COLUMNS}
          FROM stop_event_forecast f ${JOIN_EVENT}
         WHERE f.observed_at > to_timestamp(${from}) AND f.observed_at <= to_timestamp(${to})
         ${ORDER}`.execute(this.db),
    );
    this.buffer = [...this.buffer.slice(this.position), ...result.rows.map(toForecast)];
    this.position = 0;
    this.fetchedTo = to;
  }
}

interface PayloadRow {
  raw_object_id: string;
  fold_source_id: string;
  observed_at: string;
  processed: number;
}

export interface FollowOptions {
  /** Overlap (s) of each cursor read with the previous one; lines seen are skipped by id. */
  readonly marginSeconds?: number;
  /** Rebuild notices (`realtime_rebuild`); without them a rebuild's moved rows are not reloaded. */
  readonly notices?: RebuildNotices;
  /** Payloads per read (default FOLLOW_MAX_PAYLOADS). */
  readonly maxPayloads?: number;
  /** Told the backlog (at most once a minute) and each failed rebuild reload. */
  readonly log?: (fields: Record<string, unknown>) => void;
}

/**
 * The live cursor (design note §1, F-03). Each call:
 * 1. takes the rebuild notices received so far;
 * 2. reads `rt_payload` lines processed since the cursor minus a margin, skips lines already seen,
 *    and loads each new payload's forecast rows: its logical source (`fold_source_id`) and its
 *    `raw_object_id`, between its observation and its processing (WP-2.3b stamps rows with the fold
 *    instant, later than the observation when a held fallback is folded after a newer primary). WP-2.3b has one writer, so `processed_at` order is commit order, and a
 *    late payload's line carries its swap's start: the cursor only moves forward;
 * 3. hands over the sightings of instances it delivers for the first time;
 * 4. reloads, for each notice, the instances it delivered on the rebuilt days from the rows the
 *    source holds now (a rebuild deletes and moves rows that no payload line names), off the tick:
 *    the call that takes a notice starts the reload, and each call hands over the batches that are
 *    done, with the rows followed since on top (`BackgroundReloads`);
 * 5. every SEEN_REFRESH_S refreshes the sightings of all instances it delivered, unfiltered by
 *    observation time: a sighting can commit minutes after its observation (recorder lag, a held
 *    fallback, a catch-up), and the lookup is by primary key anyway.
 */
export class FollowReader implements RealtimeReader {
  private readonly db: Kysely<DB>;
  private readonly marginSeconds: number;
  private readonly notices: RebuildNotices | null;
  private cursor: number;
  private readonly seen = new Map<string, number>();
  private readonly known = new KnownInstances();
  private seenRefreshedAt: number | null = null;
  private readonly maxPayloads: number;
  private readonly log: ((fields: Record<string, unknown>) => void) | null;
  private backlogLoggedAt = Number.NEGATIVE_INFINITY;
  private readonly reloads: BackgroundReloads;

  constructor(db: Kysely<DB>, from: number, options: FollowOptions = {}) {
    this.db = db;
    this.cursor = from;
    this.marginSeconds = options.marginSeconds ?? 10;
    this.notices = options.notices ?? null;
    this.maxPayloads = Math.max(1, options.maxPayloads ?? FOLLOW_MAX_PAYLOADS);
    this.log = options.log ?? null;
    this.reloads = new BackgroundReloads(
      (target, ids, asOf) => this.loadReload(target, ids, asOf),
      options.log ? { log: options.log } : {},
    );
  }

  /** Instances a reader before this one delivered (the startup History read). */
  adopt(rows: readonly ForecastRow[]): void {
    this.known.add(rows);
  }

  get position(): number {
    return this.cursor;
  }

  get reloadStats() {
    return this.reloads.stats;
  }

  /** Resolves when no reload is loading; its batches come with the next `read`. */
  async reloadsIdle(): Promise<void> {
    await this.reloads.idle();
  }

  async *read(now: number): AsyncIterable<RealtimeChunk> {
    const notices = this.notices?.drain() ?? [];
    this.known.forgetBefore(now);
    for (const target of mergeNotices(notices))
      this.reloads.start(target, this.known.ids(target.serviceDates), now);
    yield* this.follow();
    yield* this.reloads.take();
    if (this.seenRefreshedAt === null || now - this.seenRefreshedAt >= SEEN_REFRESH_S) {
      this.seenRefreshedAt = now;
      const seen = await readSightings(this.db, this.known.ids());
      if (seen.length > 0) yield { rows: [], seen };
    }
  }

  private async *follow(): AsyncIterable<RealtimeChunk> {
    const since = this.cursor - this.marginSeconds;
    const payloads = await timed("payload_cursor", () =>
      sql<PayloadRow>`
        SELECT raw_object_id::text AS raw_object_id, fold_source_id,
               observed_at::text AS observed_at,
               extract(epoch FROM processed_at)::float8 AS processed
          FROM rt_payload
         WHERE processed_at >= to_timestamp(${since}) AND error IS NULL
         ORDER BY processed_at, raw_object_id`.execute(this.db),
    );
    let rows: ForecastRow[] = [];
    const fresh = payloads.rows.filter((payload) => !this.seen.has(payload.raw_object_id));
    const taken = fresh.slice(0, this.maxPayloads);
    const left = fresh.length - taken.length;
    const reached = left > 0 ? taken.slice(-1) : payloads.rows;
    for (const payload of reached) this.cursor = Math.max(this.cursor, payload.processed);
    if (left > 0) this.noteBacklog(left);
    for (const payload of taken) {
      this.seen.set(payload.raw_object_id, payload.processed);
      const result = await timed("payload_rows", () =>
        sql<Row>`
          SELECT ${COLUMNS}
            FROM stop_event_forecast f ${JOIN_EVENT}
           WHERE f.source_id = ${payload.fold_source_id}
             AND f.raw_object_id = ${payload.raw_object_id}::uuid
             AND f.observed_at >= ${payload.observed_at}::timestamptz
             AND f.observed_at <= to_timestamp(${payload.processed})
           ${ORDER}`.execute(this.db),
      );
      for (const row of result.rows) rows.push(toForecast(row));
      if (rows.length >= FOLLOW_CHUNK_ROWS) {
        yield await this.withSightings(rows);
        rows = [];
      }
    }
    for (const [id, processed] of this.seen) {
      if (processed < this.cursor - 10 * this.marginSeconds) this.seen.delete(id);
    }
    if (rows.length > 0) yield await this.withSightings(rows);
  }

  private noteBacklog(left: number): void {
    const at = Date.now() / 1000;
    if (!this.log || at - this.backlogLoggedAt < 60) return;
    this.backlogLoggedAt = at;
    this.log({ msg: "follow backlog", payloadsLeft: left, perRead: this.maxPayloads });
  }

  private async withSightings(rows: ForecastRow[]): Promise<RealtimeChunk> {
    this.reloads.note(rows);
    const fresh = this.known.add(rows);
    const seen = fresh.length > 0 ? await readSightings(this.db, fresh) : [];
    return seen.length > 0 ? { rows, seen } : { rows };
  }

  private async *loadReload(
    target: ReloadTarget,
    ids: readonly string[],
    asOf: number,
  ): AsyncIterable<RealtimeChunk> {
    const days = target.serviceDates ? [...target.serviceDates].sort() : null;
    const from = days
      ? Date.parse(`${days[0]}T00:00:00Z`) / 1000 - OBSERVED_BEFORE_DAY_S
      : asOf - (KNOWN_DAYS + 1) * 86_400 - OBSERVED_BEFORE_DAY_S;
    const to = days
      ? Date.parse(`${days[days.length - 1]}T00:00:00Z`) / 1000 + OBSERVED_AFTER_DAY_S
      : asOf + 1;
    for (const part of batches(ids)) {
      const rows = await readNewest(
        this.db,
        { ids: part, sourceId: target.sourceId, days, from, to, asOf },
        "rebuild_reload",
      );
      const seen = await readSightings(this.db, part);
      yield {
        rows,
        ...(seen.length > 0 ? { seen } : {}),
        reload: { sourceId: target.sourceId, instanceIds: part },
      };
    }
  }
}

/** One reload per source with the union of its days; a notice for everything replaces them all. */
export function mergeNotices(notices: readonly RebuildNotice[]): ReloadTarget[] {
  if (notices.length === 0) return [];
  if (notices.some((n) => n.foldSourceId === null || n.serviceDates === null)) {
    return [{ sourceId: null, serviceDates: null }];
  }
  const bySource = new Map<string, Set<string>>();
  for (const notice of notices) {
    const days = bySource.get(notice.foldSourceId as string) ?? new Set<string>();
    for (const day of notice.serviceDates ?? []) days.add(day);
    bySource.set(notice.foldSourceId as string, days);
  }
  return [...bySource.keys()]
    .sort()
    .map((sourceId) => ({ sourceId, serviceDates: bySource.get(sourceId) as Set<string> }));
}

/**
 * Realtime at startup: the newest prediction per stop and source for the service days around the
 * first tick (`readSnapshot`), then `next`, created for that instant (the `rt_payload` cursor
 * for `live run`, the History reader for renders). The FollowReader takes over the instances the
 * snapshot delivered, for their sightings and rebuild reloads.
 */
export class SnapshotThen implements RealtimeReader {
  private readonly db: Kysely<DB>;
  private readonly makeNext: (asOf: number) => RealtimeReader;
  private next: RealtimeReader | null = null;

  constructor(db: Kysely<DB>, makeNext: (asOf: number) => RealtimeReader) {
    this.db = db;
    this.makeNext = makeNext;
  }

  async *read(now: number): AsyncIterable<RealtimeChunk> {
    if (this.next) {
      yield* this.next.read(now);
      return;
    }
    const next = this.makeNext(now);
    for await (const chunk of readSnapshot(this.db, now)) {
      if (next instanceof FollowReader) next.adopt(chunk.rows);
      yield chunk;
    }
    this.next = next;
  }
}

/** A render's reader: the snapshot at its first tick, then History from that instant. */
export function snapshotThenHistory(db: Kysely<DB>): RealtimeReader {
  return new SnapshotThen(db, (asOf) => new HistoryReader(db, asOf));
}
