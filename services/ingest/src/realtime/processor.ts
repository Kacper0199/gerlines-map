import { createHash, randomUUID } from "node:crypto";
import type { DB } from "@gerlines/db";
import type { AdapterResult, AlertObservation, TripObservation } from "@gerlines/schema";
import { addDays, localDate } from "@gerlines/schema/service-day";
import type { Kysely } from "kysely";
import type { Clock } from "../clock.ts";
import { errorMessage } from "../log.ts";
import type { FetchRecord } from "../storage/sidecar.ts";
import { adaptGtfsRt, foldSourceOf, profileFor, type SourceProfile } from "./adapters.ts";
import { refusal } from "./check.ts";
import { addedRun, type FoldSnapshot, type RunRef, SourceFold } from "./fold.ts";
import {
  adaptIris,
  IRIS_SOURCE,
  IrisChanges,
  type IrisChangeTrip,
  IrisPlans,
  type IrisPlanTrip,
  irisRecording,
  irisTripStartDate,
} from "./iris.ts";
import type { MatchedTrip, Matcher, UnmatchedTrip } from "./matcher.ts";
import type { StoredPayload } from "./payload-stream.ts";
import { emptyBatch, type RowBatch, type StopEventRow } from "./rows.ts";
import type { Timetable, TripRun } from "./timetable.ts";
import {
  clearStaging,
  inTransaction,
  type PayloadLogRow,
  type StagedLog,
  StagingLostError,
  type SwapCounts,
  stageBatch,
  startStaging,
  swapStaged,
  writeBatch,
} from "./writer.ts";

const HOUR_MS = 3_600_000;

/** A fallback feed's payload waits this long, so the primary's copy of the same snapshot wins. */
export const FALLBACK_HOLD_MS = 60_000;
/**
 * A DB Timetables answer waits this long before it is folded: the 110 recorded IRIS ids fold under
 * one source, and an answer the follower reads after a later one of another station would otherwise
 * be late and fold its service days again.
 */
export const IRIS_HOLD_MS = 30_000;
/** A held fallback payload goes on at once when the primary has delivered nothing for this long. */
export const PRIMARY_SILENT_MS = 5 * 60_000;
/** Payloads are kept this long for rebuilds of the service days they touch. */
export const DEFAULT_HORIZON_MS = 48 * HOUR_MS;

/** Alert sources whose trip selectors use the ids of another (trip update) source. */
const ALERT_TRIP_SOURCE: Record<string, string> = { "delfi-gtfs-sa": "delfi-gtfs-rt" };

/** Unmatched reasons counted in the payload's counts only, without a backlog row per trip. */
const COUNT_ONLY_REASONS: ReadonlySet<string> = new Set(["no_static_for_source"]);

export interface SourceCoverage {
  readonly payloads: number;
  readonly failedPayloads: number;
  readonly matched: Map<string, string>;
  readonly matchedByMethod: Map<string, Set<string>>;
  readonly unmatched: Map<string, string>;
  readonly outOfScope: Map<string, string>;
  readonly rebuilds: number;
  /** Payloads not folded because another feed of the source already sent that snapshot or a newer one. */
  readonly skipped: number;
  /** Service days a late payload touched that were already pruned, so not folded again. */
  readonly daysTooOld: number;
  /** Stop times earlier than the timetable by more than half an hour, read as no data. */
  readonly implausibleDelays: number;
  /** Predicted times moved forward so the run never goes backwards. */
  readonly reordered: number;
  /** Payloads per static feed version they name (`none` when they name none). */
  readonly feedVersions: Map<string, number>;
}

/** Where one payload's rows go. */
export interface RowWriter {
  /** One payload's rows; with a log line when the payload is processed for the first time. */
  write(batch: RowBatch, log: PayloadLogRow | null): Promise<void>;
}

/** Where a staged rebuild's rows wait until they are swapped in. */
export interface RebuildTarget {
  /** One refolded payload's rows: the day-bound ones staged, the order-free ones written in place. */
  stage(batch: RowBatch): Promise<void>;
  /** Puts the staged rows in place of the ones they replace, with the log lines, in one commit. */
  swap(logs: readonly StagedLog[]): Promise<SwapCounts>;
}

/** Where the processor's rows go: the database, or a test's memory. */
export interface RowSink extends RowWriter {
  /**
   * Starts a staged rebuild of a source's rows of `days` that rows observed from `cut` on may have
   * changed; any earlier staging is dropped.
   */
  rebuild(source: string, days: readonly string[], cut: number): Promise<RebuildTarget>;
  /** Runs `work` so that every write it makes commits together, when the sink can. */
  atomically?(work: (sink: RowSink) => Promise<void>): Promise<void>;
}

export function databaseSink(db: Kysely<DB>): RowSink {
  return {
    write: (batch, log) => writeBatch(db, batch, log),
    rebuild: async (source, days, cut) => {
      const token = randomUUID();
      await startStaging(db, token);
      return {
        stage: (batch) => stageBatch(db, batch, cut),
        swap: async (logs) => {
          const counts = await swapStaged(db, token, source, days, cut, logs);
          await clearStaging(db).catch(() => undefined);
          return counts;
        },
      };
    },
    atomically: (work) => inTransaction(db, (trx) => work(databaseSink(trx))),
  };
}

/** The final stop rows of a rebuild are staged in parts of this many, so they are never all in memory. */
const FINAL_ROWS_PER_STAGE = 5_000;

/** Writes nothing: a rebuild's payloads before its cut, whose rows are already in place. */
const DISCARD: RowWriter = { write: async () => {} };

/** What a staged rebuild did, for the live run's log. */
export interface RebuildReport {
  readonly source: string;
  readonly days: readonly string[];
  readonly latePayloads: number;
  readonly refoldedPayloads: number;
  readonly stagedRows: number;
  readonly cut: string | null;
  readonly wallMs: number;
  readonly swapMs: number;
  /** Null when the staged rows were lost (another writer, a database restart): the rebuild starts again. */
  readonly counts: SwapCounts | null;
}

/** How much of the rebuild work a `flush` may do before it returns. */
export interface FlushOptions {
  /** Hand on every held fallback payload (the end of a run). */
  readonly releaseAll?: boolean;
  /** Wall time the rebuild work may take in this call; unbounded when absent. */
  readonly budgetMs?: number;
  /** Payloads a rebuild may fold again in this call (tests); unbounded when absent. */
  readonly budgetPayloads?: number;
}

export interface ProcessorOptions {
  readonly sink?: RowSink;
  /** Also count coverage apart for payloads observed before and after this instant (epoch ms). */
  readonly splitAt?: number;
  /** Keep per-trip coverage maps for a report (replays); a live run keeps counts only. */
  readonly coverage?: boolean;
  /** Recorded sources of this run: a fallback feed is held only when its primary is one of them. */
  readonly sources?: readonly string[];
  /** How long processed payloads stay known for rebuilds (epoch ms span). */
  readonly horizonMs?: number;
  /** The clock of `processed_at` when the processing clock reads the recordings' time. */
  readonly wallClock?: Clock;
  /** How long a DB Timetables answer waits before it is folded (epoch ms span). */
  readonly irisHoldMs?: number;
}

const ERROR_TEXT_LIMIT = 500;
/** `trip_instance_source.last_observed_at` is written again only after this much payload time. */
export const SOURCE_SEEN_STEP_MS = 60_000;

const errorText = (prefix: string, error: unknown): string =>
  `${prefix}: ${errorMessage(error).replaceAll("\u0000", "")}`.slice(0, ERROR_TEXT_LIMIT);

export type PayloadReloader = (records: readonly FetchRecord[]) => AsyncIterable<StoredPayload>;

interface SeenRange {
  first: number;
  lastHour: number;
  readonly day: string;
}

interface DayRange {
  first: number;
  last: number;
}

interface UnloadedNames {
  readonly days: Set<string>;
  from: number;
}

/** A processed payload as the order of its logical source sees it. */
interface Entry {
  readonly record: FetchRecord;
  readonly id: string;
  /** Its place in the order: the observed instant, plus the hold of a fallback feed. */
  readonly at: number;
  /** 0 for a primary feed or a single feed, 1 for a fallback feed. */
  readonly rank: number;
  readonly key: string;
  readonly observedAt: number;
  /** The feed header's timestamp, for sources with several feeds; null otherwise. */
  readonly header: number | null;
  /** The instant it was folded at (never before the payload folded before it). */
  foldAt: number | null;
}

function compareEntries(a: Entry, b: Entry): number {
  return a.at - b.at || a.rank - b.rank || a.key.localeCompare(b.key);
}

/** State of one logical source: its fold, its payloads in order, and what is waiting. */
interface LogicalSource {
  readonly name: string;
  fold: SourceFold;
  /** Every payload processed within the horizon, in order. */
  entries: Entry[];
  cursor: Entry | null;
  /** The newest header among folded payloads up to the cursor. */
  newestHeader: number | null;
  /** The fold instant of the last folded payload up to the cursor. */
  lastFoldAt: number;
  /** The same two values over the payloads that left `entries` beyond the horizon. */
  pruned: { newestHeader: number | null; lastFoldAt: number };
  readonly dayRanges: Map<string, DayRange>;
  readonly held: { item: StoredPayload; entry: Entry }[];
  readonly late: Entry[];
  readonly pendingDays: Set<string>;
  /** The earliest payload a pending rebuild must start from, beside the days' own first payloads. */
  pendingFrom: number;
  lastPrimaryAt: number | null;
}

type MutableCoverage = SourceCoverage & {
  payloads: number;
  failedPayloads: number;
  rebuilds: number;
  skipped: number;
  daysTooOld: number;
  implausibleDelays: number;
  reordered: number;
};

function mutableCoverage(): MutableCoverage {
  return {
    payloads: 0,
    failedPayloads: 0,
    matched: new Map(),
    matchedByMethod: new Map(),
    unmatched: new Map(),
    outOfScope: new Map(),
    rebuilds: 0,
    skipped: 0,
    daysTooOld: 0,
    implausibleDelays: 0,
    reordered: 0,
    feedVersions: new Map(),
  };
}

/**
 * A rebuild of some service days of one source, run in slices beside the live tail: it reads its
 * late payloads for the days they touch, folds the window again into a new fold (staging the rows
 * from its cut on), follows what the tail adds until it has caught up, then swaps its rows in.
 */
interface RebuildJob {
  readonly state: LogicalSource;
  readonly late: readonly Entry[];
  readonly lateIds: ReadonlySet<string>;
  readonly from: number;
  readonly started: number;
  readonly days: Set<string>;
  phase: "days" | "refold";
  /** Reads the late payloads back, for the days their trips match. */
  dayReader: AsyncIterator<StoredPayload> | null;
  /** Reads the payloads of the current round of the refold. */
  reader: AsyncIterator<{ item: StoredPayload; entry: Entry }> | null;
  readonly observed: ReadonlyMap<string, number>;
  fold: SourceFold | null;
  readonly ranges: Map<string, DayRange>;
  /** Fold instants in the new order, put on the entries when the rebuild is swapped in. */
  readonly foldAt: Map<string, number | null>;
  /** Every payload a round has taken, so each is folded once. */
  readonly entries: Map<string, Entry>;
  start: number;
  newestHeader: number | null;
  lastFoldAt: number;
  /** Payloads folded before this instant write the same rows in both orders, so they write none. */
  cut: number;
  target: RebuildTarget | null;
  readonly logs: StagedLog[];
  refolded: number;
  staged: number;
}

/** How one payload is processed: first time, folded again in a rebuild, or a late one in a rebuild. */
interface PassContext {
  readonly fold: SourceFold;
  /** Where its rows go (the processor's sink when absent). */
  readonly sink?: RowWriter;
  /** The instant it is folded at in this pass (its entry's when absent). */
  readonly foldAt?: number;
  /** Only runs of these service days are folded (a rebuild); all when absent. */
  readonly days?: ReadonlySet<string>;
  /** Write the processing log line and the rows that do not depend on order (instances, alerts). */
  readonly full: boolean;
}

/** One payload being processed: where its rows and counts go. */
interface Pass {
  readonly name: string;
  readonly context: PassContext;
  readonly rawObjectId: string;
  readonly coverages: readonly MutableCoverage[];
  readonly counts: Record<string, number>;
  batch: RowBatch;
  feedVersion: string | null;
  /** Its ids are DELFI's, so the feed version it names is a DELFI timetable version. */
  delfi: boolean;
  readonly applied: Set<string>;
}

function bump(pass: Pass, key: string, by = 1): void {
  if (by !== 0) pass.counts[key] = (pass.counts[key] ?? 0) + by;
}

const hourOf = (epochMs: number): number => Math.floor(epochMs / HOUR_MS) * HOUR_MS;

/** Header timestamp of a recorded payload from its sidecar summary (epoch ms), if it has one. */
function headerOf(record: FetchRecord): number | null {
  const summary = record.feed;
  return summary?.ok && summary.headerTimestamp !== null ? summary.headerTimestamp * 1000 : null;
}

/** Version bookkeeping a restart needs: when each version was last named, and what named a missing one. */
export interface VersionBook {
  readonly lastNamed: readonly (readonly [string, number])[];
  readonly unloaded: readonly (readonly [
    string,
    readonly (readonly [string, { readonly days: readonly string[]; readonly from: number }])[],
  ])[];
}

export interface ProcessorSnapshot {
  readonly version: 1;
  /** Feed versions loaded when it was taken; a restore needs the same ones. */
  readonly feedVersions: readonly string[];
  /** The database it was written against; a restore against another one is refused. */
  readonly database?: string;
  readonly versions?: VersionBook;
  readonly sources: readonly {
    readonly name: string;
    readonly cursor: string | null;
    readonly lastPrimaryAt: number | null;
    readonly dayRanges: readonly (readonly [string, DayRange])[];
    /** Every payload in the order (folded or skipped), oldest first. */
    readonly entries: readonly string[];
    readonly foldAt: readonly (readonly [string, number])[];
    readonly pruned: { readonly newestHeader: number | null; readonly lastFoldAt: number | null };
    /** Payloads in the order that a rebuild has not folded yet (a running one starts again). */
    readonly late?: readonly string[];
    readonly pendingDays?: readonly string[];
    readonly pendingFrom?: number | null;
    readonly fold: FoldSnapshot;
  }[];
  /** The IRIS books: the shared planned one and the changes of each source's fold. */
  readonly iris?: IrisSnapshot;
}

export interface IrisSnapshot {
  readonly plans: readonly IrisPlanTrip[];
  readonly changes: readonly {
    readonly source: string;
    readonly trips: readonly IrisChangeTrip[];
  }[];
}

export type CheckpointLine =
  | {
      readonly kind: "head";
      readonly version: 1;
      readonly feedVersions: readonly string[];
      readonly database?: string;
      readonly versions?: VersionBook;
    }
  | ({ readonly kind: "source" } & Omit<ProcessorSnapshot["sources"][number], "fold"> & {
        readonly fold: Omit<FoldSnapshot, "instances">;
      })
  | {
      readonly kind: "instance";
      readonly source: string;
      readonly value: FoldSnapshot["instances"][number];
    }
  | { readonly kind: "iris-plan"; readonly value: IrisPlanTrip }
  | { readonly kind: "iris-change"; readonly source: string; readonly value: IrisChangeTrip };

/** Puts a snapshot together again from its checkpoint lines. */
export function snapshotFromLines(lines: Iterable<CheckpointLine>): ProcessorSnapshot | undefined {
  let head: Extract<CheckpointLine, { kind: "head" }> | undefined;
  const sources: ProcessorSnapshot["sources"][number][] = [];
  const instances = new Map<string, FoldSnapshot["instances"][number][]>();
  const plans: IrisPlanTrip[] = [];
  const changes = new Map<string, IrisChangeTrip[]>();
  for (const line of lines) {
    if (line.kind === "head") head = line;
    else if (line.kind === "source") {
      const { kind: _kind, fold, ...rest } = line;
      const list: FoldSnapshot["instances"][number][] = [];
      instances.set(rest.name, list);
      sources.push({ ...rest, fold: { ...fold, instances: list } });
    } else if (line.kind === "iris-plan") plans.push(line.value);
    else if (line.kind === "iris-change") {
      const list = changes.get(line.source) ?? [];
      list.push(line.value);
      changes.set(line.source, list);
    } else instances.get(line.source)?.push(line.value);
  }
  if (!head) return undefined;
  const { kind: _kind, ...rest } = head;
  const iris: IrisSnapshot = {
    plans,
    changes: [...changes].map(([source, trips]) => ({ source, trips })),
  };
  return { ...rest, sources, iris };
}

/**
 * Turns recorded payloads into trip instances, stop events, forecasts, segments, alerts, outbox events
 * and backlog rows. Payloads are folded per logical source in order; a source with several recorded
 * feeds (DELFI from Mobilithek and from the traines mirror) folds each snapshot once, by the feed
 * header's time. A payload older than the newest one already folded (a backfilled minute) marks the
 * service days it touches, and `flush` folds just those days again from their first payload in a
 * rebuild that runs in slices beside the live tail and swaps its rows in at the end, keeping the
 * outbox, so late payloads and duplicates converge to the rows an in-order run writes.
 */
export class Processor {
  readonly matcher: Matcher;
  readonly clock: Clock;
  private readonly wall: Clock;
  readonly reload: PayloadReloader;
  readonly coverage = new Map<string, MutableCoverage>();
  private sink: RowSink;
  private readonly splitAt: number | undefined;
  private readonly keepCoverage: boolean;
  private readonly runSources: ReadonlySet<string> | null;
  private readonly horizonMs: number;
  private readonly irisHoldMs: number;
  /** The first service day still rebuilt; set by `dropBefore`. */
  private keptFrom: string | null = null;
  private readonly logical = new Map<string, LogicalSource>();
  private readonly processedIds = new Map<string, number>();
  /** Per unloaded feed version and logical source: the service days its payloads named, and since when. */
  private readonly unloadedVersions = new Map<string, Map<string, UnloadedNames>>();
  /** When each feed version string was last named by a payload (epoch ms). */
  readonly versionLastNamed = new Map<string, number>();
  private readonly instanceSeen = new Map<string, { at: number; source: string; day: string }>();
  private readonly instanceSourceSeen = new Map<
    string,
    { first: number; last: number; day: string; written: number }
  >();
  private readonly backlogSeen = new Map<string, SeenRange>();
  private readonly alertSeen = new Map<string, SeenRange>();
  /** Planned side of every IRIS stop seen: order-free, so one book serves every fold and rebuild. */
  private readonly irisPlans = new IrisPlans();
  /** Changed side of IRIS stops per fold: a rebuild's new fold starts its own from the payloads it folds. */
  private readonly irisChanges = new WeakMap<SourceFold, IrisChanges>();
  /** The service day each IRIS trip was matched on, for the days a late answer touches. */
  private readonly irisTripDays = new Map<string, string>();
  /** The rebuild running in slices between live steps, if any. */
  private job: RebuildJob | null = null;
  private readonly reports: RebuildReport[] = [];

  constructor(
    db: Kysely<DB>,
    matcher: Matcher,
    clock: Clock,
    reload: PayloadReloader,
    options: ProcessorOptions = {},
  ) {
    this.matcher = matcher;
    this.clock = clock;
    this.wall = options.wallClock ?? clock;
    this.reload = reload;
    this.sink = options.sink ?? databaseSink(db);
    this.splitAt = options.splitAt;
    this.keepCoverage = options.coverage ?? true;
    this.runSources = options.sources ? new Set(options.sources) : null;
    this.horizonMs = options.horizonMs ?? DEFAULT_HORIZON_MS;
    this.irisHoldMs = options.irisHoldMs ?? IRIS_HOLD_MS;
  }

  coverageOf(source: string): MutableCoverage {
    let coverage = this.coverage.get(source);
    if (!coverage) {
      coverage = mutableCoverage();
      this.coverage.set(source, coverage);
    }
    return coverage;
  }

  /** The coverage a payload counts in: its source's, and its side of `splitAt` when one is set. */
  private coveragesAt(source: string, observedAt: number): MutableCoverage[] {
    if (this.splitAt === undefined) return [this.coverageOf(source)];
    const side = observedAt < this.splitAt ? "before" : "after";
    return [this.coverageOf(source), this.coverageOf(`${source} ${side}`)];
  }

  /** True when no payload waits for a hold, a rebuild or a version. */
  settled(): boolean {
    if (this.job) return false;
    for (const state of this.logical.values()) {
      if (state.held.length > 0 || state.late.length > 0 || state.pendingDays.size > 0)
        return false;
    }
    return true;
  }

  /** The observed instant of the newest payload in order over every source (0 before any). */
  newestObserved(): number {
    let newest = 0;
    for (const state of this.logical.values()) {
      if (state.cursor) newest = Math.max(newest, state.cursor.observedAt);
    }
    return newest;
  }

  /** Sizes of the in-memory state, for the live run's memory log. */
  stats(): Record<string, number> {
    let entries = 0;
    let held = 0;
    let instances = 0;
    let evicted = 0;
    for (const state of this.logical.values()) {
      entries += state.entries.length;
      held += state.held.length;
      instances += state.fold.activeInstances;
      evicted += state.fold.evictedInstances;
    }
    return {
      entries,
      held,
      instances,
      evicted,
      processedIds: this.processedIds.size,
      instanceSeen: this.instanceSeen.size,
      backlogSeen: this.backlogSeen.size,
      alertSeen: this.alertSeen.size,
      matcherDays: this.matcher.cachedDays(),
      matcherOutcomes: this.matcher.cachedOutcomes(),
    };
  }

  private stateOf(name: string): LogicalSource {
    let state = this.logical.get(name);
    if (!state) {
      state = {
        name,
        fold: new SourceFold(name, this.matcher.timetable),
        entries: [],
        cursor: null,
        newestHeader: null,
        lastFoldAt: Number.NEGATIVE_INFINITY,
        pruned: { newestHeader: null, lastFoldAt: Number.NEGATIVE_INFINITY },
        dayRanges: new Map(),
        held: [],
        late: [],
        pendingDays: new Set(),
        pendingFrom: Number.POSITIVE_INFINITY,
        lastPrimaryAt: null,
      };
      this.logical.set(name, state);
    }
    return state;
  }

  private holdOf(profile: SourceProfile | undefined): number {
    if (!profile?.feed || profile.feed.primary) return 0;
    if (!this.runSources) return 0;
    const primaryRecorded = [...this.runSources].some((source) => {
      const other = profileFor(source);
      return other?.source === profile.source && other.feed?.primary === true;
    });
    return primaryRecorded ? FALLBACK_HOLD_MS : 0;
  }

  private entryOf(record: FetchRecord): Entry {
    const profile = profileFor(record.source);
    const observedAt = Date.parse(record.observedAt);
    return {
      record,
      id: record.object?.id ?? "",
      at: observedAt + this.holdOf(profile),
      rank: profile?.feed && !profile.feed.primary ? 1 : 0,
      key: record.object?.key ?? "",
      observedAt,
      header: profile?.feed ? headerOf(record) : null,
      foldAt: null,
    };
  }

  /**
   * A timetable version reached `loaded`: the matcher takes it, and the service days that payloads
   * named while it was missing are folded again (on the next `flush`), now reading its trip ids.
   */
  timetableLoaded(table: Timetable): void {
    this.matcher.addTimetable(table);
    for (const state of this.logical.values()) state.fold.useTimetable(this.matcher.timetable);
    const version = table.data.feedVersion;
    if (version === null) return;
    for (const [source, named] of this.unloadedVersions.get(version) ?? []) {
      const state = this.stateOf(source);
      for (const day of named.days) state.pendingDays.add(day);
      state.pendingFrom = Math.min(state.pendingFrom, named.from);
    }
    this.unloadedVersions.delete(version);
  }

  /**
   * Registers payloads an earlier run processed and folds the service days they touch again, so the
   * fold state is back (a restart without a checkpoint).
   */
  async resume(records: readonly FetchRecord[]): Promise<void> {
    const fresh = records.filter((record) => this.remember(record));
    const bySource = new Map<string, Entry[]>();
    for (const record of fresh) {
      const name = foldSourceOf(record.source);
      const list = bySource.get(name) ?? [];
      list.push(this.entryOf(record));
      bySource.set(name, list);
    }
    for (const [name, entries] of [...bySource].sort(([a], [b]) => a.localeCompare(b))) {
      const state = this.stateOf(name);
      state.entries = [...state.entries, ...entries].sort(compareEntries);
      state.cursor = state.entries[state.entries.length - 1] ?? null;
      await this.refoldAll(state);
    }
  }

  /**
   * Processes a batch of delivered payloads. Duplicates are skipped; a fallback feed's payload and a
   * DB Timetables answer wait for their hold; a payload older than the newest one folded waits for `flush`.
   */
  async processBatch(batch: readonly StoredPayload[]): Promise<void> {
    await this.releaseHeld();
    const now = this.clock.now();
    for (const [name, items] of this.freshBySource(batch)) {
      const state = this.stateOf(name);
      for (const { item, entry } of items) {
        if (entry.rank === 0 && profileFor(item.record.source)?.feed) {
          state.lastPrimaryAt = Math.max(state.lastPrimaryAt ?? 0, entry.observedAt);
        }
        const hold =
          this.irisWaits(entry, now) ||
          (entry.rank === 1 && entry.at > now && !this.primarySilent(state, now));
        if (hold) state.held.push({ item, entry });
        else await this.arrive(state, item, entry);
      }
    }
  }

  /** New payloads of a batch by logical source (sources sorted, payloads in order), each once. */
  private freshBySource(
    batch: readonly StoredPayload[],
  ): [string, { item: StoredPayload; entry: Entry }[]][] {
    const fresh = new Map<string, { item: StoredPayload; entry: Entry }[]>();
    for (const item of batch) {
      if (!this.remember(item.record)) continue;
      const name = foldSourceOf(item.record.source);
      const list = fresh.get(name) ?? [];
      list.push({ item, entry: this.entryOf(item.record) });
      fresh.set(name, list);
    }
    for (const items of fresh.values()) items.sort((a, b) => compareEntries(a.entry, b.entry));
    return [...fresh].sort(([a], [b]) => a.localeCompare(b));
  }

  /** A DB Timetables answer still within its hold at `now`. */
  private irisWaits(entry: Entry, now: number): boolean {
    return irisRecording(entry.record.source) !== null && entry.observedAt + this.irisHoldMs > now;
  }

  private primarySilent(state: LogicalSource, now: number): boolean {
    return state.lastPrimaryAt === null || now - state.lastPrimaryAt > PRIMARY_SILENT_MS;
  }

  /** Hands on held fallback payloads whose hold is over (all of them with `all`). */
  private async releaseHeld(all = false): Promise<void> {
    const now = this.clock.now();
    for (const state of [...this.logical.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      if (state.held.length === 0) continue;
      const silent = this.primarySilent(state, now);
      const ready = state.held.filter(
        ({ entry }) => all || (!this.irisWaits(entry, now) && (silent || entry.at < now)),
      );
      if (ready.length === 0) continue;
      const waiting = state.held.filter((held) => !ready.includes(held));
      state.held.length = 0;
      state.held.push(...waiting);
      ready.sort((a, b) => compareEntries(a.entry, b.entry));
      for (const { item, entry } of ready) await this.arrive(state, item, entry);
    }
  }

  /** Folds a payload that comes after everything folded; a late one waits for `flush`. */
  private async arrive(state: LogicalSource, item: StoredPayload, entry: Entry): Promise<void> {
    if (state.cursor && compareEntries(entry, state.cursor) < 0) {
      insertSorted(state.entries, entry);
      state.late.push(entry);
      return;
    }
    state.entries.push(entry);
    state.cursor = entry;
    if (superseded(entry, state.newestHeader)) {
      await this.skip(item, entry, state.name);
      return;
    }
    entry.foldAt = Math.max(entry.observedAt, state.lastFoldAt);
    state.lastFoldAt = entry.foldAt;
    if (entry.header !== null) state.newestHeader = entry.header;
    const before = state.fold.activeDays();
    await this.processPayload(item, entry, state.name, { fold: state.fold, full: true });
    this.noteDays(state.dayRanges, state.fold, entry.at, before);
  }

  /** Newest header and last fold instant among folded payloads before `entry`. */
  private foldedBefore(
    state: LogicalSource,
    entry: Entry | undefined,
  ): { newestHeader: number | null; lastFoldAt: number } {
    let newestHeader = state.pruned.newestHeader;
    let lastFoldAt = state.pruned.lastFoldAt;
    for (const other of state.entries) {
      if (entry && compareEntries(other, entry) >= 0) break;
      if (other.foldAt === null) continue;
      lastFoldAt = Math.max(lastFoldAt, other.foldAt);
      if (other.header !== null)
        newestHeader = Math.max(newestHeader ?? other.header, other.header);
    }
    return { newestHeader, lastFoldAt };
  }

  /**
   * Widens the range of each service day with instances in memory while a payload was folded: those
   * there before it (`before`, an instance it ended included) and after it.
   */
  private noteDays(
    ranges: Map<string, DayRange>,
    fold: SourceFold,
    at: number,
    before: ReadonlySet<string>,
  ): void {
    for (const day of new Set([...before, ...fold.activeDays()])) {
      const range = ranges.get(day);
      if (!range) ranges.set(day, { first: at, last: at });
      else {
        range.first = Math.min(range.first, at);
        range.last = Math.max(range.last, at);
      }
    }
  }

  /** A payload another feed of the source already covered: logged, not folded. */
  private async skip(
    item: StoredPayload,
    entry: Entry,
    name: string,
    sink: RowWriter = this.sink,
  ): Promise<void> {
    for (const coverage of this.coveragesAt(name, entry.observedAt)) {
      coverage.skipped += 1;
      coverage.payloads += 1;
    }
    await sink.write(emptyBatch(), {
      rawObjectId: entry.id,
      sourceId: item.record.source,
      foldSourceId: name,
      observedAt: entry.observedAt,
      processedAt: this.wall.now(),
      counts: { skipped_snapshot_already_folded: 1 },
      error: null,
    });
  }

  /**
   * Hands on held payloads whose hold is over (all of them with `releaseAll`, at the end of a run)
   * and runs the rebuilds that late payloads and newly loaded versions asked for, one source at a
   * time, within the budget given: a rebuild left unfinished goes on at the next call, while new
   * payloads are folded in between.
   */
  async flush(options: FlushOptions = {}): Promise<void> {
    await this.releaseHeld(options.releaseAll ?? false);
    const deadline =
      options.budgetMs === undefined
        ? Number.POSITIVE_INFINITY
        : this.wall.now() + options.budgetMs;
    const budget = { payloads: options.budgetPayloads ?? Number.POSITIVE_INFINITY };
    const more = () => budget.payloads > 0 && this.wall.now() < deadline;
    while (more()) {
      this.job ??= await this.nextJob();
      if (!this.job) return;
      if (!(await this.advance(this.job, more, budget))) return;
      this.job = null;
    }
  }

  /** True while a rebuild runs or waits to start. */
  rebuilding(): boolean {
    if (this.job) return true;
    for (const state of this.logical.values()) {
      if (state.late.length > 0 || state.pendingDays.size > 0) return true;
    }
    return false;
  }

  /** True while fallback payloads wait for their hold (a checkpoint would not list them). */
  holding(): boolean {
    for (const state of this.logical.values()) if (state.held.length > 0) return true;
    return false;
  }

  /** Where the running rebuild stands, for the memory log; null when none runs. */
  rebuildProgress(): Record<string, string | number | null> | null {
    const job = this.job;
    if (!job) return null;
    return {
      source: job.state.name,
      phase: job.phase,
      days: [...job.days].sort().join(","),
      late: job.late.length,
      refolded: job.refolded,
      staged: job.staged,
      seconds: Math.round((this.wall.now() - job.started) / 1000),
    };
  }

  /** Reports of the rebuilds swapped in since the last call. */
  takeRebuildReports(): RebuildReport[] {
    return this.reports.splice(0);
  }

  /** The next source with late payloads or pending days, as a rebuild that reads its late payloads. */
  private async nextJob(): Promise<RebuildJob | null> {
    for (const state of [...this.logical.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      if (state.late.length === 0 && state.pendingDays.size === 0) continue;
      const late = [...state.late];
      const days = new Set(state.pendingDays);
      for (const day of this.daysInMemory(state, late)) days.add(day);
      const job: RebuildJob = {
        state,
        late,
        lateIds: new Set(late.map((entry) => entry.id)),
        from: state.pendingFrom,
        started: this.wall.now(),
        days,
        phase: "days",
        dayReader: null,
        reader: null,
        observed: new Map(late.map((entry) => [entry.id, entry.observedAt])),
        fold: null,
        ranges: new Map(),
        foldAt: new Map(),
        entries: new Map(),
        start: Number.NEGATIVE_INFINITY,
        newestHeader: null,
        lastFoldAt: Number.NEGATIVE_INFINITY,
        cut: Number.NEGATIVE_INFINITY,
        target: null,
        logs: [],
        refolded: 0,
        staged: 0,
      };
      state.late.length = 0;
      state.pendingDays.clear();
      state.pendingFrom = Number.POSITIVE_INFINITY;
      if (late.length > 0) {
        job.dayReader = this.reload(late.map((entry) => entry.record))[Symbol.asyncIterator]();
      }
      return job;
    }
    return null;
  }

  /** Works on a rebuild while `more` allows; true once it is swapped in (or needed no rebuild). */
  private async advance(
    job: RebuildJob,
    more: () => boolean,
    budget: { payloads: number },
  ): Promise<boolean> {
    if (job.phase === "days") {
      if (!(await this.readLateDays(job, more))) return false;
      if (!(await this.beginRefold(job))) return true;
    }
    if (!(await this.refoldSome(job, more, budget))) return false;
    await this.swap(job);
    return true;
  }

  /** Reads late payloads back for the days their trips match; true once all are read. */
  private async readLateDays(job: RebuildJob, more: () => boolean): Promise<boolean> {
    while (job.dayReader && more()) {
      const next = await job.dayReader.next();
      if (next.done) {
        job.dayReader = null;
        break;
      }
      const observedAt = job.observed.get(next.value.record.object?.id ?? "");
      if (observedAt === undefined) continue;
      for (const day of this.matchedDays(next.value, observedAt)) job.days.add(day);
    }
    return job.dayReader === null;
  }

  /**
   * Folds payloads of the rebuild's rounds while `more` allows; true once it has caught up with the
   * tail, so the swap follows at once, before the tail can add a payload.
   */
  private async refoldSome(
    job: RebuildJob,
    more: () => boolean,
    budget: { payloads: number },
  ): Promise<boolean> {
    while (more()) {
      if (!job.reader && !this.nextRound(job)) return true;
      const next = await (job.reader as NonNullable<RebuildJob["reader"]>).next();
      if (next.done) {
        job.reader = null;
        continue;
      }
      budget.payloads -= 1;
      await this.refoldEntry(job, next.value.item, next.value.entry);
    }
    return false;
  }

  /**
   * Settles the days of a rebuild and starts its refold: days too old are left out, late payloads
   * that touch no day get their log line at once. False when nothing is left to fold again.
   */
  private async beginRefold(job: RebuildJob): Promise<boolean> {
    const { state, days } = job;
    for (const day of [...days]) {
      if (!state.dayRanges.has(day) && this.keptFrom !== null && day < this.keptFrom) {
        days.delete(day);
        this.coverageOf(state.name).daysTooOld += 1;
      }
    }
    if (days.size === 0) {
      for (const entry of state.entries.filter((item) => job.lateIds.has(item.id))) {
        entry.foldAt = null;
        await this.lateWithoutDays(state, entry);
      }
      return false;
    }
    job.start = this.windowStart(state, days, job.lateIds, job.from);
    const firstChanged = state.entries.find(
      (entry) => job.lateIds.has(entry.id) || entry.at >= job.from,
    );
    job.cut = firstChanged
      ? this.foldedBefore(state, firstChanged).lastFoldAt
      : Number.NEGATIVE_INFINITY;
    const window = state.entries.filter((entry) => entry.at >= job.start);
    const folded = this.foldedBefore(state, window[0]);
    job.newestHeader = folded.newestHeader;
    job.lastFoldAt = folded.lastFoldAt;
    job.fold = new SourceFold(state.name, this.matcher.timetable);
    job.fold.rowsOnEviction = true;
    job.target = await this.sink.rebuild(state.name, [...days].sort(), job.cut);
    job.phase = "refold";
    return true;
  }

  /**
   * Opens a reader over the payloads of the source the rebuild has not folded yet: the window at
   * first, then those the live tail added since. Payloads that came late meanwhile wait for the next
   * rebuild. False when the rebuild has caught up.
   */
  private nextRound(job: RebuildJob): boolean {
    const waiting = new Set(job.state.late.map((entry) => entry.id));
    const round = job.state.entries.filter(
      (entry) => entry.at >= job.start && !job.entries.has(entry.id) && !waiting.has(entry.id),
    );
    if (round.length === 0) return false;
    const byId = new Map(round.map((entry) => [entry.id, entry]));
    for (const entry of round) job.entries.set(entry.id, entry);
    const reloaded = this.reload(round.map((entry) => entry.record));
    job.reader = inEntryOrder(reloaded, byId)[Symbol.asyncIterator]();
    return true;
  }

  /** Folds one payload of a rebuild into its new fold; rows only from the cut on. */
  private async refoldEntry(job: RebuildJob, item: StoredPayload, entry: Entry): Promise<void> {
    const name = job.state.name;
    const full = job.lateIds.has(entry.id);
    const sink: RowWriter = {
      write: async (batch, log) => {
        const rows = batch.forecasts.length + batch.stopEvents.length;
        if (log) job.logs.push({ log, rows });
        if (isEmptyBatch(batch)) return;
        await (job.target as RebuildTarget).stage(batch);
        job.staged += rows + batch.segments.length;
      },
    };
    job.refolded += 1;
    if (superseded(entry, job.newestHeader)) {
      job.foldAt.set(entry.id, null);
      if (full) await this.skip(item, entry, name, sink);
      return;
    }
    if (entry.header !== null) job.newestHeader = entry.header;
    const foldAt = Math.max(entry.observedAt, job.lastFoldAt);
    job.lastFoldAt = foldAt;
    job.foldAt.set(entry.id, foldAt);
    const fold = job.fold as SourceFold;
    const writes = full || foldAt >= job.cut;
    const before = fold.activeDays();
    await this.processPayload(item, entry, name, {
      fold,
      full,
      days: job.days,
      foldAt,
      sink: writes ? sink : DISCARD,
    });
    this.noteDays(job.ranges, fold, entry.at, before);
  }

  /**
   * Stages the final rows of the instances still in the new fold, swaps the staged rows in, and
   * hands the rebuilt days to the live fold, which has folded the same payloads meanwhile.
   */
  private async swap(job: RebuildJob): Promise<void> {
    const { state, days } = job;
    const fold = job.fold as SourceFold;
    const target = job.target as RebuildTarget;
    let finals: StopEventRow[] = [];
    for (const row of fold.stopRows()) {
      finals.push(row);
      if (finals.length < FINAL_ROWS_PER_STAGE) continue;
      await target.stage({ ...emptyBatch(), stopEvents: finals });
      job.staged += finals.length;
      finals = [];
    }
    if (finals.length > 0) {
      await target.stage({ ...emptyBatch(), stopEvents: finals });
      job.staged += finals.length;
    }
    const swapStarted = this.wall.now();
    const logs = job.logs.map(({ log, rows }) => ({
      log: { ...log, processedAt: swapStarted },
      rows,
    }));
    let counts: SwapCounts;
    try {
      counts = await target.swap(logs);
    } catch (error) {
      if (!(error instanceof StagingLostError)) throw error;
      this.requeue(job);
      this.reports.push(this.report(job, swapStarted, null));
      return;
    }
    const swapMs = this.wall.now() - swapStarted;
    fold.rowsOnEviction = false;
    fold.useTimetable(this.matcher.timetable);
    if (this.keptFrom !== null) fold.pruneBefore(this.keptFrom);
    state.fold.takeDays(days, fold);
    const rebuiltChanges = this.irisChanges.get(fold);
    if (rebuiltChanges) this.irisChangesOf(state.fold).takeDays(days, rebuiltChanges);
    for (const [id, foldAt] of job.foldAt) {
      const entry = job.entries.get(id);
      if (entry) entry.foldAt = foldAt;
    }
    for (const day of days) state.dayRanges.delete(day);
    for (const [day, range] of job.ranges) state.dayRanges.set(day, range);
    const folded = this.foldedBefore(state, undefined);
    state.newestHeader = folded.newestHeader;
    state.lastFoldAt = folded.lastFoldAt;
    for (const coverage of this.coveragesAt(state.name, this.clock.now())) coverage.rebuilds += 1;
    this.reports.push({ ...this.report(job, swapStarted, counts), swapMs });
  }

  private report(job: RebuildJob, swapStarted: number, counts: SwapCounts | null): RebuildReport {
    return {
      source: job.state.name,
      days: [...job.days].sort(),
      latePayloads: job.late.length,
      refoldedPayloads: job.refolded,
      stagedRows: job.staged,
      cut: Number.isFinite(job.cut) ? new Date(job.cut).toISOString() : null,
      wallMs: this.wall.now() - job.started,
      swapMs: this.wall.now() - swapStarted,
      counts,
    };
  }

  /** Puts a rebuild whose staged rows were lost back as pending work; the next one starts afresh. */
  private requeue(job: RebuildJob): void {
    const { state } = job;
    const waiting = new Set(state.late.map((entry) => entry.id));
    state.late.push(...job.late.filter((entry) => !waiting.has(entry.id)));
    for (const day of job.days) state.pendingDays.add(day);
    state.pendingFrom = Math.min(state.pendingFrom, job.from);
  }

  /**
   * Service days of a late payload known without reading it: those with instances in memory when it
   * was observed and, for a source with several feeds (whose header rule may now skip a payload
   * folded before), every day in memory from then on. The days its own trips match are read later.
   */
  private daysInMemory(state: LogicalSource, late: readonly Entry[]): Set<string> {
    const days = new Set<string>();
    for (const entry of late) {
      const until = entry.header !== null ? (state.cursor?.at ?? entry.at) : entry.at;
      for (const [day, range] of state.dayRanges) {
        if (range.first <= until && range.last >= entry.at) days.add(day);
      }
    }
    return days;
  }

  /**
   * Reads a payload into canonical events: GTFS-RT by the source's profile, DB Timetables answers
   * through the IRIS books (the planned one shared, the changes of `fold`). Undefined without an adapter.
   */
  private adapt(
    record: FetchRecord,
    payload: Uint8Array,
    observedAt: number,
    fold: SourceFold,
  ): AdapterResult | undefined {
    const iris = irisRecording(record.source);
    if (iris) {
      const state = { plans: this.irisPlans, changes: this.irisChangesOf(fold) };
      return adaptIris(payload, iris.endpoint, iris.eva, observedAt, state);
    }
    const profile = profileFor(record.source);
    return profile ? adaptGtfsRt(payload, observedAt, profile) : undefined;
  }

  private irisChangesOf(fold: SourceFold): IrisChanges {
    let changes = this.irisChanges.get(fold);
    if (!changes) {
      changes = new IrisChanges();
      this.irisChanges.set(fold, changes);
    }
    return changes;
  }

  /** Service days of the runs a payload's trips match. */
  private matchedDays({ record, payload }: StoredPayload, observedAt: number): Set<string> {
    const days = new Set<string>();
    if (irisRecording(record.source)) return this.irisDays({ record, payload }, observedAt);
    const scratch = new SourceFold(foldSourceOf(record.source), this.matcher.timetable);
    const result = this.adapt(record, payload, observedAt, scratch);
    if (!result?.ok) return days;
    for (const event of result.events) {
      if (event.kind !== "trip") continue;
      const outcome = this.matcher.match(event, result.feedVersion);
      if (outcome.kind === "matched") days.add(outcome.run.serviceDate);
    }
    return days;
  }

  /**
   * Service days a late IRIS answer touches: its answer alone often matches nothing (a change before
   * the plan is known, a plan without a change), yet it changes what later answers built. So every
   * trip it names counts, by the day its run was matched on, else by its start date.
   */
  private irisDays({ record, payload }: StoredPayload, observedAt: number): Set<string> {
    const recording = irisRecording(record.source);
    const days = new Set<string>();
    if (!recording) return days;
    const touched = new Set<string>();
    const state = { plans: this.irisPlans, changes: new IrisChanges(), touched };
    adaptIris(payload, recording.endpoint, recording.eva, observedAt, state);
    for (const tripId of touched) {
      const day = this.irisTripDays.get(tripId) ?? irisTripStartDate(tripId);
      if (day) days.add(day);
    }
    return days;
  }

  /**
   * Folds every payload of a source again into a new fold that replaces the old one (a restart
   * without a checkpoint), writing the rows in one commit where the sink can.
   */
  private async refoldAll(state: LogicalSource): Promise<void> {
    const outer = this.sink;
    let refolded: { fold: SourceFold; ranges: Map<string, DayRange> } | undefined;
    const work = async (sink: RowSink) => {
      this.sink = sink;
      try {
        refolded = await this.refold(state, state.entries, new Set(), undefined);
      } finally {
        this.sink = outer;
      }
    };
    if (outer.atomically) await outer.atomically(work);
    else await work(outer);
    const { fold, ranges } = refolded as { fold: SourceFold; ranges: Map<string, DayRange> };
    state.fold = fold;
    state.dayRanges.clear();
    for (const [day, range] of ranges) state.dayRanges.set(day, range);
    const folded = this.foldedBefore(state, undefined);
    state.newestHeader = folded.newestHeader;
    state.lastFoldAt = folded.lastFoldAt;
    for (const coverage of this.coveragesAt(state.name, this.clock.now())) coverage.rebuilds += 1;
  }

  /** The first payload a rebuild of `days` folds again. */
  private windowStart(
    state: LogicalSource,
    days: ReadonlySet<string>,
    late: ReadonlySet<string>,
    from: number,
  ): number {
    let start = from;
    for (const day of days) start = Math.min(start, state.dayRanges.get(day)?.first ?? start);
    for (const entry of state.entries) if (late.has(entry.id)) start = Math.min(start, entry.at);
    const changes = this.irisChanges.get(state.fold);
    if (changes) start = Math.min(start, changes.firstAnswerFor(days));
    return start;
  }

  /** Folds the payloads of `window` into a new fold that keeps only runs of `days` (all without). */
  private async refold(
    state: LogicalSource,
    window: readonly Entry[],
    late: ReadonlySet<string>,
    days: ReadonlySet<string> | undefined,
  ): Promise<{ fold: SourceFold; ranges: Map<string, DayRange> }> {
    const fold = new SourceFold(state.name, this.matcher.timetable);
    const ranges = new Map<string, DayRange>();
    const byId = new Map(window.map((entry) => [entry.id, entry]));
    let { newestHeader, lastFoldAt } = this.foldedBefore(state, window[0]);
    for (const entry of window) entry.foldAt = null;
    const reloaded = this.reload(window.map((entry) => entry.record));
    for await (const { item, entry } of inEntryOrder(reloaded, byId)) {
      const full = late.has(entry.id);
      if (superseded(entry, newestHeader)) {
        if (full) await this.skip(item, entry, state.name);
        continue;
      }
      if (entry.header !== null) newestHeader = entry.header;
      entry.foldAt = Math.max(entry.observedAt, lastFoldAt);
      lastFoldAt = entry.foldAt;
      const context = days ? { fold, full, days } : { fold, full };
      const before = fold.activeDays();
      await this.processPayload(item, entry, state.name, context);
      this.noteDays(ranges, fold, entry.at, before);
    }
    return { fold, ranges };
  }

  /** A late payload whose trips touch no service day: its log line and order-free rows only. */
  private async lateWithoutDays(state: LogicalSource, entry: Entry): Promise<void> {
    for await (const item of this.reload([entry.record])) {
      const fold = new SourceFold(state.name, this.matcher.timetable);
      await this.processPayload(item, entry, state.name, { fold, full: true, days: new Set() });
    }
  }

  /** A payload that could not even be read: its log line names the error, and it is not retried. */
  async unreadable(record: FetchRecord, error: unknown): Promise<void> {
    if (!this.remember(record)) return;
    await this.sink.write(emptyBatch(), {
      rawObjectId: record.object?.id ?? "",
      sourceId: record.source,
      foldSourceId: foldSourceOf(record.source),
      observedAt: Date.parse(record.observedAt),
      processedAt: this.wall.now(),
      counts: {},
      error: errorText("payload not readable", error),
    });
  }

  /** Remembers a payload id; false when it was seen before. */
  private remember(record: FetchRecord): boolean {
    const id = record.object?.id;
    if (!id || this.processedIds.has(id)) return false;
    this.processedIds.set(id, Date.parse(record.observedAt));
    return true;
  }

  /**
   * Forgets what only matters for older days: payloads beyond the horizon, the day ranges, seen maps
   * and evicted instances of service days before `day`, and the matcher's caches of those days.
   */
  dropBefore(day: string, now = this.clock.now()): void {
    const horizon = now - this.horizonMs;
    this.keptFrom = day;
    for (const [id, at] of [...this.processedIds]) {
      if (at < horizon) this.processedIds.delete(id);
    }
    for (const state of this.logical.values()) this.pruneSource(state, day, horizon);
    for (const map of [
      this.instanceSeen,
      this.instanceSourceSeen,
      this.backlogSeen,
      this.alertSeen,
    ]) {
      for (const [key, seen] of [...map]) if (seen.day < day) map.delete(key);
    }
    this.pruneUnloaded(day);
    this.irisPlans.dropBefore(day);
    for (const [tripId, tripDay] of [...this.irisTripDays]) {
      if (tripDay < day) this.irisTripDays.delete(tripId);
    }
    this.matcher.dropBefore(day);
  }

  /** Keeps a source's day ranges from `day` on and its payloads back to the first of those days. */
  private pruneSource(state: LogicalSource, day: string, horizon: number): void {
    for (const rangeDay of [...state.dayRanges.keys()]) {
      if (rangeDay < day) state.dayRanges.delete(rangeDay);
    }
    const changes = this.irisChanges.get(state.fold);
    changes?.dropBefore(day);
    let cutoff = Math.min(horizon, changes?.firstAnswer() ?? horizon);
    for (const range of state.dayRanges.values()) cutoff = Math.min(cutoff, range.first);
    const firstKept = state.entries.find((entry) => entry.at >= cutoff);
    state.pruned = this.foldedBefore(state, firstKept);
    state.entries = firstKept ? state.entries.slice(state.entries.indexOf(firstKept)) : [];
    state.fold.pruneBefore(day);
  }

  private pruneUnloaded(day: string): void {
    for (const [version, sources] of [...this.unloadedVersions]) {
      for (const [source, named] of [...sources]) {
        for (const unloadedDay of [...named.days]) {
          if (unloadedDay < day) named.days.delete(unloadedDay);
        }
        if (named.days.size === 0) sources.delete(source);
      }
      if (sources.size === 0) this.unloadedVersions.delete(version);
    }
  }

  /** Plain data of the fold state and order of every logical source, for a checkpoint. */
  snapshot(): ProcessorSnapshot {
    return {
      version: 1,
      feedVersions: this.matcher.versions(),
      versions: this.versionBook(),
      sources: [...this.logical.values()].map((state) => ({
        ...this.sourceHead(state),
        fold: state.fold.snapshot(),
      })),
      iris: {
        plans: [...this.irisPlans.snapshot()],
        changes: [...this.logical.values()].flatMap((state) => {
          const changes = this.irisChanges.get(state.fold);
          return changes ? [{ source: state.name, trips: [...changes.snapshot()] }] : [];
        }),
      },
    };
  }

  /**
   * The same snapshot as a stream of small parts (a head, then per source its head and one part per
   * instance), so writing a checkpoint never holds the whole state twice.
   */
  *checkpointLines(database?: string): Generator<CheckpointLine> {
    yield {
      kind: "head",
      version: 1,
      feedVersions: this.matcher.versions(),
      ...(database === undefined ? {} : { database }),
      versions: this.versionBook(),
    };
    for (const state of this.logical.values()) {
      yield { kind: "source", ...this.sourceHead(state), fold: state.fold.snapshotHead() };
      for (const value of state.fold.instanceSnapshots()) {
        yield { kind: "instance", source: state.name, value };
      }
    }
    for (const value of this.irisPlans.snapshot()) yield { kind: "iris-plan", value };
    for (const state of this.logical.values()) {
      for (const value of this.irisChanges.get(state.fold)?.snapshot() ?? []) {
        yield { kind: "iris-change", source: state.name, value };
      }
    }
  }

  private versionBook(): VersionBook {
    return {
      lastNamed: [...this.versionLastNamed],
      unloaded: [...this.unloadedVersions].map(
        ([version, sources]) =>
          [
            version,
            [...sources].map(
              ([source, named]) => [source, { days: [...named.days], from: named.from }] as const,
            ),
          ] as const,
      ),
    };
  }

  private restoreVersionBook(book: VersionBook | undefined): void {
    if (!book) return;
    for (const [version, at] of book.lastNamed) this.versionLastNamed.set(version, at);
    for (const [version, sources] of book.unloaded) {
      this.unloadedVersions.set(
        version,
        new Map(
          sources.map(([source, named]) => [
            source,
            { days: new Set(named.days), from: named.from },
          ]),
        ),
      );
    }
  }

  private sourceHead(state: LogicalSource): Omit<ProcessorSnapshot["sources"][number], "fold"> {
    return {
      name: state.name,
      cursor: state.cursor?.id ?? null,
      lastPrimaryAt: state.lastPrimaryAt,
      dayRanges: [...state.dayRanges].map(([day, range]) => [day, { ...range }] as const),
      entries: state.entries.map((entry) => entry.id),
      pruned: {
        newestHeader: state.pruned.newestHeader,
        lastFoldAt: Number.isFinite(state.pruned.lastFoldAt) ? state.pruned.lastFoldAt : null,
      },
      foldAt: state.entries
        .filter((entry) => entry.foldAt !== null)
        .map((entry) => [entry.id, entry.foldAt as number] as const),
      ...this.pendingOf(state),
    };
  }

  /** What a source still has to rebuild, a running rebuild included, so a restore starts it again. */
  private pendingOf(
    state: LogicalSource,
  ): Pick<ProcessorSnapshot["sources"][number], "late" | "pendingDays" | "pendingFrom"> {
    const job = this.job?.state === state ? this.job : null;
    const late = [...(job?.late ?? []), ...state.late].map((entry) => entry.id);
    const days = new Set([...(job?.days ?? []), ...state.pendingDays]);
    const from = Math.min(job?.from ?? Number.POSITIVE_INFINITY, state.pendingFrom);
    if (late.length === 0 && days.size === 0) return {};
    return {
      late,
      pendingDays: [...days].sort(),
      pendingFrom: Number.isFinite(from) ? from : null,
    };
  }

  /**
   * Restores a checkpoint; `lookup` finds the recorded payloads it names. Payloads processed after
   * the checkpoint are not in it, so they are processed again when delivered (their rows are written
   * again unchanged). False when it does not fit (a run's version is no longer loaded).
   */
  restore(snapshot: ProcessorSnapshot, lookup: (id: string) => FetchRecord | undefined): boolean {
    if (snapshot.version !== 1) return false;
    if (snapshot.feedVersions.join("\n") !== this.matcher.versions().join("\n")) return false;
    const resolve = (ref: RunRef): TripRun | undefined => {
      if (ref.kind === "added") return addedRun(ref);
      const table = this.matcher.timetables.find(
        (item) => item.feedVersionId === ref.feedVersionId,
      );
      return table?.canonicalRun(ref.instanceId, ref.serviceDate);
    };
    const restored = new Map<string, LogicalSource>();
    for (const item of snapshot.sources) {
      const fold = SourceFold.restore(item.fold, this.matcher.timetable, resolve);
      if (!fold) return false;
      const foldAt = new Map(item.foldAt);
      const late = new Set(item.late ?? []);
      const entries = item.entries
        .flatMap((id) => lookup(id) ?? [])
        .map((record) => {
          const entry = this.entryOf(record);
          entry.foldAt = foldAt.get(entry.id) ?? null;
          return entry;
        })
        .sort(compareEntries);
      const state: LogicalSource = {
        name: item.name,
        fold,
        entries,
        cursor: entries.find((entry) => entry.id === item.cursor) ?? entries.at(-1) ?? null,
        newestHeader: null,
        lastFoldAt: Number.NEGATIVE_INFINITY,
        pruned: {
          newestHeader: item.pruned.newestHeader,
          lastFoldAt: item.pruned.lastFoldAt ?? Number.NEGATIVE_INFINITY,
        },
        dayRanges: new Map(item.dayRanges.map(([day, range]) => [day, { ...range }])),
        held: [],
        late: entries.filter((entry) => late.has(entry.id)),
        pendingDays: new Set(item.pendingDays ?? []),
        pendingFrom: item.pendingFrom ?? Number.POSITIVE_INFINITY,
        lastPrimaryAt: item.lastPrimaryAt,
      };
      const folded = this.foldedBefore(state, undefined);
      state.newestHeader = folded.newestHeader;
      state.lastFoldAt = folded.lastFoldAt;
      restored.set(item.name, state);
    }
    for (const [name, state] of restored) {
      this.logical.set(name, state);
      for (const entry of state.entries) this.remember(entry.record);
    }
    this.restoreVersionBook(snapshot.versions);
    this.restoreIris(snapshot.iris, restored);
    return true;
  }

  /** Takes the IRIS books of a checkpoint back, so the next answer folds onto what came before. */
  private restoreIris(iris: IrisSnapshot | undefined, sources: ReadonlyMap<string, LogicalSource>) {
    if (!iris) return;
    for (const trip of iris.plans) this.irisPlans.restoreTrip(trip);
    for (const { source, trips } of iris.changes) {
      const state = sources.get(source);
      if (!state) continue;
      const changes = new IrisChanges();
      for (const trip of trips) changes.restoreTrip(trip);
      this.irisChanges.set(state.fold, changes);
    }
  }

  /**
   * Adapts, matches, folds and writes one payload. A payload that fails anywhere is written as an
   * error with its processing log line and no rows, and the run goes on with the next one.
   */
  private async processPayload(
    { record, payload }: StoredPayload,
    entry: Entry,
    name: string,
    context: PassContext,
  ): Promise<void> {
    const pass: Pass = {
      name,
      context,
      rawObjectId: entry.id,
      coverages: context.full ? this.coveragesAt(name, entry.observedAt) : [],
      counts: {},
      batch: emptyBatch(),
      feedVersion: null,
      delfi: false,
      applied: new Set(),
    };
    let error: string | null = null;
    try {
      error = this.adaptAndFold(pass, record, payload, entry);
    } catch (failure) {
      error = errorText("processing failed", failure);
      pass.batch = emptyBatch();
    }
    if (!context.full) {
      if (!error) await (context.sink ?? this.sink).write(pass.batch, null);
      return;
    }
    await this.writeLogged(pass, record, entry, error);
  }

  /** Adapts and folds a payload into `pass`; returns the reason it could not, or null. */
  private adaptAndFold(
    pass: Pass,
    record: FetchRecord,
    payload: Buffer,
    entry: Entry,
  ): string | null {
    const observedAt = pass.context.foldAt ?? entry.foldAt ?? entry.observedAt;
    const result = this.adapt(record, payload, observedAt, pass.context.fold);
    if (!result) return "no adapter for source";
    if (!result.ok) return refusal(result.failure.error);
    pass.feedVersion = result.feedVersion;
    pass.delfi = profileFor(record.source)?.delfi ?? false;
    this.noteVersion(pass, result.feedVersion, entry.observedAt);
    for (const event of result.events) {
      if (event.kind === "trip") this.trip(pass, event);
      else if (pass.context.full) {
        bump(pass, event.kind);
        if (event.kind === "alert")
          this.alert(event, result.feedVersion, pass.rawObjectId, pass.batch);
      }
    }
    pass.context.fold.advance(observedAt, pass.rawObjectId, pass.batch);
    return null;
  }

  /** Counts the feed version a payload names and when it was last named. */
  private noteVersion(pass: Pass, feedVersion: string | null, observedAt: number): void {
    const version = feedVersion ?? "none";
    for (const coverage of pass.coverages) {
      coverage.feedVersions.set(version, (coverage.feedVersions.get(version) ?? 0) + 1);
    }
    if (feedVersion === null || !pass.delfi) return;
    const named = this.versionLastNamed.get(feedVersion) ?? 0;
    this.versionLastNamed.set(feedVersion, Math.max(named, observedAt));
  }

  /** Writes a first-time payload's rows with its log line; a failed write leaves the line alone. */
  private async writeLogged(
    pass: Pass,
    record: FetchRecord,
    entry: Entry,
    failure: string | null,
  ): Promise<void> {
    let error = failure;
    const log = (rows: RowBatch, text: string | null): Promise<void> =>
      (pass.context.sink ?? this.sink).write(rows, {
        rawObjectId: entry.id,
        sourceId: record.source,
        foldSourceId: pass.name,
        observedAt: entry.observedAt,
        processedAt: this.wall.now(),
        counts: pass.counts,
        error: text,
      });
    try {
      await log(error ? emptyBatch() : pass.batch, error);
    } catch (writeFailure) {
      error = errorText("write failed", writeFailure);
      await log(emptyBatch(), error);
    }
    for (const coverage of pass.coverages) {
      coverage.payloads += 1;
      if (error) coverage.failedPayloads += 1;
    }
  }

  private noteUnloaded(
    name: string,
    feedVersion: string | null,
    outcome: { serviceDate: string } | null,
    observedAt: number,
  ): void {
    if (feedVersion === null || this.matcher.byVersion(feedVersion) || !outcome) return;
    const sources = this.unloadedVersions.get(feedVersion) ?? new Map<string, UnloadedNames>();
    const named = sources.get(name) ?? { days: new Set<string>(), from: observedAt };
    named.days.add(outcome.serviceDate);
    named.from = Math.min(named.from, observedAt);
    sources.set(name, named);
    this.unloadedVersions.set(feedVersion, sources);
  }

  /**
   * Matches one trip update and folds it. A run named twice in one payload (two source trips that
   * fit the same train) is folded once, from the first entity in payload order; the rest are counted.
   * In a rebuild only runs of the rebuilt days are folded; a late payload still counts the others.
   */
  private trip(pass: Pass, observation: TripObservation): void {
    const outcome = this.matcher.match(observation, pass.feedVersion);
    if (outcome.kind === "matched" && observation.source === IRIS_SOURCE) {
      this.irisTripDays.set(observation.sourceTripId ?? "", outcome.run.serviceDate);
    }
    const days = pass.context.days;
    const outside =
      outcome.kind === "matched" && days !== undefined && !days.has(outcome.run.serviceDate);
    if (!pass.context.full) {
      if (outcome.kind === "matched" && !outside) this.refoldTrip(pass, observation, outcome);
      return;
    }
    bump(pass, "trip");
    if (outside) {
      bump(pass, `matched:${outcome.method}`);
      bump(pass, "day_not_rebuilt");
      return;
    }
    const day = outcome.kind === "out_of_scope" ? null : outcomeDay(outcome);
    if (pass.delfi) this.noteUnloaded(pass.name, pass.feedVersion, day, observation.observedAt);
    if (outcome.kind === "matched") this.foldMatched(pass, observation, outcome);
    else this.notMatched(pass, observation, outcome);
  }

  /** A matched trip in a rebuild: folded again; instance and last seen only where they move. */
  private refoldTrip(pass: Pass, observation: TripObservation, outcome: MatchedTrip): void {
    if (pass.applied.has(outcome.run.instanceId)) return;
    pass.applied.add(outcome.run.instanceId);
    this.instance(outcome, observation, pass.rawObjectId, pass.batch);
    this.sourceSeen(outcome.run, observation, pass.rawObjectId, pass.batch, false);
    pass.context.fold.apply(
      outcome,
      observation,
      observation.observedAt,
      pass.rawObjectId,
      pass.batch,
    );
  }

  private notMatched(
    pass: Pass,
    observation: TripObservation,
    outcome: UnmatchedTrip | { kind: "out_of_scope"; reason: string },
  ): void {
    const key = `${observation.sourceTripId ?? observation.entityId}|${observation.startDate ?? ""}`;
    const label = outcome.kind === "out_of_scope" ? "out_of_scope" : "unmatched";
    bump(pass, `${label}:${outcome.reason}`);
    if (this.keepCoverage) {
      for (const coverage of pass.coverages) {
        (outcome.kind === "out_of_scope" ? coverage.outOfScope : coverage.unmatched).set(
          key,
          outcome.reason,
        );
      }
    }
    if (outcome.kind === "unmatched" && !COUNT_ONLY_REASONS.has(outcome.reason)) {
      this.backlog(observation, outcome, pass.rawObjectId, pass.batch);
    }
  }

  private foldMatched(pass: Pass, observation: TripObservation, outcome: MatchedTrip): void {
    const instanceId = outcome.run.instanceId;
    if (pass.applied.has(instanceId)) {
      bump(pass, "duplicate_run_in_payload");
      return;
    }
    pass.applied.add(instanceId);
    bump(pass, `matched:${outcome.method}`);
    if (this.keepCoverage) {
      for (const coverage of pass.coverages) {
        coverage.matched.set(instanceId, outcome.run.trip.categoryCode);
        const byMethod = coverage.matchedByMethod.get(outcome.method) ?? new Set<string>();
        byMethod.add(instanceId);
        coverage.matchedByMethod.set(outcome.method, byMethod);
      }
    }
    if (outcome.unplacedStops > 0) bump(pass, "unplaced_stops");
    this.instance(outcome, observation, pass.rawObjectId, pass.batch);
    this.sourceSeen(outcome.run, observation, pass.rawObjectId, pass.batch, true);
    const effect = pass.context.fold.apply(
      outcome,
      observation,
      observation.observedAt,
      pass.rawObjectId,
      pass.batch,
    );
    bump(pass, "implausible_early_delay", effect.implausibleDelays);
    bump(pass, "kept_in_order", effect.reordered);
    for (const coverage of pass.coverages) {
      coverage.implausibleDelays += effect.implausibleDelays;
      coverage.reordered += effect.reordered;
    }
  }

  private instance(
    match: MatchedTrip,
    observation: TripObservation,
    rawObjectId: string,
    batch: RowBatch,
  ): void {
    const run = match.run;
    const seen = this.instanceSeen.get(run.instanceId);
    const at = observation.observedAt;
    if (seen && (seen.at < at || (seen.at === at && seen.source <= observation.source))) return;
    this.instanceSeen.set(run.instanceId, { at, source: observation.source, day: run.serviceDate });
    batch.instances.push({
      tripInstanceId: run.instanceId,
      serviceDate: run.serviceDate,
      feedVersionId: run.added ? null : (run.feedVersionId ?? this.matcher.timetable.feedVersionId),
      tripKey: run.added ? null : run.trip.tripKey,
      operatorId: run.trip.operatorId,
      trainNumber: run.trip.trainNumber,
      categoryCode: run.added ? null : run.trip.categoryCode,
      originStopPlaceId: run.trip.stopPlaces[0] ?? "",
      originDeparture: run.originDeparture,
      isAdded: run.added === true,
      sourceId: observation.source,
      observedAt: at,
      rawObjectId,
    });
  }

  /**
   * When a source named an instance first and last: written when its last sighting moved by at
   * least `SOURCE_SEEN_STEP_MS` since the last write, and whenever the first sighting moves earlier.
   */
  private sourceSeen(
    run: TripRun,
    observation: TripObservation,
    rawObjectId: string,
    batch: RowBatch,
    always: boolean,
  ): void {
    const key = `${run.instanceId}\x1f${observation.source}`;
    const at = observation.observedAt;
    const seen = this.instanceSourceSeen.get(key);
    const earlier = !seen || at < seen.first;
    const written = seen?.written ?? Number.NEGATIVE_INFINITY;
    const due = earlier || (always && at - written >= SOURCE_SEEN_STEP_MS);
    this.instanceSourceSeen.set(key, {
      first: Math.min(seen?.first ?? at, at),
      last: Math.max(seen?.last ?? at, at),
      day: run.serviceDate,
      written: due ? Math.max(written, at) : written,
    });
    if (!due) return;
    batch.instanceSeen.push({
      tripInstanceId: run.instanceId,
      sourceId: observation.source,
      observedAt: at,
      rawObjectId,
    });
  }

  private extendSeen(
    seen: Map<string, SeenRange>,
    key: string,
    observedAt: number,
    day: string,
  ): SeenRange | undefined {
    const hour = hourOf(observedAt);
    const range = seen.get(key);
    if (range && range.first <= observedAt && range.lastHour >= hour) return undefined;
    const next = {
      first: Math.min(range?.first ?? observedAt, observedAt),
      lastHour: Math.max(range?.lastHour ?? hour, hour),
      day,
    };
    seen.set(key, next);
    return next;
  }

  private backlog(
    observation: TripObservation,
    outcome: UnmatchedTrip,
    rawObjectId: string,
    batch: RowBatch,
  ): void {
    const entityKey = observation.sourceTripId ?? observation.entityId;
    const key = [observation.source, entityKey, outcome.serviceDate, outcome.reason].join("\x1f");
    if (!this.extendSeen(this.backlogSeen, key, observation.observedAt, outcome.serviceDate))
      return;
    batch.backlog.push({
      sourceId: observation.source,
      entityKey,
      serviceDate: outcome.serviceDate,
      reason: outcome.reason,
      detail: outcome.detail,
      firstObservedAt: observation.observedAt,
      firstRawObjectId: rawObjectId,
      lastSeenHour: hourOf(observation.observedAt),
    });
  }

  /**
   * An alert's message (cause, effect, texts, periods: one row per version) and its scope (each trip
   * instance and stop place it names, first seen and last hour), written when either is new or the
   * hour moves on. The selectors themselves stay in the recordings.
   */
  private alert(
    observation: AlertObservation,
    feedVersion: string | null,
    rawObjectId: string,
    batch: RowBatch,
  ): void {
    const message = {
      cause: observation.cause,
      effect: observation.effect,
      severity: observation.severity,
      activePeriods: observation.activePeriods,
      header: observation.header,
      description: observation.description,
      url: observation.url,
    };
    const contentHash = createHash("sha256").update(JSON.stringify(message)).digest("hex");
    const alertKey = profileFor(observation.source)?.alertKeyByContent
      ? contentHash
      : observation.entityId;
    const day = localDate(observation.observedAt);
    const messageKey = [observation.source, alertKey, contentHash].join("\x1f");
    const at = observation.observedAt;
    const base = {
      sourceId: observation.source,
      alertKey,
      contentHash,
      firstObservedAt: at,
      firstRawObjectId: rawObjectId,
      lastSeenHour: hourOf(at),
    };
    if (this.extendSeen(this.alertSeen, messageKey, at, day)) {
      batch.alertMessages.push({
        ...base,
        ...message,
        selectorCount: observation.selectors.length,
      });
    }
    const { trips, places } = alertTargetsOf(this.matcher, observation, feedVersion);
    for (const trip of [...trips].sort()) {
      if (!this.extendSeen(this.alertSeen, `${messageKey}\x1ft${trip}`, at, day)) continue;
      batch.alertScopes.push({ ...base, tripInstanceId: trip, stopPlaceId: null });
    }
    for (const place of [...places].sort()) {
      if (!this.extendSeen(this.alertSeen, `${messageKey}\x1fp${place}`, at, day)) continue;
      batch.alertScopes.push({ ...base, tripInstanceId: null, stopPlaceId: place });
    }
  }
}

function alertTargetsOf(
  matcher: Matcher,
  observation: AlertObservation,
  feedVersion: string | null,
): { trips: Set<string>; places: Set<string> } {
  const tripSource = ALERT_TRIP_SOURCE[observation.source] ?? observation.source;
  const trips = new Set<string>();
  const places = new Set<string>();
  for (const selector of observation.selectors) {
    for (const place of matcher.placesOf(selector.stop, tripSource)) places.add(place);
    if (!selector.sourceTripId) continue;
    const outcome = matcher.match(selectorTrip(observation, tripSource, selector), feedVersion);
    if (outcome.kind === "matched") trips.add(outcome.run.instanceId);
  }
  return { trips, places };
}

function outcomeDay(outcome: MatchedTrip | UnmatchedTrip): { serviceDate: string } {
  return outcome.kind === "matched" ? { serviceDate: outcome.run.serviceDate } : outcome;
}

/** A payload whose snapshot is not newer than one already folded from another feed of the source. */
function isEmptyBatch(batch: RowBatch): boolean {
  return Object.values(batch).every((rows) => (rows as readonly unknown[]).length === 0);
}

function superseded(entry: Entry, newestHeader: number | null): boolean {
  return entry.header !== null && newestHeader !== null && entry.header <= newestHeader;
}

function insertSorted(entries: Entry[], entry: Entry): void {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareEntries(entries[middle] as Entry, entry) < 0) low = middle + 1;
    else high = middle;
  }
  entries.splice(low, 0, entry);
}

/**
 * Puts reloaded payloads, which come in observation order, into entry order: an entry's instant is
 * its observation plus at most the fallback hold, so an entry is final once a payload observed after
 * its instant has come.
 */
async function* inEntryOrder(
  items: AsyncIterable<StoredPayload>,
  byId: ReadonlyMap<string, Entry>,
): AsyncGenerator<{ item: StoredPayload; entry: Entry }> {
  const waiting: { item: StoredPayload; entry: Entry }[] = [];
  for await (const item of items) {
    const entry = byId.get(item.record.object?.id ?? "");
    if (!entry) continue;
    waiting.push({ item, entry });
    waiting.sort((a, b) => compareEntries(a.entry, b.entry));
    while (waiting.length > 0 && (waiting[0] as { entry: Entry }).entry.at < entry.observedAt) {
      yield waiting.shift() as { item: StoredPayload; entry: Entry };
    }
  }
  yield* waiting;
}

/** The first service day kept by the daily pruning: yesterday (its trains run past midnight). */
export function keptFromDay(now: number): string {
  return addDays(localDate(now), -1);
}

function selectorTrip(
  alert: AlertObservation,
  source: string,
  selector: AlertObservation["selectors"][number],
): TripObservation {
  return {
    kind: "trip",
    source,
    entityId: selector.sourceTripId ?? alert.entityId,
    observedAt: alert.observedAt,
    feedTimestamp: null,
    updateTimestamp: null,
    sourceTripId: selector.sourceTripId,
    routeId: selector.routeId,
    directionId: null,
    startDate: selector.startDate,
    startTime: null,
    trainNumber: null,
    relationship: "scheduled",
    vehicleId: null,
    vehicleLabel: null,
    delaySeconds: null,
    stops: [],
  };
}
