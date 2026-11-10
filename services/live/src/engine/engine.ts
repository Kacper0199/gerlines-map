import type { MotionPlan } from "@gerlines/geo";
import {
  type Category,
  type Delta,
  encodeDelta,
  encodeHead,
  encodeKeyframe,
  type Head,
  type HeadCount,
  type HeadMetric,
  type Keyframe,
  type PackSets,
  type TripRecord,
} from "@gerlines/live-frame";
import { addDays, localDate } from "@gerlines/schema/service-day";
import { chooseSource, type HeldSource, SOURCE_SETTLE_S } from "@gerlines/schema/source-priority";
import type { StaticRun } from "../model.ts";
import { placesWithin, type SameStation } from "../plan/place-rows.ts";
import {
  buildPlan,
  createPlanStats,
  END_GRACE_S,
  expectedTimes,
  type LivePlan,
  motionOfPlan,
  mustEmit,
  nextWake,
  type PlanStats,
  type PlanStopState,
  tripRecordOf,
} from "../plan/trip-plan.ts";
import type { RealtimeReader } from "../realtime/readers.ts";
import { RealtimeStore } from "../realtime/store.ts";
import type { FeedVersionInfo, TimetableSource, VersionCoverage } from "../timetable/loader.ts";
import type { RunVehicle, VehicleIdentities } from "../vehicle/identities.ts";
import { DetailDispatcher, type ProgressStop, progressOf } from "./detail-feed.ts";
import type { DetailPort, LiveInstanceState } from "./detail-port.ts";
import type { KeyStore } from "./keys.ts";
import { WakeQueue } from "./wake-queue.ts";

/** How far below the active version's shape coverage a newer version may stay and still be taken. */
export const SWITCH_COVERAGE_SLACK = 0.02;
/** No version below this shape coverage replaces a usable active one (no slide of 0.02 a week). */
export const SWITCH_COVERAGE_FLOOR = 0.9;
/** A newer version must run at least this share of the active version's runs today (a thin feed). */
export const SWITCH_RUNS_FLOOR = 0.9;
/** Seconds between reads of the loaded version list, so a rollback takes effect without a restart. */
export const VERSIONS_REFRESH_S = 300;

/** Versions published by today and not expired, newest first (ties: the higher id). */
function currentCandidates(versions: readonly FeedVersionInfo[], today: string): FeedVersionInfo[] {
  return versions
    .filter((v) => v.publishedOn <= today && !(v.validTo != null && v.validTo < today))
    .sort((a, b) =>
      a.publishedOn === b.publishedOn
        ? b.feedVersionId - a.feedVersionId
        : a.publishedOn < b.publishedOn
          ? 1
          : -1,
    );
}

/** Whether `version` was published after `than` (same day: the higher id), the candidates' order. */
function publishedAfter(version: FeedVersionInfo, than: FeedVersionInfo): boolean {
  return version.publishedOn === than.publishedOn
    ? version.feedVersionId > than.feedVersionId
    : version.publishedOn > than.publishedOn;
}

/** The coverage and run counts a newer version needs, given the usable active version's (or none). */
function switchFloors(
  minimum: number,
  active: VersionCoverage | null,
): { floor: number; runsFloor: number | null } {
  if (active === null) return { floor: minimum, runsFloor: null };
  return {
    floor: Math.max(
      Math.min(SWITCH_COVERAGE_FLOOR, minimum),
      Math.min(minimum, active.coverage - SWITCH_COVERAGE_SLACK),
    ),
    runsFloor: SWITCH_RUNS_FLOOR * active.runs,
  };
}

/** Why the timetable must be decided now, or null when the active version stands. */
function decisionReason(
  versions: readonly FeedVersionInfo[],
  activeVersion: number,
  today: string,
  nightly: boolean,
  pinnedVersion: number | undefined,
): VersionDecision["reason"] | null {
  if (activeVersion === 0) return "start";
  if (
    pinnedVersion !== undefined &&
    pinnedVersion !== activeVersion &&
    versions.some((v) => v.feedVersionId === pinnedVersion)
  )
    return "pinned";
  const current = versions.find((v) => v.feedVersionId === activeVersion);
  if (current === undefined) return "gone";
  if (current.validTo != null && current.validTo < today) return "expired";
  return nightly ? "nightly" : null;
}

/** A candidate version measured at a timetable decision. */
export interface MeasuredCandidate {
  readonly feedVersionId: number;
  readonly coverage: number;
  readonly runs: number;
  /** Whether its shape packs are published (only for a candidate at both floors, with a pack gate). */
  readonly packs?: boolean;
}

/** One timetable decision (at start, nightly, or when the active version expired or went away). */
export interface VersionDecision {
  readonly day: string;
  readonly active: number;
  /** At a cold start: the best-covered current version with packs, decided from as if it were active. */
  readonly reference?: number;
  readonly activeCoverage: number | null;
  readonly activeRuns: number | null;
  readonly reason: "start" | "nightly" | "expired" | "gone" | "pinned" | "packs";
  readonly floor: number;
  /** The fewest runs today a candidate needs (null without a usable active version). */
  readonly runsFloor: number | null;
  readonly candidates: readonly MeasuredCandidate[];
  readonly chosen: number | undefined;
}

/** Where frames go: immutable objects first, then the head that names them. */
export interface FrameSink {
  object(kind: "k" | "d", sequence: number, bytes: Uint8Array): Promise<void>;
  head(bytes: Uint8Array, head: Head): Promise<void>;
}

/** A published chain read back after a restart (FORMAT.md section 3, Restart). */
export interface RestoredChain {
  readonly sequence: number;
  readonly keyframeSequence: number;
  readonly oldestSequence: number;
  readonly timetableVersion: number;
  readonly trips: ReadonlyMap<number, TripRecord>;
}

export interface EngineOptions {
  readonly timetable: TimetableSource;
  readonly reader: RealtimeReader;
  readonly keys: KeyStore;
  readonly sink: FrameSink;
  readonly shapeEpoch: number;
  /** Sequence of the first keyframe of a new chain (above any published before). */
  readonly firstSequence: number;
  readonly holdRule?: boolean;
  readonly detail?: DetailPort;
  /** Called when the detail port rejects an update (the engine keeps ticking). */
  readonly onDetailError?: (error: unknown) => void;
  /** How the detail queue waits before a retry (tests pass a fake). */
  readonly detailRetryWait?: (ms: number) => Promise<void>;
  /** Minimum seconds between deltas (2) and between keyframes (30). */
  readonly deltaInterval?: number;
  readonly keyframeInterval?: number;
  /**
   * Minimum share of today's running patterns with a usable shape for a version to go live (0.95).
   * Set under SWITCH_COVERAGE_FLOOR it lowers that floor too.
   */
  readonly switchCoverage?: number;
  /**
   * A version the operator judged good (`live run --timetable-version N`): taken whenever it is
   * loaded, below every floor; while it is not loaded the usual rules apply.
   */
  readonly pinnedVersion?: number;
  /**
   * Whether a version's shape packs are published (`live run`: marked in the shape epoch's
   * complete.json). A version without them is never taken; one refused only for its packs is
   * looked at again at every read of the version list. Unset: no pack gate (render).
   */
  readonly packsReady?: (feedVersionId: number) => Promise<boolean>;
  /** Called with every timetable decision and the coverages behind it (for the log). */
  readonly onVersionDecision?: (decision: VersionDecision) => void;
  /** Resolves each trip's vehicle (FORMAT 1.3); without it frames carry none. */
  readonly vehicles?: VehicleIdentities;
  /** The published pack sets the head names (FORMAT 1.4, section 4.2); none without it. */
  readonly packSets?: () => PackSets | null;
  /**
   * Waits for a due vehicle read inside the tick, so a render on a virtual clock is repeatable; a
   * live run leaves it off and never waits.
   */
  readonly awaitVehicles?: boolean;
  /**
   * How long the first tick of a live run waits for the first vehicle read, so the chain's first
   * keyframe carries the series instead of a burst of changes after it (ms).
   */
  readonly firstVehicleWaitMs?: number;
}

/** The first tick waits this long at most for the first vehicle read (ms). */
export const FIRST_VEHICLE_WAIT_MS = 10_000;

/** Trains enter the frame this long (s) before their first scheduled departure. */
export const ENTRY_LEAD_S = 600;
const MULTI_SOURCE_RECHECK_S = 60;
/** The run queue sheds its admitted head once this many runs are behind the cursor. */
const QUEUE_TRIM_AT = 4096;

type Status = "drawn" | "untracked" | "cancelled" | "waiting";

interface Tracked {
  readonly run: StaticRun;
  held: HeldSource | null;
  published: LivePlan | null;
  motion: MotionPlan | null;
  key: number | null;
  status: Status;
  wakeAt: number;
  /** A wake entry for `wakeAt` is in the queue (so the same time is not pushed twice). */
  wakeQueued: boolean;
  progress: string;
  /** The furthest stop reported passed (−1: none); progress never goes below it. */
  passed: number;
  progressAt: number;
  progressQueued: boolean;
  noted: { readonly delay: number | null; readonly endsAt: number } | null;
}

export interface TickReport {
  readonly at: number;
  readonly sequence: number;
  readonly delta: number | null;
  readonly keyframe: number | null;
  readonly changedTrips: number;
  readonly removedTrips: number;
  readonly evaluated: number;
  readonly rows: number;
  readonly bytes: { readonly delta: number; readonly keyframe: number; readonly head: number };
}

export interface EngineCounters {
  readonly plan: PlanStats;
  sourceSwitches: number;
  /** Changes inside the settle window: a better source reported shortly after the first choice. */
  sourceSettles: number;
  versionSwitches: number;
  /** Decisions that measured a newer version and kept another (refused: below a floor). */
  versionRefusals: number;
  readonly emitted: { trips: number; deltas: number; keyframes: number };
}

export interface EngineSizes {
  readonly instances: number;
  readonly forecastRows: number;
  readonly tracked: number;
  readonly wake: number;
  readonly progressWake: number;
  readonly queue: number;
  readonly state: number;
  readonly ended: number;
}

const hourFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  hour: "2-digit",
  hourCycle: "h23",
});

/** The Europe/Berlin hour (0 to 23) of a Unix time in seconds. */
export function berlinHour(now: number): number {
  return Number(hourFormat.format(new Date(now * 1000)));
}

/** Counts per metric, in total and per category, in the row order of FORMAT.md 4.1. */
class CountTally {
  private readonly totals = new Map<HeadMetric, Map<Category | null, number>>();

  add(metric: HeadMetric, category: Category): void {
    const byCategory = this.totals.get(metric) ?? new Map<Category | null, number>();
    byCategory.set(null, (byCategory.get(null) ?? 0) + 1);
    byCategory.set(category, (byCategory.get(category) ?? 0) + 1);
    this.totals.set(metric, byCategory);
  }

  list(): HeadCount[] {
    const counts: HeadCount[] = [];
    for (const metric of ["running", "untracked", "cancelled", "realtime"] as const) {
      const byCategory = this.totals.get(metric) ?? new Map<Category | null, number>();
      counts.push({ metric, category: null, count: byCategory.get(null) ?? 0 });
      for (const [category, count] of byCategory) {
        if (category !== null) counts.push({ metric, category, count });
      }
    }
    return counts;
  }
}

/** True between a run's first scheduled departure and its last scheduled arrival. */
function runsAt(run: StaticRun, now: number): boolean {
  const last = run.arrivals[run.arrivals.length - 1] as number;
  return now >= (run.departures[0] as number) && now <= last;
}

/** Expected arrival at the last served stop (the static last arrival when none is served). */
function endsAtOf(stops: readonly ProgressStop[], run: StaticRun): number {
  for (let i = stops.length - 1; i >= 0; i--) {
    const stop = stops[i] as ProgressStop;
    if (stop.stopIndex >= 0 && !stop.cancelled) return stop.arrival;
  }
  return run.arrivals[run.arrivals.length - 1] as number;
}

/** A change of delay or expected end this large re-notes a train the engine does not draw. */
const DETAIL_MOVE_S = 15;

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The live engine (design note sections 1 to 3): every tick it reads new realtime, keeps the set of
 * running trip instances of the active timetable version, rebuilds the plans that a change or the
 * clock touched, assigns trip keys, and publishes deltas, keyframes and the head.
 */
export class LiveEngine {
  readonly store = new RealtimeStore();
  readonly counters: EngineCounters = {
    plan: createPlanStats(),
    sourceSwitches: 0,
    sourceSettles: 0,
    versionSwitches: 0,
    versionRefusals: 0,
    emitted: { trips: 0, deltas: 0, keyframes: 0 },
  };
  private readonly options: EngineOptions;
  private readonly holdRule: boolean;
  private readonly deltaInterval: number;
  private readonly keyframeInterval: number;
  private versions: readonly FeedVersionInfo[] = [];
  /** Renamed-station check over the stop place coordinates read for `coordinatesOf` versions. */
  private sameStation: SameStation | undefined;
  private coordinatesOf = "";
  private activeVersion = 0;
  private versionCheckedOn = "";
  private versionsReadOn = "";
  private versionsReadAt = Number.NEGATIVE_INFINITY;
  private lastDecision = "";
  /** A newer version refused at the last decision only because its packs were missing. */
  private awaitingPacks: number | undefined;
  /** The last decision kept the active version: nothing changes before the version list is read again. */
  private decisionHeld = false;
  /** A restored chain does not know what the decision before the restart waited for. */
  private packsCheckAfterRestore = false;
  private now = 0;
  private readonly loadedDays = new Set<string>();
  private queue: StaticRun[] = [];
  private queueAt = 0;
  private readonly tracked = new Map<string, Tracked>();
  /**
   * Instances the engine ended, by service day: a switch reloads the days under the new version
   * and must not let a train that already arrived back in.
   */
  private readonly ended = new Map<string, Set<string>>();
  private readonly wake = new WakeQueue();
  private readonly state = new Map<number, TripRecord>();
  private readonly pendingChanges = new Map<number, TripRecord>();
  private readonly pendingRemovals = new Set<number>();
  private firstVehicleWaitDone = false;
  private restored = new Map<string, { key: number; record: TripRecord }>();
  private restoredUnclaimed = new Set<number>();
  private sequence = 0;
  private keyframeSequence = 0;
  private oldestSequence = 0;
  private lastDeltaAt = Number.NEGATIVE_INFINITY;
  private lastKeyframeAt = Number.NEGATIVE_INFINITY;
  private startNewChain = true;
  private detailChanged = new Map<string, LiveInstanceState>();
  private detailRemoved = new Map<string, LiveInstanceState>();
  private readonly progressWake = new WakeQueue();
  private readonly dispatcher: DetailDispatcher | null;

  constructor(options: EngineOptions) {
    this.options = options;
    this.dispatcher = options.detail
      ? new DetailDispatcher(options.detail, options.onDetailError, options.detailRetryWait)
      : null;
    this.holdRule = options.holdRule ?? true;
    this.deltaInterval = options.deltaInterval ?? 2;
    this.keyframeInterval = options.keyframeInterval ?? 30;
  }

  get timetableVersion(): number {
    return this.activeVersion;
  }

  /** When the active timetable version was published (null before the first decision). */
  get activeVersionPublishedOn(): string | null {
    return this.versions.find((v) => v.feedVersionId === this.activeVersion)?.publishedOn ?? null;
  }

  get latestSequence(): number {
    return this.sequence;
  }

  /** Sizes of the engine's long-lived structures, for the memory evidence. */
  get sizes(): EngineSizes {
    return {
      instances: this.store.size,
      forecastRows: this.store.rowCount,
      tracked: this.tracked.size,
      wake: this.wake.size,
      progressWake: this.progressWake.size,
      queue: this.queue.length,
      state: this.state.size,
      ended: [...this.ended.values()].reduce((sum, ids) => sum + ids.size, 0),
    };
  }

  /** The state clients hold after the newest frame, by key (for tests and chain checks). */
  get currentState(): ReadonlyMap<number, TripRecord> {
    return this.state;
  }

  /**
   * Shape numbers the frames name from now until `until`: the trips of the state and the runs with
   * a shape the engine admits before `until` (ENTRY_LEAD_S before their first departure), ascending.
   */
  shapesAhead(until: number): number[] {
    const shapes = new Set<number>();
    for (const record of this.state.values()) {
      if (typeof record.shapeId === "number" && record.shapeId > 0) shapes.add(record.shapeId);
    }
    for (let i = this.queueAt; i < this.queue.length; i++) {
      const run = this.queue[i] as StaticRun;
      if ((run.departures[0] as number) - ENTRY_LEAD_S >= until) break;
      if (run.shape) shapes.add(run.shape.shapeNo);
    }
    return [...shapes].sort((a, b) => a - b);
  }

  /** Continues a published chain read back from storage (restart path). */
  async restore(chain: RestoredChain): Promise<void> {
    this.sequence = chain.sequence;
    this.keyframeSequence = chain.keyframeSequence;
    this.oldestSequence = chain.oldestSequence;
    this.activeVersion = chain.timetableVersion;
    for (const [key, record] of chain.trips) this.state.set(key, record);
    const instances = await this.options.keys.instancesOf([...chain.trips.keys()]);
    for (const [key, record] of chain.trips) {
      const id = instances.get(key);
      if (id) this.restored.set(id, { key, record });
    }
    this.restoredUnclaimed = new Set(chain.trips.keys());
    this.startNewChain = false;
    this.packsCheckAfterRestore = this.options.packsReady !== undefined;
  }

  async tick(now: number): Promise<TickReport> {
    this.now = now;
    let rows = 0;
    const changed = new Set<string>();
    for await (const chunk of this.options.reader.read(now)) {
      rows += chunk.rows.length;
      const touched = chunk.reload
        ? this.store.replace(chunk.reload.sourceId, chunk.reload.instanceIds, chunk.rows)
        : this.store.apply(chunk.rows);
      for (const id of touched) changed.add(id);
      if (chunk.seen) this.store.noteSeen(chunk.seen);
    }
    const switched = await this.ensureTimetable(now);
    await this.followVehicles(now);
    this.admit(now);
    const due = new Set<string>();
    for (const id of changed) if (this.tracked.has(id)) due.add(id);
    for (const { time, id } of this.wake.popDue(now)) {
      const tracked = this.tracked.get(id);
      if (tracked?.wakeAt === time) {
        tracked.wakeQueued = false;
        due.add(id);
      }
    }
    const ids = [...due].sort(compareIds);
    const needKeys: string[] = [];
    for (const id of ids) this.evaluate(id, now, needKeys);
    await this.assignKeys(needKeys);
    this.releaseUnclaimed();
    const emitted = await this.emit(now, switched);
    this.offerDetail(now);
    return { ...emitted, at: now, evaluated: ids.length, rows };
  }

  /** Resolves when every detail update handed out so far was published or failed. */
  async detailIdle(): Promise<void> {
    await this.dispatcher?.idle();
  }

  get detailStats() {
    return this.dispatcher?.stats ?? null;
  }

  private offerDetail(now: number): void {
    if (!this.dispatcher) return;
    for (const { time, id } of this.progressWake.popDue(now)) {
      const tracked = this.tracked.get(id);
      if (tracked && tracked.progressAt === time) {
        tracked.progressQueued = false;
        this.refreshProgress(tracked, now);
      }
    }
    this.dispatcher.offer({
      at: now,
      sequence: this.sequence,
      timetableVersion: this.activeVersion,
      changed: [...this.detailChanged.values()],
      removed: [...this.detailRemoved.values()],
    });
    this.detailChanged = new Map();
    this.detailRemoved = new Map();
  }

  /** Legend counts of the head (FORMAT.md 4.1) at `now`. */
  counts(now: number): HeadCount[] {
    const tally = new CountTally();
    for (const record of this.state.values()) {
      tally.add("running", record.category);
      if (record.realtime) tally.add("realtime", record.category);
    }
    for (const tracked of this.tracked.values()) {
      const counted =
        tracked.status === "untracked"
          ? now >= (tracked.run.departures[0] as number) && now <= this.endOf(tracked) - END_GRACE_S
          : tracked.status === "cancelled" && runsAt(tracked.run, now);
      if (counted) tally.add(tracked.status as "untracked" | "cancelled", tracked.run.category);
    }
    return tally.list();
  }

  private async ensureTimetable(now: number): Promise<boolean> {
    const today = localDate(now * 1000);
    const hour = berlinHour(now);
    const nightly = hour === 3 && this.versionCheckedOn !== today;
    const refresh =
      now - this.versionsReadAt >= VERSIONS_REFRESH_S || this.versionsReadOn !== today || nightly;
    if (refresh) {
      this.versions = await this.options.timetable.versions();
      await this.readPlaceCoordinates();
      this.versionsReadOn = today;
      this.versionsReadAt = now;
      this.decisionHeld = false;
    }
    const reason = this.dueReason(today, nightly, refresh);
    let switched = false;
    if (reason !== null) {
      if (nightly) this.versionCheckedOn = today;
      this.packsCheckAfterRestore = false;
      const target = await this.targetVersion(today, reason);
      this.decisionHeld = target === undefined || target === this.activeVersion;
      if (target !== undefined && target !== this.activeVersion) {
        if (this.activeVersion !== 0) {
          this.counters.versionSwitches++;
          switched = true;
          this.loadedDays.clear();
          this.queue = [];
          this.queueAt = 0;
        }
        this.activeVersion = target;
      }
    }
    await this.ensureDays(now);
    return switched;
  }

  /**
   * Why to decide on this tick. A decision that kept the active version is not redone before the
   * next read of the version list, which is also when missing packs are looked at again.
   */
  private dueReason(
    today: string,
    nightly: boolean,
    refresh: boolean,
  ): VersionDecision["reason"] | null {
    const due = this.decisionHeld
      ? null
      : decisionReason(
          this.versions,
          this.activeVersion,
          today,
          nightly,
          this.options.pinnedVersion,
        );
    const packsDue = refresh && (this.awaitingPacks !== undefined || this.packsCheckAfterRestore);
    return due ?? (packsDue ? "packs" : null);
  }

  /**
   * The newest version published by today whose shape coverage for today reaches the switch
   * coverage (0.95), or stays within SWITCH_COVERAGE_SLACK of a usable active version's but never
   * under SWITCH_COVERAGE_FLOOR (the shape gate passes about 93 % of patterns, so 0.95 alone would
   * never switch). A usable active version ends the search, so older versions are never
   * taken while it holds; an expired one gives way only to newer versions, and one that is no
   * longer loaded (rolled back) or draws nothing today (coverage 0) to any loaded version.
   */
  private async targetVersion(
    today: string,
    reason: VersionDecision["reason"],
  ): Promise<number | undefined> {
    const minimum = this.options.switchCoverage ?? 0.95;
    this.awaitingPacks = undefined;
    const pinned = this.pinnedTarget(today, reason);
    if (pinned !== undefined) return pinned;
    const candidates = currentCandidates(this.versions, today);
    const fitOf = this.fitsOn(today);
    const { reference, active, activeFit } = await this.decidingFrom(candidates, reason, fitOf);
    const usable = activeFit !== null && activeFit.coverage > 0;
    const activeCoverage = activeFit?.coverage ?? null;
    const { floor, runsFloor } = switchFloors(minimum, usable ? activeFit : null);
    const measured: MeasuredCandidate[] = [];
    const newerThan = reason === "expired" ? active : undefined;
    let chosen = await this.firstPassing(
      candidates,
      { floor, runsFloor, usable, newerThan, stopAt: active?.feedVersionId ?? 0, fitOf },
      measured,
    );
    if (chosen === undefined && !usable)
      chosen = await this.fallback(candidates, reason, newerThan);
    if (chosen === undefined) chosen = this.activeVersion || undefined;
    if (reason !== "packs" && measured.some((c) => c.feedVersionId !== chosen))
      this.counters.versionRefusals++;
    this.report({
      day: today,
      active: this.activeVersion,
      ...(reference === undefined ? {} : { reference }),
      activeCoverage,
      activeRuns: activeFit?.runs ?? null,
      reason,
      floor,
      runsFloor,
      candidates: measured,
      chosen,
    });
    return chosen;
  }

  /**
   * The version a decision is measured from: the active one, or at a cold start the reference
   * (`coldReference`), with its fit (none for an expired one, which must give way).
   */
  private async decidingFrom(
    candidates: readonly FeedVersionInfo[],
    reason: VersionDecision["reason"],
    fitOf: (feedVersionId: number) => Promise<VersionCoverage>,
  ): Promise<{
    readonly reference: number | undefined;
    readonly active: FeedVersionInfo | undefined;
    readonly activeFit: VersionCoverage | null;
  }> {
    const reference =
      this.activeVersion === 0 ? await this.coldReference(candidates, fitOf) : undefined;
    const from = reference ?? this.activeVersion;
    const active = this.versions.find((v) => v.feedVersionId === from);
    const activeFit =
      active !== undefined && reason !== "expired" ? await fitOf(active.feedVersionId) : null;
    return { reference, active, activeFit };
  }

  /** Each version's shape coverage on `today`, read at most once per decision. */
  private fitsOn(today: string): (feedVersionId: number) => Promise<VersionCoverage> {
    const fits = new Map<number, Promise<VersionCoverage>>();
    return (feedVersionId) => {
      let fit = fits.get(feedVersionId);
      if (fit === undefined) {
        fit = this.options.timetable.shapeCoverage(feedVersionId, today);
        fits.set(feedVersionId, fit);
      }
      return fit;
    };
  }

  /** Hands a decision to the log unless it repeats the last one (a decision redone every tick). */
  private report(decision: VersionDecision): void {
    const key = `${decision.day} ${decision.reason} ${decision.active} ${decision.chosen}`;
    if (key === this.lastDecision) return;
    this.lastDecision = key;
    this.options.onVersionDecision?.(decision);
  }

  /**
   * At a cold start, the current version with the highest shape coverage today (ties to the newer)
   * among those whose packs are published and whose runs today reach SWITCH_RUNS_FLOOR of the most
   * runs among them, so a restart decides as the running engine did at 03:00 and never
   * from a partial or thin feed the nightly runs floor would refuse. The most runs are
   * counted among versions at the coverage floor (all of them when none is), so a bigger feed with
   * few shapes cannot push out the version the running engine would keep; none when
   * every coverage is 0 or no version has packs.
   */
  private async coldReference(
    candidates: readonly FeedVersionInfo[],
    fitOf: (feedVersionId: number) => Promise<VersionCoverage>,
  ): Promise<number | undefined> {
    const eligible: { feedVersionId: number; coverage: number; runs: number }[] = [];
    for (const candidate of candidates) {
      const { coverage, runs } = await fitOf(candidate.feedVersionId);
      if (coverage <= 0) continue;
      if (this.options.packsReady && !(await this.options.packsReady(candidate.feedVersionId)))
        continue;
      eligible.push({ feedVersionId: candidate.feedVersionId, coverage, runs });
    }
    const coverageFloor = Math.min(SWITCH_COVERAGE_FLOOR, this.options.switchCoverage ?? 0.95);
    const covered = eligible.filter((e) => e.coverage >= coverageFloor);
    const sized = covered.length > 0 ? covered : eligible;
    const runsFloor = SWITCH_RUNS_FLOOR * Math.max(0, ...sized.map((e) => e.runs));
    let best: { feedVersionId: number; coverage: number } | undefined;
    for (const e of eligible) {
      if (e.runs < runsFloor || (best !== undefined && e.coverage <= best.coverage)) continue;
      best = e;
    }
    return best?.feedVersionId;
  }

  /** The pinned version when it is loaded (the operator's override wins over every floor). */
  private pinnedTarget(today: string, reason: VersionDecision["reason"]): number | undefined {
    const pinned = this.versions.find((v) => v.feedVersionId === this.options.pinnedVersion);
    if (pinned === undefined) return undefined;
    this.report({
      day: today,
      active: this.activeVersion,
      activeCoverage: null,
      activeRuns: null,
      reason: reason === "start" ? "start" : "pinned",
      floor: 0,
      runsFloor: null,
      candidates: [],
      chosen: pinned.feedVersionId,
    });
    return pinned.feedVersionId;
  }

  /**
   * Without a usable active version and no candidate at the floors: the newest version whose packs
   * are published (without a pack gate the newest). An expired active version looks only at versions
   * published after it and stays while none has them; a version gone or drawing nothing gives way to
   * the newest anyway.
   */
  private async fallback(
    candidates: readonly FeedVersionInfo[],
    reason: VersionDecision["reason"],
    newerThan: FeedVersionInfo | undefined,
  ): Promise<number | undefined> {
    const all = candidates.length > 0 ? candidates : [...this.versions].reverse();
    const list = newerThan === undefined ? all : all.filter((v) => publishedAfter(v, newerThan));
    const packsReady = this.options.packsReady;
    if (packsReady === undefined) return list[0]?.feedVersionId;
    for (const version of list) {
      if (await packsReady(version.feedVersionId)) return version.feedVersionId;
    }
    return reason === "expired" ? undefined : list[0]?.feedVersionId;
  }

  /** The candidate's fit, and whether it reaches both floors and has its packs (when gated). */
  private async measure(
    candidate: FeedVersionInfo,
    rule: {
      readonly floor: number;
      readonly runsFloor: number | null;
      readonly fitOf: (feedVersionId: number) => Promise<VersionCoverage>;
    },
  ): Promise<{ readonly entry: MeasuredCandidate; readonly passes: boolean }> {
    const fit = await rule.fitOf(candidate.feedVersionId);
    const entry = { feedVersionId: candidate.feedVersionId, ...fit };
    const atFloors =
      fit.coverage >= rule.floor && (rule.runsFloor === null || fit.runs >= rule.runsFloor);
    const packsReady = this.options.packsReady;
    if (!atFloors || packsReady === undefined) return { entry, passes: atFloors };
    const packs = await packsReady(candidate.feedVersionId);
    if (!packs) this.awaitingPacks ??= candidate.feedVersionId;
    return { entry: { ...entry, packs }, passes: packs };
  }

  /**
   * Walks the candidates newest first and stops at a usable active (or cold start reference)
   * version or one at both floors whose packs are published; one at both floors without packs is
   * remembered for the next read.
   */
  private async firstPassing(
    candidates: readonly FeedVersionInfo[],
    rule: {
      readonly floor: number;
      readonly runsFloor: number | null;
      readonly usable: boolean;
      readonly newerThan: FeedVersionInfo | undefined;
      readonly stopAt: number;
      readonly fitOf: (feedVersionId: number) => Promise<VersionCoverage>;
    },
    measured: MeasuredCandidate[],
  ): Promise<number | undefined> {
    for (const candidate of candidates) {
      if (candidate.feedVersionId === rule.stopAt)
        return rule.usable ? candidate.feedVersionId : undefined;
      if (rule.newerThan !== undefined && !publishedAfter(candidate, rule.newerThan))
        return undefined;
      const { entry, passes } = await this.measure(candidate, rule);
      measured.push(entry);
      if (passes) return candidate.feedVersionId;
    }
    return undefined;
  }

  /** Stop places come with feed versions, so their coordinates are read again when the list changes. */
  private async readPlaceCoordinates(): Promise<void> {
    const versions = this.versions.map((version) => version.feedVersionId).join(",");
    if (versions === this.coordinatesOf) return;
    this.sameStation = placesWithin(await this.options.timetable.placeCoordinates());
    this.coordinatesOf = versions;
  }

  private async ensureDays(now: number): Promise<void> {
    const today = localDate(now * 1000);
    const days = [addDays(today, -1), today];
    if (berlinHour(now) >= 20) days.push(addDays(today, 1));
    const fresh: StaticRun[] = [];
    for (const day of days) {
      if (this.loadedDays.has(day)) continue;
      this.loadedDays.add(day);
      for (const run of await this.options.timetable.runsOn(this.activeVersion, day)) {
        if (!this.tracked.has(run.instanceId) && !this.hasEnded(run)) fresh.push(run);
      }
    }
    this.forgetDaysBefore(addDays(today, -1));
    if (fresh.length === 0) return;
    const remaining = this.queue.slice(this.queueAt);
    this.queue = [...remaining, ...fresh].sort(
      (a, b) =>
        (a.departures[0] as number) - (b.departures[0] as number) ||
        compareIds(a.instanceId, b.instanceId),
    );
    this.queueAt = 0;
  }

  private hasEnded(run: StaticRun): boolean {
    return this.ended.get(run.serviceDate)?.has(run.instanceId) ?? false;
  }

  private forgetDaysBefore(day: string): void {
    for (const loaded of [...this.loadedDays]) if (loaded < day) this.loadedDays.delete(loaded);
    for (const endedDay of [...this.ended.keys()]) if (endedDay < day) this.ended.delete(endedDay);
    this.store.evictBefore(day);
  }

  private admit(now: number): void {
    while (this.queueAt < this.queue.length) {
      const run = this.queue[this.queueAt] as StaticRun;
      if ((run.departures[0] as number) - ENTRY_LEAD_S > now) break;
      this.queueAt++;
      if (this.tracked.has(run.instanceId)) continue;
      const last = run.arrivals[run.arrivals.length - 1] as number;
      if (now > last + END_GRACE_S && !this.stillLate(run.instanceId, now)) continue;
      this.tracked.set(run.instanceId, {
        run,
        held: null,
        published: null,
        motion: null,
        key: null,
        status: "waiting",
        wakeAt: now,
        wakeQueued: true,
        progress: "",
        passed: -1,
        progressAt: Number.POSITIVE_INFINITY,
        progressQueued: false,
        noted: null,
      });
      this.wake.push(now, run.instanceId);
    }
    this.trimQueue();
  }

  /** A train past its schedule is still running while a source predicts an arrival ahead of `now`. */
  private stillLate(instanceId: string, now: number): boolean {
    const end = this.store.predictedEnd(instanceId);
    return end !== null && now <= end + END_GRACE_S;
  }

  /** Drops admitted runs from the head of the queue (they live on in `tracked` or have ended). */
  private trimQueue(): void {
    if (this.queueAt < QUEUE_TRIM_AT || this.queueAt * 2 < this.queue.length) return;
    this.queue = this.queue.slice(this.queueAt);
    this.queueAt = 0;
  }

  private schedule(id: string, tracked: Tracked, at: number): void {
    if (at === tracked.wakeAt && tracked.wakeQueued) return;
    tracked.wakeAt = at;
    tracked.wakeQueued = Number.isFinite(at);
    if (tracked.wakeQueued) this.wake.push(at, id);
  }

  private endOf(tracked: Tracked): number {
    const run = tracked.run;
    let end = run.arrivals[run.arrivals.length - 1] as number;
    const source = tracked.held
      ? this.store.source(run.instanceId, tracked.held.sourceId)
      : undefined;
    for (const row of source?.stops.values() ?? []) {
      end = Math.max(end, row.predictedArrival ?? 0, row.predictedDeparture ?? 0);
    }
    return end + END_GRACE_S;
  }

  private drop(id: string, tracked: Tracked): void {
    if (tracked.key !== null && this.state.has(tracked.key)) {
      this.pendingRemovals.add(tracked.key);
      this.pendingChanges.delete(tracked.key);
    }
    this.tracked.delete(id);
    const day = tracked.run.serviceDate;
    const ended = this.ended.get(day) ?? new Set<string>();
    ended.add(id);
    this.ended.set(day, ended);
    if (this.dispatcher) {
      this.detailChanged.delete(id);
      this.detailRemoved.set(id, this.detailState(tracked, this.now));
    }
    this.store.forget(id);
  }

  private evaluate(id: string, now: number, needKeys: string[]): void {
    const tracked = this.tracked.get(id);
    if (!tracked) return;
    const sources = this.chooseSourceFor(tracked, now);
    if (tracked.run.gap) {
      this.keepUntracked(id, tracked, now);
      return;
    }
    this.claimRestored(tracked);
    const held = tracked.held;
    const outcome = buildPlan({
      run: tracked.run,
      source: held ? this.store.source(id, held.sourceId) : undefined,
      now,
      published: tracked.published,
      publishedMotion: tracked.motion,
      holdRule: this.holdRule,
      stats: this.counters.plan,
      sameStation: this.sameStation,
    });
    if (outcome.kind === "ended") this.drop(id, tracked);
    else if (outcome.kind === "cancelled") this.keepCancelled(id, tracked, now);
    else this.publishPlan(id, tracked, outcome.plan, now, needKeys, sources);
  }

  /** Applies the sticky source rule; returns how many sources reported the instance. */
  private chooseSourceFor(tracked: Tracked, now: number): number {
    const activity = this.store.activity(tracked.run.instanceId, now);
    const held = chooseSource(tracked.run.categoryCode, tracked.held, activity, now);
    if (held && tracked.held && held !== tracked.held) {
      if (now - tracked.held.since < SOURCE_SETTLE_S) this.counters.sourceSettles++;
      else this.counters.sourceSwitches++;
    }
    tracked.held = held;
    return activity.length;
  }

  private keepUntracked(id: string, tracked: Tracked, now: number): void {
    const end = this.endOf(tracked);
    if (now > end) {
      this.drop(id, tracked);
      return;
    }
    if (tracked.status !== "untracked") this.noteDetail(tracked, now);
    else this.noteIfMoved(tracked, now);
    tracked.status = "untracked";
    this.schedule(id, tracked, end + 1);
  }

  private keepCancelled(id: string, tracked: Tracked, now: number): void {
    if (tracked.key !== null) {
      if (this.state.has(tracked.key)) this.pendingRemovals.add(tracked.key);
      this.pendingChanges.delete(tracked.key);
    }
    tracked.published = null;
    tracked.motion = null;
    if (tracked.status !== "cancelled") this.noteDetail(tracked, now);
    else this.noteIfMoved(tracked, now);
    tracked.status = "cancelled";
    const end = this.endOf(tracked);
    if (now > end) this.drop(id, tracked);
    else this.schedule(id, tracked, Math.min(end + 1, now + MULTI_SOURCE_RECHECK_S));
  }

  private publishPlan(
    id: string,
    tracked: Tracked,
    plan: LivePlan,
    now: number,
    needKeys: string[],
    sources: number,
  ): void {
    if (tracked.status !== "drawn" || mustEmit(tracked.published, plan)) {
      tracked.published = plan;
      tracked.motion = motionOfPlan(plan, tracked.run);
      tracked.status = "drawn";
      if (tracked.key === null) needKeys.push(id);
      else this.stage(tracked);
      this.noteDetail(tracked, now);
    }
    let wakeAt = nextWake(tracked.published as LivePlan, now);
    if (sources > 1) wakeAt = Math.min(wakeAt, now + MULTI_SOURCE_RECHECK_S);
    this.schedule(id, tracked, wakeAt);
  }

  private claimRestored(tracked: Tracked): void {
    const restored = this.restored.get(tracked.run.instanceId);
    if (!restored || tracked.key !== null) return;
    this.restored.delete(tracked.run.instanceId);
    this.restoredUnclaimed.delete(restored.key);
    tracked.key = restored.key;
    const plan = livePlanFromRecord(restored.record, tracked.run);
    if (plan) {
      tracked.published = plan;
      tracked.motion = motionOfPlan(plan, tracked.run);
      tracked.status = "drawn";
    }
  }

  /** Restored trips no running instance claimed on the first tick leave the state. */
  private releaseUnclaimed(): void {
    if (this.restoredUnclaimed.size === 0) return;
    for (const key of this.restoredUnclaimed) this.pendingRemovals.add(key);
    this.restoredUnclaimed.clear();
    this.restored.clear();
  }

  private stage(tracked: Tracked): void {
    const key = tracked.key as number;
    this.pendingRemovals.delete(key);
    this.pendingChanges.set(
      key,
      tripRecordOf(key, tracked.run, tracked.published as LivePlan, this.vehicleOf(tracked)),
    );
  }

  /**
   * The vehicle a trip is sent with. Until the first read applies, a trip that clients already
   * hold with a vehicle (a restored chain) keeps it, so it does not flip to generic and back.
   */
  private vehicleOf(tracked: Tracked): RunVehicle | undefined {
    const vehicles = this.options.vehicles;
    if (!vehicles) return undefined;
    if (vehicles.empty && tracked.key !== null) {
      const sent = this.pendingChanges.get(tracked.key) ?? this.state.get(tracked.key);
      if (sent?.series != null) {
        return { series: sent.series, operator: sent.operator ?? null, units: sent.units ?? null };
      }
    }
    return vehicles.of(tracked.run);
  }

  /** Starts a vehicle read when one is due and puts a finished one in use. */
  private async followVehicles(now: number): Promise<void> {
    const vehicles = this.options.vehicles;
    if (!vehicles) return;
    const loading = vehicles.refresh(now, [...this.loadedDays]);
    if (loading && this.options.awaitVehicles) await loading;
    else if (loading && vehicles.empty && !this.firstVehicleWaitDone) {
      this.firstVehicleWaitDone = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.options.firstVehicleWaitMs ?? FIRST_VEHICLE_WAIT_MS);
      });
      await Promise.race([loading, limit]);
      clearTimeout(timer);
    }
    if (vehicles.apply()) this.restageVehicles(vehicles);
  }

  /** Sends again every drawn trip whose vehicle a new read changed. */
  private restageVehicles(vehicles: VehicleIdentities): void {
    for (const tracked of this.tracked.values()) {
      if (tracked.key === null || tracked.status !== "drawn" || !tracked.published) continue;
      const sent = this.pendingChanges.get(tracked.key) ?? this.state.get(tracked.key);
      const vehicle = vehicles.of(tracked.run);
      if (
        sent?.series !== vehicle.series ||
        sent.operator !== vehicle.operator ||
        sent.units !== vehicle.units
      ) {
        this.stage(tracked);
      }
    }
  }

  private async assignKeys(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    ids.sort(compareIds);
    const keys = await this.options.keys.keysFor(ids);
    for (const id of ids) {
      const tracked = this.tracked.get(id);
      if (!tracked) continue;
      tracked.key = keys.get(id) ?? null;
      if (tracked.key !== null) {
        this.stage(tracked);
        this.noteDetail(tracked, this.now);
      }
    }
  }

  private noteDetail(tracked: Tracked, now: number): void {
    if (!this.dispatcher) return;
    this.detailChanged.set(tracked.run.instanceId, this.detailState(tracked, now));
  }

  /** A realtime change of a train the engine does not draw: noted when delay or end moved 15 s. */
  private noteIfMoved(tracked: Tracked, now: number): void {
    if (!this.dispatcher || !tracked.noted) return;
    const { stops, delay } = this.detailStops(tracked, now);
    const endsAt = endsAtOf(stops, tracked.run);
    const before = tracked.noted;
    const delayMoved =
      (before.delay === null) !== (delay === null) ||
      Math.abs((delay ?? 0) - (before.delay ?? 0)) >= DETAIL_MOVE_S;
    if (delayMoved || Math.abs(endsAt - before.endsAt) >= DETAIL_MOVE_S)
      this.noteDetail(tracked, now);
  }

  /** A progress wake: notes the instance only when its last passed or next stop moved. */
  private refreshProgress(tracked: Tracked, now: number): void {
    const { stops } = this.detailStops(tracked, now);
    const progress = progressOf(stops, now, this.progressFloor(tracked));
    if (`${progress.lastPassedIndex}:${progress.nextIndex}` !== tracked.progress) {
      this.noteDetail(tracked, now);
    } else {
      this.scheduleProgress(tracked, progress.changesAt);
    }
  }

  /**
   * The lowest stop progress may report: the furthest reported so far (a forecast that moves a
   * reached stop later holds the train there), and the last station served before a drawn plan
   * that starts at a departed hold point (the plan no longer lists the stations before it).
   */
  private progressFloor(tracked: Tracked): number {
    let floor = tracked.passed;
    const stops = tracked.status === "drawn" ? tracked.published?.stops : undefined;
    if (stops && (stops[0]?.stopIndex ?? 0) < 0) {
      const station = stops.find((stop) => stop.stopIndex >= 0)?.stopIndex;
      const run = tracked.run;
      const held = tracked.held;
      const source = held ? this.store.source(run.instanceId, held.sourceId) : undefined;
      for (let j = (station ?? run.arrivals.length) - 1; j > floor; j--) {
        if (!run.passThrough[j] && !source?.stops.get(j)?.cancelled) {
          floor = j;
          break;
        }
      }
    }
    return floor;
  }

  private scheduleProgress(tracked: Tracked, at: number): void {
    if (at === tracked.progressAt && tracked.progressQueued) return;
    tracked.progressAt = at;
    tracked.progressQueued = Number.isFinite(at);
    if (tracked.progressQueued) this.progressWake.push(at, tracked.run.instanceId);
  }

  private detailStops(
    tracked: Tracked,
    now: number,
  ): { stops: readonly ProgressStop[]; delay: number | null } {
    if (tracked.status === "drawn" && tracked.published) {
      return { stops: tracked.published.stops, delay: tracked.published.delay };
    }
    const held = tracked.held;
    const source = held ? this.store.source(tracked.run.instanceId, held.sourceId) : undefined;
    return expectedTimes(tracked.run, source, now, this.sameStation);
  }

  private detailState(tracked: Tracked, now: number): LiveInstanceState {
    const run = tracked.run;
    const { stops, delay } = this.detailStops(tracked, now);
    const floor = this.progressFloor(tracked);
    const progress = progressOf(stops, now, floor);
    tracked.passed = Math.max(floor, progress.lastPassedIndex ?? -1);
    tracked.progress = `${progress.lastPassedIndex}:${progress.nextIndex}`;
    this.scheduleProgress(tracked, progress.changesAt);
    const endsAt = endsAtOf(stops, run);
    tracked.noted = { delay, endsAt };
    return {
      tripInstanceId: run.instanceId,
      key: tracked.status === "drawn" ? tracked.key : null,
      serviceDate: run.serviceDate,
      feedVersionId: run.feedVersionId,
      tripKey: run.tripKey,
      category: run.categoryCode,
      source: tracked.held,
      geometry: { available: run.gap === null, reason: run.gap },
      delaySeconds: delay,
      cancelled: tracked.status === "cancelled",
      lastPassedIndex: progress.lastPassedIndex,
      nextIndex: progress.nextIndex,
      endsAt,
      at: now,
    };
  }

  private async emit(
    now: number,
    switched: boolean,
  ): Promise<Omit<TickReport, "at" | "evaluated" | "rows">> {
    const changedTrips = this.pendingChanges.size;
    const removedTrips = this.pendingRemovals.size;
    const bytes = { delta: 0, keyframe: 0, head: 0 };
    let delta: number | null = null;
    let keyframe: number | null = null;
    if (this.startNewChain || switched) {
      bytes.keyframe = await this.startChain(now);
      keyframe = this.sequence;
    } else if (changedTrips + removedTrips > 0 && now - this.lastDeltaAt >= this.deltaInterval) {
      bytes.delta = await this.writeDelta(now);
      delta = this.sequence;
      if (now - this.lastKeyframeAt >= this.keyframeInterval) {
        const previous = this.keyframeSequence;
        bytes.keyframe = await this.writeKeyframe(now);
        keyframe = this.sequence;
        if (previous > 0) this.oldestSequence = Math.max(this.oldestSequence, previous + 1);
      }
    }
    bytes.head = await this.writeHead(now);
    const published = delta !== null || keyframe !== null;
    return {
      sequence: this.sequence,
      delta,
      keyframe,
      changedTrips: published ? changedTrips : 0,
      removedTrips: published ? removedTrips : 0,
      bytes,
    };
  }

  /** Keyframe k without delta k: a new chain, or a timetable switch (FORMAT.md section 3). */
  private async startChain(now: number): Promise<number> {
    const sequence = this.startNewChain ? this.options.firstSequence : this.sequence + 1;
    this.applyPending();
    const size = await this.writeKeyframe(now, sequence);
    this.oldestSequence = this.sequence + 1;
    this.lastDeltaAt = now;
    this.startNewChain = false;
    return size;
  }

  private async writeDelta(now: number): Promise<number> {
    const sequence = this.sequence + 1;
    const record: Delta = {
      kind: "delta",
      sequence,
      baseSequence: this.sequence,
      timetableVersion: this.activeVersion,
      shapeEpoch: this.options.shapeEpoch,
      timeBase: now,
      trips: [...this.pendingChanges.values()],
      removed: [...this.pendingRemovals].filter((key) => this.state.has(key)),
    };
    const encoded = encodeDelta(record);
    await this.options.sink.object("d", sequence, encoded);
    this.sequence = sequence;
    this.counters.emitted.deltas++;
    this.counters.emitted.trips += record.trips.length;
    this.applyPending();
    this.lastDeltaAt = now;
    return encoded.length;
  }

  private async writeHead(now: number): Promise<number> {
    let head: Head = {
      kind: "head",
      sequence: this.sequence,
      timetableVersion: this.activeVersion,
      timeBase: now,
      keyframeSequence: this.keyframeSequence,
      oldestSequence: this.oldestSequence,
      counts: this.counts(now),
    };
    const packSets = this.options.packSets?.();
    if (packSets) head = { ...head, packSets };
    const encoded = encodeHead(head);
    await this.options.sink.head(encoded, head);
    return encoded.length;
  }

  private applyPending(): void {
    for (const key of this.pendingRemovals) this.state.delete(key);
    for (const [key, record] of this.pendingChanges) this.state.set(key, record);
    this.pendingChanges.clear();
    this.pendingRemovals.clear();
  }

  private async writeKeyframe(now: number, sequence = this.sequence): Promise<number> {
    const frame: Keyframe = {
      kind: "keyframe",
      sequence,
      timetableVersion: this.activeVersion,
      shapeEpoch: this.options.shapeEpoch,
      timeBase: now,
      trips: [...this.state.values()],
    };
    const encoded = encodeKeyframe(frame);
    await this.options.sink.object("k", sequence, encoded);
    this.sequence = sequence;
    this.keyframeSequence = sequence;
    this.lastKeyframeAt = now;
    this.counters.emitted.keyframes++;
    return encoded.length;
  }
}

function stopIndexAtArc(arcs: ArrayLike<number>, s: number, from: number): number {
  for (let i = from; i < arcs.length; i++) {
    if (Math.abs((arcs[i] as number) - s) < 0.005) return i;
  }
  return -1;
}

/** A published frame trip read back as an engine plan (restart path); null when it does not fit. */
export function livePlanFromRecord(record: TripRecord, run: StaticRun): LivePlan | null {
  const arcs = run.shape?.stopArcs;
  if (!arcs) return null;
  const explicit = record.stops.some((stop) => stop.s !== null);
  let search = record.firstStop;
  const stops: PlanStopState[] = [];
  for (const [j, stop] of record.stops.entries()) {
    let stopIndex = record.firstStop + j;
    let s = arcs[stopIndex] as number;
    if (explicit) {
      s = stop.s as number;
      stopIndex = stopIndexAtArc(arcs, s, search);
      if (stopIndex >= 0) search = stopIndex + 1;
    } else if (stopIndex >= arcs.length) {
      return null;
    }
    const arrival = stop.arrival ?? stop.departure;
    const departure = stop.departure ?? stop.arrival;
    if (arrival === null || departure === null) return null;
    stops.push({
      stopIndex,
      s,
      arrival,
      departure,
      cancelled: stop.cancelled,
      realtime: stop.realtime,
    });
  }
  return { stops, realtime: record.realtime, delay: record.delay };
}
