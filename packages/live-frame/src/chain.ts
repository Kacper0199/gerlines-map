import type { FrameHeader } from "./container.ts";
import type { Head } from "./model.ts";

/** The frame a client has applied last: its sequence and timetable version. */
export interface FrameState {
  readonly sequence: number;
  readonly timetableVersion: number;
}

/**
 * What to fetch after reading a head: the keyframe to load (null to keep the current state), then
 * the deltas firstDelta to lastDelta in order (none when firstDelta > lastDelta).
 */
export interface CatchUp {
  readonly keyframe: number | null;
  readonly firstDelta: number;
  readonly lastDelta: number;
}

/**
 * The fetch plan of FORMAT.md section 4: deltas from the client's state while the head still
 * keeps them and the timetable is the same, else the head's keyframe and the deltas after it.
 */
export function catchUp(head: Head, state: FrameState | null): CatchUp {
  const keepsState =
    state !== null &&
    state.timetableVersion === head.timetableVersion &&
    state.sequence <= head.sequence &&
    head.oldestSequence <= state.sequence + 1;
  if (keepsState) {
    return { keyframe: null, firstDelta: state.sequence + 1, lastDelta: head.sequence };
  }
  return {
    keyframe: head.keyframeSequence,
    firstDelta: head.keyframeSequence + 1,
    lastDelta: head.sequence,
  };
}

/**
 * True when a decoded delta turns the client's state into the next one: its base is the state's
 * sequence and its timetable version the state's. A client drops any other frame and reads the
 * head again (FORMAT.md section 3).
 */
export function appliesTo(header: FrameHeader, state: FrameState): boolean {
  return (
    header.kind === "delta" &&
    header.baseSequence === state.sequence &&
    header.timetableVersion === state.timetableVersion
  );
}

/** The pack set a client holds last: its shape epoch and set id (FORMAT.md 4.2). */
export interface HeldPackSet {
  readonly epoch: number;
  readonly id: number;
}

/** What to fetch for pack sets: the parts of one base set, or increments `from` to `to`, or nothing. */
export type PackSetFetch =
  | { readonly base: number; readonly parts: number }
  | { readonly from: number; readonly to: number }
  | null;

/** A client this many sets behind loads the base set instead of the increments. */
export const MAX_PACK_SET_INCREMENTS = 6;

/**
 * The pack set plan of FORMAT.md 4.2: nothing without sets or when the client holds the latest,
 * the increments after the held set while the head keeps them (at most MAX_PACK_SET_INCREMENTS),
 * else the latest base set.
 */
export function packSetPlan(head: Head, held: HeldPackSet | null): PackSetFetch {
  const sets = head.packSets;
  if (!sets) return null;
  if (held && held.epoch === sets.epoch) {
    if (held.id === sets.latest) return null;
    const behind = sets.latest - held.id;
    if (held.id >= sets.first && behind > 0 && behind <= MAX_PACK_SET_INCREMENTS) {
      return { from: held.id + 1, to: sets.latest };
    }
  }
  return { base: sets.latest, parts: sets.parts };
}
