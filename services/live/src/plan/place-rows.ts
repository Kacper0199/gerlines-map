import { groundDistance, type LonLat, lonLatToMercator } from "@gerlines/geo";

/** The stops of a run: stop place and scheduled times (Unix seconds) per stop index. */
export interface RunStops {
  /** Undefined where the run has no stop at that index. */
  readonly places: readonly (string | undefined)[];
  readonly arrivals: ArrayLike<number | null>;
  readonly departures: ArrayLike<number | null>;
}

/** What a source row says about its stop: the place it names and its planned times (Unix s). */
export interface RowKey {
  readonly place: string | null;
  readonly arrival: number | null;
  readonly departure: number | null;
}

/** Source rows placed on the stops of a run, and what had to be moved or dropped to get there. */
export interface PlacedRows<R> {
  /** The row per stop index of the run (undefined where the source has none that fits). */
  readonly rows: (R | undefined)[];
  /** Rows placed on another index than their own, or on a stop of another place. */
  readonly realigned: number;
  /** Rows naming a place the run lacks, placed on the stop of the same planned time. */
  readonly renamed: number;
  /** Rows that fit no stop of the run. */
  readonly dropped: number;
}

/** Cost of a row that fits no stop; every other cost is below it, so most rows placed wins. */
const DROP = 1;
/**
 * Placing a row at another index shift than the row placed before it (start: shift 0). Below the
 * time cost of 60 s, so a visit of a repeated place 1 min off the planned time loses to a shift
 * (chosen with a fuzz of 20,000 trips against 0.15 and 0.05).
 */
const SHIFT = 0.1;
/** A row without a place (no stop event joined), placed only on the shift of the row before it. */
const NO_PLACE = 0.2;
/** A row naming a place the run lacks, at the same planned time (a station under a new id). */
const RENAMED = 0.6;
/** A row without a planned time; it never changes the shift (see placeRows). */
const UNTIMED = 0.1;
/** Planned time distance at which the time cost saturates; below it the time fits that stop. */
const FIT_S = 300;
/** The time cost at FIT_S and beyond. */
const TIME_WEIGHT = 0.5;
/** Planned times this close count as the same time. */
const SAME_TIME_S = 30;
/** A renamed station lies this close to the stop it is placed on (real pairs: 0 to 83 m). */
const RENAMED_WITHIN_M = 150;

const NONE = -1;

/** Whether a place a run lacks may stand for a stop place of the run (the same station). */
export type SameStation = (rowPlace: string, stopPlace: string) => boolean;

/**
 * Places within `metres` of each other by their coordinates; a place without coordinates is near
 * no other.
 */
export function placesWithin(
  coordinates: ReadonlyMap<string, LonLat>,
  metres = RENAMED_WITHIN_M,
): SameStation {
  return (rowPlace, stopPlace) => {
    const a = coordinates.get(rowPlace);
    const b = coordinates.get(stopPlace);
    if (!a || !b) return false;
    const p = lonLatToMercator(a.lon, a.lat);
    const q = lonLatToMercator(b.lon, b.lat);
    return groundDistance(p.x, p.y, q.x, q.y) <= metres;
  };
}

/** Planned time of a predicted time: the prediction less its delay, null without either. */
export function plannedTime(predicted: number | null, delay: number | null): number | null {
  return predicted === null || delay === null ? null : predicted - delay;
}

function distance(planned: number | null, scheduled: number | null | undefined): number | null {
  return planned === null || scheduled === null || scheduled === undefined
    ? null
    : Math.abs(planned - scheduled);
}

/** Planned time distance of a row to stop k: the larger of the sides both know, null for none. */
function timeDistance(key: RowKey, run: RunStops, k: number): number | null {
  const arrival = distance(key.arrival, run.arrivals[k]);
  const departure = distance(key.departure, run.departures[k]);
  if (arrival === null) return departure;
  return departure === null ? arrival : Math.max(arrival, departure);
}

/** Cost of a row on a stop of place `at`, infinite where it may not go. */
function matchCost(
  key: RowKey,
  inRun: boolean,
  at: string,
  d: number | null,
  sameStation: SameStation | undefined,
): number {
  const time = d === null ? UNTIMED : TIME_WEIGHT * Math.min(1, d / FIT_S);
  if (key.place === at) return time;
  if (key.place === null)
    return d === null || d < FIT_S ? NO_PLACE + time : Number.POSITIVE_INFINITY;
  const renamed =
    !inRun &&
    d !== null &&
    d <= SAME_TIME_S &&
    (sameStation === undefined || sameStation(key.place, at));
  return renamed ? RENAMED + time : Number.POSITIVE_INFINITY;
}

/**
 * Dynamic programming table of the alignment. A cell is row r on stop k; its value is the least
 * cost of rows 0..r with row r placed there, less (r + 1) drops, so dropped rows in between are
 * counted by subtracting values. Per row: the best earlier cell of each index shift (a move on the
 * same shift) and of each stop (prefix minimum, a move with a shift change).
 */
class Table {
  pred = new Int32Array(0);
  next = new Float64Array(0);
  sameCost = new Float64Array(0);
  sameFrom = new Int32Array(0);
  stopCost = new Float64Array(0);
  stopFrom = new Int32Array(0);
  n = 0;
  lowShift = 0;
  best = DROP;
  bestCell = NONE;
  sameStation: SameStation | undefined;

  reset(
    rows: number,
    stops: number,
    lowShift: number,
    shifts: number,
    sameStation: SameStation | undefined,
  ): void {
    this.sameStation = sameStation;
    if (this.pred.length < rows * stops) this.pred = new Int32Array(rows * stops);
    if (this.next.length < stops) {
      this.next = new Float64Array(stops);
      this.stopCost = new Float64Array(stops);
      this.stopFrom = new Int32Array(stops);
    }
    if (this.sameCost.length < shifts) {
      this.sameCost = new Float64Array(shifts);
      this.sameFrom = new Int32Array(shifts);
    }
    this.sameCost.fill(Number.POSITIVE_INFINITY, 0, shifts);
    this.sameFrom.fill(NONE, 0, shifts);
    this.stopCost.fill(Number.POSITIVE_INFINITY, 0, stops);
    this.n = stops;
    this.lowShift = lowShift;
    this.sameCost[-lowShift] = DROP;
    this.best = DROP;
    this.bestCell = NONE;
  }

  /** Values of row r (source index i) on every stop, from the rows before it. */
  step(r: number, i: number, key: RowKey, run: RunStops): void {
    const inRun = key.place !== null && run.places.includes(key.place);
    let prefix = DROP;
    let prefixFrom = NONE;
    for (let k = 0; k < this.n; k++) {
      this.next[k] = Number.POSITIVE_INFINITY;
      const at = run.places[k];
      if (at !== undefined) this.enter(r, i, k, key, inRun, at, run, prefix, prefixFrom);
      const stop = this.stopCost[k] as number;
      if (stop < prefix) {
        prefix = stop;
        prefixFrom = this.stopFrom[k] as number;
      }
    }
  }

  private enter(
    r: number,
    i: number,
    k: number,
    key: RowKey,
    inRun: boolean,
    at: string,
    run: RunStops,
    prefix: number,
    prefixFrom: number,
  ): void {
    const d = timeDistance(key, run, k);
    const cost = matchCost(key, inRun, at, d, this.sameStation);
    if (cost === Number.POSITIVE_INFINITY) return;
    const s = k - i - this.lowShift;
    let reach = this.sameCost[s] as number;
    let from = this.sameFrom[s] as number;
    const shiftFree = key.place !== null && d !== null && d < FIT_S;
    if (shiftFree && prefix + SHIFT < reach) {
      reach = prefix + SHIFT;
      from = prefixFrom;
    }
    if (reach === Number.POSITIVE_INFINITY) return;
    this.next[k] = reach + cost - DROP;
    this.pred[r * this.n + k] = from;
  }

  /** Makes row r's values available to the rows after it. */
  commit(r: number, i: number): void {
    for (let k = 0; k < this.n; k++) {
      const v = this.next[k] as number;
      if (v === Number.POSITIVE_INFINITY) continue;
      const cell = r * this.n + k;
      const s = k - i - this.lowShift;
      if (v < (this.sameCost[s] as number)) {
        this.sameCost[s] = v;
        this.sameFrom[s] = cell;
      }
      if (v < (this.stopCost[k] as number)) {
        this.stopCost[k] = v;
        this.stopFrom[k] = cell;
      }
      if (v < this.best) {
        this.best = v;
        this.bestCell = cell;
      }
    }
  }
}

const table = new Table();

/**
 * Whether every row sits on its own index with its own place (or none) and its exact planned
 * time (or none). Each row then costs there the least it can cost anywhere, with no shift change
 * and no drop, so that alignment is the only one of least cost and the table is not needed.
 */
function onOwnIndex(run: RunStops, indices: readonly number[], keys: readonly RowKey[]): boolean {
  for (let r = 0; r < keys.length; r++) {
    const i = indices[r] as number;
    const key = keys[r] as RowKey;
    const at = run.places[i];
    if (at === undefined || (key.place !== null && key.place !== at)) return false;
    const d = timeDistance(key, run, i);
    if (d !== null && d !== 0) return false;
  }
  return true;
}

/**
 * Places a source's rows (keyed by the stop index of the timetable version they were folded on,
 * one row per index) on the stops of a run, as one monotone alignment: rows keep their
 * order on strictly increasing stops, and the alignment of least total cost wins. Costs: a row on
 * a stop of its own place costs its planned time distance there (0 to 0.5, saturating at 5 min,
 * 0.1 without a planned time); a row without a place 0.2 more, only on the shift of the row
 * before it and under 5 min off or untimed; a row naming a place the run lacks 0.6
 * more, only on the same planned time (within 30 s: a station under a new id) and, given
 * `sameStation`, where it calls the two places one station; a change of the index shift against
 * the row placed before it 0.1, only where the row names a place and its planned time fits that
 * stop (under 5 min); a dropped row 1, more than any placement. A row naming another place of the
 * run never goes on a stop of a different place. Rows of the run's own version stay on their
 * index (shift 0 costs nothing); rows of another version follow their places and planned times
 * through inserted, removed and repeated stops. Time and memory are O(rows x stops), O(rows)
 * when every row fits its own index exactly.
 *
 * Untimed rows never change the shift: they stay on shift 0 or on the shift a timed row
 * before them set. A source of another version with no timed row before a repeated place therefore
 * puts its untimed rows there on the visit of their own index, which may be another visit (rows
 * A B A B of a version without the run's first two stops X Y land on the run's first A B). Kept
 * rather than dropped: untimed rows carry only a cancellation, and a cancelled trip of the run's
 * own version, the common source of rows without times, is right on shift 0 and would lose the
 * cancellation of every repeated stop if they were dropped.
 */
export function placeRows<R>(
  run: RunStops,
  source: Iterable<readonly [number, R]>,
  keyOf: (row: R) => RowKey,
  sameStation?: SameStation,
): PlacedRows<R> {
  const n = run.places.length;
  const entries = [...source].sort((a, b) => a[0] - b[0]);
  const m = entries.length;
  const rows = new Array<R | undefined>(n);
  if (m === 0 || n === 0) return { rows, realigned: 0, renamed: 0, dropped: m };
  const keys = entries.map(([, row]) => keyOf(row));
  const indices = entries.map(([i]) => i);
  if (onOwnIndex(run, indices, keys)) {
    for (const [i, row] of entries) rows[i] = row;
    return { rows, realigned: 0, renamed: 0, dropped: 0 };
  }
  const lowShift = Math.min(0, -(entries[m - 1] as readonly [number, R])[0]);
  const highShift = Math.max(0, n - 1 - Math.min(0, (entries[0] as readonly [number, R])[0]));
  table.reset(m, n, lowShift, highShift - lowShift + 1, sameStation);
  for (let r = 0; r < m; r++) {
    const i = (entries[r] as readonly [number, R])[0];
    table.step(r, i, keys[r] as RowKey, run);
    table.commit(r, i);
  }
  let realigned = 0;
  let renamed = 0;
  let placed = 0;
  for (let cell = table.bestCell; cell !== NONE; cell = table.pred[cell] as number) {
    const r = Math.floor(cell / n);
    const k = cell - r * n;
    const [i, row] = entries[r] as readonly [number, R];
    const place = (keys[r] as RowKey).place;
    const other = place !== null && place !== run.places[k];
    rows[k] = row;
    placed++;
    if (other) renamed++;
    if (other || k !== i) realigned++;
  }
  return { rows, realigned, renamed, dropped: m - placed };
}
