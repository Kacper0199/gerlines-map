import {
  appliesTo,
  catchUp,
  decodeDelta,
  decodeKeyframe,
  FrameDecodeError,
  frameToObject,
  type Head,
  peekHeader,
  type TripRecord,
} from "@gerlines/live-frame";

/** Reads one published object by its path under the live base (`k/10.bin`), null when missing. */
export type ObjectReader = (path: string) => Promise<Uint8Array | null>;

export interface ChainChanges {
  /** Publication time (Unix seconds) of the newest frame applied: from when its plans hold. */
  readonly time: number;
  /** The shape epoch of that frame (0: shapes are named by hash prefix). */
  readonly shapeEpoch: number;
  readonly reloaded: boolean;
  /** After a reload, the keys of every trip the state holds (trips not in it are gone); else null. */
  readonly keys: ReadonlySet<number> | null;
  readonly changed: readonly TripRecord[];
  readonly removed: readonly number[];
}

export class ChainError extends Error {}

/**
 * The client of FORMAT.md section 4: reads what `catchUp` names for a head, drops frames that do
 * not apply, keeps the trips by key and reports what changed since the previous call. A failed
 * follow leaves no half-applied state: the next one starts again from the head's keyframe.
 */
export class ChainFollower {
  readonly state = new Map<number, TripRecord>();
  sequence: number | null = null;
  timetableVersion: number | null = null;
  /** The shape epoch of the newest frame applied (0: shapes are named by hash prefix). */
  shapeEpoch = 0;
  /** The publication time of the newest frame applied. */
  timeBase = 0;
  private readonly read: ObjectReader;

  constructor(read: ObjectReader) {
    this.read = read;
  }

  reset(): void {
    this.state.clear();
    this.sequence = null;
    this.timetableVersion = null;
    this.shapeEpoch = 0;
    this.timeBase = 0;
  }

  /**
   * What following the head changed, one step per frame (the keyframe, then each delta) so a
   * caller can apply each at its own publication time. A broken frame (missing, undecodable, not
   * applying) drops the state and the next call starts again from the keyframe. A network failure
   * keeps it: the frames already read are returned (the state is consistent after each one), or the
   * error is thrown when there are none, and the next call goes on from the last frame.
   */
  async followSteps(head: Head): Promise<ChainChanges[]> {
    const plan = catchUp(
      head,
      this.sequence === null || this.timetableVersion === null
        ? null
        : { sequence: this.sequence, timetableVersion: this.timetableVersion },
    );
    const steps: ChainChanges[] = [];
    try {
      if (plan.keyframe !== null) steps.push(await this.loadKeyframe(plan.keyframe, head));
      for (let sequence = plan.firstDelta; sequence <= plan.lastDelta; sequence++) {
        steps.push(await this.applyDelta(sequence));
      }
    } catch (error) {
      if (error instanceof ChainError || error instanceof FrameDecodeError) {
        this.reset();
        if (error instanceof ChainError) throw error;
        throw new ChainError(`unreadable frame: ${error.code}`);
      }
      if (steps.length > 0) return steps;
      throw error;
    }
    return steps;
  }

  /** The steps of `followSteps` as one change set (a reload when any step was one). */
  async follow(head: Head): Promise<ChainChanges> {
    return mergeSteps(await this.followSteps(head), this);
  }

  private async fetch(path: string): Promise<Uint8Array> {
    const bytes = await this.read(path);
    if (!bytes) throw new ChainError(`${path} is missing`);
    return bytes;
  }

  private async loadKeyframe(sequence: number, head: Head): Promise<ChainChanges> {
    const frame = frameToObject(decodeKeyframe(await this.fetch(`k/${sequence}.bin`)));
    if (frame.timetableVersion !== head.timetableVersion) {
      throw new ChainError(`keyframe ${sequence} has another timetable than its head`);
    }
    const next = new Map(frame.trips.map((trip) => [trip.key, trip]));
    const removed = [...this.state.keys()].filter((key) => !next.has(key));
    this.state.clear();
    for (const [key, trip] of next) this.state.set(key, trip);
    this.sequence = sequence;
    this.timetableVersion = frame.timetableVersion;
    this.shapeEpoch = frame.shapeEpoch;
    this.timeBase = frame.timeBase;
    return {
      time: frame.timeBase,
      shapeEpoch: frame.shapeEpoch,
      reloaded: true,
      keys: new Set(next.keys()),
      changed: [...next.values()],
      removed,
    };
  }

  private async applyDelta(sequence: number): Promise<ChainChanges> {
    const bytes = await this.fetch(`d/${sequence}.bin`);
    const state = { sequence: this.sequence ?? -1, timetableVersion: this.timetableVersion ?? -1 };
    if (!appliesTo(peekHeader(bytes), state)) {
      throw new ChainError(`d/${sequence}.bin does not apply to ${state.sequence}`);
    }
    const frame = frameToObject(decodeDelta(bytes));
    if (frame.kind !== "delta") throw new ChainError(`d/${sequence}.bin is not a delta`);
    for (const key of frame.removed) this.state.delete(key);
    for (const trip of frame.trips) this.state.set(trip.key, trip);
    this.sequence = sequence;
    this.shapeEpoch = frame.shapeEpoch;
    this.timeBase = frame.timeBase;
    return {
      time: frame.timeBase,
      shapeEpoch: frame.shapeEpoch,
      reloaded: false,
      keys: null,
      changed: frame.trips,
      removed: frame.removed,
    };
  }
}

function mergeSteps(steps: readonly ChainChanges[], follower: ChainFollower): ChainChanges {
  const last = steps.at(-1);
  if (!last) {
    return {
      time: follower.timeBase,
      shapeEpoch: follower.shapeEpoch,
      reloaded: false,
      keys: null,
      changed: [],
      removed: [],
    };
  }
  const changed = new Map<number, TripRecord>();
  const removed = new Set<number>();
  let reloaded = false;
  for (const step of steps) {
    if (step.reloaded) {
      reloaded = true;
      changed.clear();
      removed.clear();
    }
    for (const key of step.removed) {
      changed.delete(key);
      removed.add(key);
    }
    for (const trip of step.changed) {
      changed.set(trip.key, trip);
      removed.delete(trip.key);
    }
  }
  return {
    time: last.time,
    shapeEpoch: last.shapeEpoch,
    reloaded,
    keys: reloaded ? new Set(follower.state.keys()) : null,
    changed: [...changed.values()],
    removed: [...removed],
  };
}
