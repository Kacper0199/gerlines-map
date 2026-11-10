import { MAJORITY_WINDOW_DAYS, TrainCategory } from "@gerlines/schema";
import { addDays } from "@gerlines/schema/service-day";
import {
  exactOf,
  type FleetRuleRow,
  majorityOf,
  type ObservedFormation,
  resolveIdentity,
  type SeriesFacts,
  type TrainKey,
  trainKeyOf,
} from "@gerlines/schema/vehicle-resolver";
import type { StaticRun } from "../model.ts";

/** What ingest recorded for a trip instance where it differs from the timetable trip. */
export interface InstanceFields {
  readonly operatorId: string | null;
  readonly trainNumber: string | null;
}

/** What the resolver reads: the fleet rules, the catalogue series and a window of exact formations. */
export interface FleetCatalogue {
  readonly rules: readonly FleetRuleRow[];
  readonly series: ReadonlyMap<string, SeriesFacts>;
  readonly observations: readonly ObservedFormation[];
  /** Instances of the service days whose operator or train number differ from their trip's. */
  readonly instances: ReadonlyMap<string, InstanceFields>;
  /** Catalogue operators with a name the train card can show. */
  readonly namedOperators: ReadonlySet<string>;
}

/** The days a read covers: observations `from` to `to` (both included) and the service days. */
export interface FleetWindow {
  readonly from: string;
  readonly to: string;
  readonly days: readonly string[];
}

/** Where the catalogue comes from: the database, or a fake in tests. */
export interface FleetSource {
  load(window: FleetWindow): Promise<FleetCatalogue>;
}

export class VehicleReadTimeout extends Error {
  constructor(ms: number) {
    super(`vehicle read gave no answer within ${ms} ms`);
    this.name = "VehicleReadTimeout";
  }
}

/** The vehicle a frame carries for a trip (FORMAT 1.3), each part null when unknown. */
export interface RunVehicle {
  readonly series: string | null;
  readonly operator: string | null;
  readonly units: number | null;
}

/** How often the rules and the exact formations are read again while the engine runs. */
export const VEHICLE_REFRESH_S = 600;

/** A read that has not answered by then counts as failed, so the next one can start. */
export const VEHICLE_READ_TIMEOUT_MS = 60_000;

export interface VehicleIdentitiesOptions {
  readonly refreshS?: number;
  readonly readTimeoutMs?: number;
  readonly onError?: (error: unknown) => void;
}

/** The observation days layers L0 and L1 need for these service days. */
export function observationWindow(days: readonly string[]): { from: string; to: string } {
  const sorted = [...days].sort();
  const first = sorted[0] as string;
  const last = sorted.at(-1) as string;
  return { from: addDays(first, -MAJORITY_WINDOW_DAYS), to: last };
}

interface Snapshot {
  readonly catalogue: FleetCatalogue;
  readonly byNumber: ReadonlyMap<string, readonly ObservedFormation[]>;
}

function snapshotOf(catalogue: FleetCatalogue): Snapshot {
  const byNumber = new Map<string, ObservedFormation[]>();
  for (const row of catalogue.observations) {
    const rows = byNumber.get(row.trainNumber);
    if (rows) rows.push(row);
    else byNumber.set(row.trainNumber, [row]);
  }
  return { catalogue, byNumber };
}

function categoryOf(code: string): TrainCategory {
  const parsed = TrainCategory.safeParse(code);
  return parsed.success ? parsed.data : "other";
}

/** The resolver key of a run, built as the train card builds it (instance first, then the trip). */
export function runKeyOf(
  run: StaticRun,
  catalogue: Pick<FleetCatalogue, "instances" | "namedOperators">,
): TrainKey {
  const instance = catalogue.instances.get(run.instanceId);
  return trainKeyOf(
    {
      serviceDate: run.serviceDate,
      category: categoryOf(run.categoryCode),
      line: run.line,
      instanceOperatorId: instance?.operatorId ?? null,
      tripOperatorId: run.operatorId,
      instanceTrainNumber: instance?.trainNumber ?? null,
      tripShortName: run.shortName,
    },
    (operatorId) => catalogue.namedOperators.has(operatorId),
  );
}

/**
 * The vehicle identity of each trip as the engine plans it (ADR-0011, the API's resolver): rules,
 * series and exact formations are read in the background, at the first service days and again
 * every refresh interval or when a new service day appears; a tick never waits for them. A read
 * applies only through `apply`, so the engine sees the change and re-sends the trips it moves.
 * Until the first read applies, a trip has only its timetable operator. A read that does not
 * answer within the read timeout counts as failed; its late answer is dropped.
 */
export class VehicleIdentities {
  private readonly source: FleetSource;
  private readonly refreshS: number;
  private readonly readTimeoutMs: number;
  private readonly onError: (error: unknown) => void;
  private current: Snapshot | null = null;
  private pending: Snapshot | null = null;
  private loading: Promise<void> | null = null;
  private loadedAt = Number.NEGATIVE_INFINITY;
  private loadedDays = "";
  private generationCount = 0;
  private cache = new WeakMap<StaticRun, RunVehicle>();

  constructor(source: FleetSource, options: VehicleIdentitiesOptions = {}) {
    this.source = source;
    this.refreshS = options.refreshS ?? VEHICLE_REFRESH_S;
    this.readTimeoutMs = options.readTimeoutMs ?? VEHICLE_READ_TIMEOUT_MS;
    this.onError = options.onError ?? (() => {});
  }

  /** Catalogues applied so far. */
  get generation(): number {
    return this.generationCount;
  }

  /** True until a read has applied. */
  get empty(): boolean {
    return this.current === null;
  }

  /**
   * Starts a read when one is due and none runs; returns it, so a render or a test can wait for
   * it, or undefined when nothing started. It settles within the read timeout. A failed read
   * keeps the catalogue in use.
   */
  refresh(now: number, days: readonly string[]): Promise<void> | undefined {
    if (this.loading || days.length === 0) return undefined;
    const key = [...days].sort().join(",");
    if (key === this.loadedDays && now - this.loadedAt < this.refreshS) return undefined;
    this.loadedAt = now;
    this.loadedDays = key;
    const window = { ...observationWindow(days), days: [...days].sort() };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new VehicleReadTimeout(this.readTimeoutMs)),
        this.readTimeoutMs,
      );
    });
    this.loading = Promise.race([this.source.load(window), deadline])
      .then(
        (catalogue) => {
          this.pending = snapshotOf(catalogue);
        },
        (error: unknown) => {
          this.cache = new WeakMap();
          this.onError(error);
        },
      )
      .finally(() => {
        clearTimeout(timer);
        this.loading = null;
      });
    return this.loading;
  }

  /** Puts a finished read in use; true when it did, and then every trip is resolved again. */
  apply(): boolean {
    if (!this.pending) return false;
    this.current = this.pending;
    this.pending = null;
    this.cache = new WeakMap();
    this.generationCount++;
    return true;
  }

  /** The vehicle of a run, resolved once per run object and catalogue (a new timetable is new runs). */
  of(run: StaticRun): RunVehicle {
    const cached = this.cache.get(run);
    if (cached) return cached;
    const vehicle = this.resolve(run);
    this.cache.set(run, vehicle);
    return vehicle;
  }

  private resolve(run: StaticRun): RunVehicle {
    const snapshot = this.current;
    if (!snapshot) return { series: null, operator: run.operatorId, units: null };
    const key = runKeyOf(run, snapshot.catalogue);
    const { operatorId: operator, trainNumber } = key;
    const query = {
      serviceDate: run.serviceDate,
      trainNumber: trainNumber ?? "",
      operatorId: operator,
    };
    const rows = trainNumber === null ? [] : (snapshot.byNumber.get(trainNumber) ?? []);
    const identity = resolveIdentity(key, {
      rules: snapshot.catalogue.rules,
      series: snapshot.catalogue.series,
      exact: exactOf(rows, query),
      majority: majorityOf(rows, query),
    });
    if (!identity || identity.layer === "L4") return { series: null, operator, units: null };
    return { series: identity.seriesId, operator, units: identity.units };
  }
}
