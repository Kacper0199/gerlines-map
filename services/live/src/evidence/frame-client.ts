import {
  appliesTo,
  catchUp,
  decodeDelta,
  decodeKeyframe,
  frameToObject,
  type Head,
  peekHeader,
  type TripRecord,
} from "@gerlines/live-frame";

export type ObjectReader = (relative: string) => Promise<Uint8Array | null>;

/** What following one head changed in the client's state. */
export interface FollowResult {
  readonly reloaded: boolean;
  readonly changed: readonly TripRecord[];
  readonly removed: readonly number[];
  readonly fetched: readonly string[];
}

export class ChainError extends Error {}

interface Changes {
  readonly changed: Map<number, TripRecord>;
  readonly removed: Set<number>;
  readonly fetched: string[];
}

/**
 * A client of FORMAT.md section 4 as WP-3.3's worker will be: reads a head, fetches what
 * `catchUp` names, drops frames that do not apply, and keeps the state by key.
 */
export class FrameClient {
  readonly state = new Map<number, TripRecord>();
  sequence: number | null = null;
  timetableVersion: number | null = null;
  private readonly read: ObjectReader;

  constructor(read: ObjectReader) {
    this.read = read;
  }

  async follow(head: Head): Promise<FollowResult> {
    const plan = catchUp(
      head,
      this.sequence === null || this.timetableVersion === null
        ? null
        : { sequence: this.sequence, timetableVersion: this.timetableVersion },
    );
    const changes: Changes = { changed: new Map(), removed: new Set(), fetched: [] };
    if (plan.keyframe !== null) await this.loadKeyframe(plan.keyframe, head, changes);
    for (let sequence = plan.firstDelta; sequence <= plan.lastDelta; sequence++) {
      await this.applyDelta(sequence, changes);
    }
    return {
      reloaded: plan.keyframe !== null,
      changed: [...changes.changed.values()],
      removed: [...changes.removed],
      fetched: changes.fetched,
    };
  }

  private async fetch(path: string, changes: Changes): Promise<Uint8Array> {
    const bytes = await this.read(path);
    if (!bytes) throw new ChainError(`${path} missing`);
    changes.fetched.push(path);
    return bytes;
  }

  private async loadKeyframe(sequence: number, head: Head, changes: Changes): Promise<void> {
    const frame = frameToObject(decodeKeyframe(await this.fetch(`k/${sequence}.bin`, changes)));
    if (frame.timetableVersion !== head.timetableVersion) {
      throw new ChainError(`keyframe ${sequence} has another timetable than its head`);
    }
    const next = new Map(frame.trips.map((trip) => [trip.key, trip]));
    for (const key of this.state.keys()) if (!next.has(key)) changes.removed.add(key);
    for (const trip of frame.trips) changes.changed.set(trip.key, trip);
    this.state.clear();
    for (const [key, trip] of next) this.state.set(key, trip);
    this.sequence = sequence;
    this.timetableVersion = frame.timetableVersion;
  }

  private async applyDelta(sequence: number, changes: Changes): Promise<void> {
    const path = `d/${sequence}.bin`;
    const bytes = await this.fetch(path, changes);
    const state = { sequence: this.sequence ?? -1, timetableVersion: this.timetableVersion ?? -1 };
    if (!appliesTo(peekHeader(bytes), state)) {
      throw new ChainError(`${path} does not apply to ${state.sequence}`);
    }
    const delta = frameToObject(decodeDelta(bytes));
    if (delta.kind !== "delta") throw new ChainError(`${path} is not a delta`);
    for (const key of delta.removed) {
      this.state.delete(key);
      changes.changed.delete(key);
      changes.removed.add(key);
    }
    for (const trip of delta.trips) {
      this.state.set(trip.key, trip);
      changes.changed.set(trip.key, trip);
      changes.removed.delete(trip.key);
    }
    this.sequence = sequence;
  }
}

/** True when two states hold the same trips (plain object comparison per key). */
export function sameState(
  a: ReadonlyMap<number, TripRecord>,
  b: ReadonlyMap<number, TripRecord>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, trip] of a) {
    const other = b.get(key);
    if (!other || JSON.stringify(other) !== JSON.stringify(trip)) return false;
  }
  return true;
}
