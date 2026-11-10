import {
  decodeDelta,
  decodeHead,
  decodeKeyframe,
  FrameDecodeError,
  frameToObject,
  type Head,
  type TripRecord,
} from "@gerlines/live-frame";
import type { RestoredChain } from "../engine/engine.ts";
import type { FileStore } from "./storage.ts";

export type RestoreResult =
  | { readonly kind: "chain"; readonly chain: RestoredChain }
  | { readonly kind: "none"; readonly reason: string; readonly floor: number };

async function applyDeltas(
  store: FileStore,
  head: Head,
  trips: Map<number, TripRecord>,
): Promise<string | null> {
  for (let sequence = head.keyframeSequence + 1; sequence <= head.sequence; sequence++) {
    const bytes = await store.read(`d/${sequence}.bin`);
    if (!bytes) return `delta ${sequence} missing`;
    const delta = frameToObject(decodeDelta(bytes));
    if (delta.kind !== "delta" || delta.timetableVersion !== head.timetableVersion) {
      return `delta ${sequence} does not apply`;
    }
    for (const key of delta.removed) trips.delete(key);
    for (const trip of delta.trips) trips.set(trip.key, trip);
  }
  return null;
}

/**
 * Reads the published chain back (restart path, FORMAT.md section 3): the head, its keyframe and
 * the deltas after it, applied in order. When anything is missing or damaged, or an object above the
 * head exists (a crash between object and head), the engine starts a new chain above every sequence
 * on disk (`floor`). A keyframe of another shape epoch than the packs now served also starts a new
 * chain, so a client never mixes trips of two epochs.
 */
export async function restoreChain(store: FileStore, shapeEpoch: number): Promise<RestoreResult> {
  const highest = await store.highestSequence();
  const headBytes = await store.read("head");
  if (!headBytes) return { kind: "none", reason: "no head", floor: highest };
  let floor = highest;
  try {
    const head = decodeHead(headBytes);
    floor = Math.max(head.sequence, highest);
    if (highest > head.sequence) {
      return { kind: "none", reason: `objects above the head up to ${highest}`, floor };
    }
    const keyframeBytes = await store.read(`k/${head.keyframeSequence}.bin`);
    if (!keyframeBytes) return { kind: "none", reason: "keyframe missing", floor };
    const keyframe = frameToObject(decodeKeyframe(keyframeBytes));
    if (keyframe.timetableVersion !== head.timetableVersion) {
      return { kind: "none", reason: "keyframe of another timetable", floor };
    }
    if (keyframe.shapeEpoch !== shapeEpoch) {
      const reason = `keyframe of shape epoch ${keyframe.shapeEpoch}, packs at ${shapeEpoch}`;
      return { kind: "none", reason, floor };
    }
    const trips = new Map<number, TripRecord>(keyframe.trips.map((trip) => [trip.key, trip]));
    const failure = await applyDeltas(store, head, trips);
    if (failure) return { kind: "none", reason: failure, floor };
    return {
      kind: "chain",
      chain: {
        sequence: head.sequence,
        keyframeSequence: head.keyframeSequence,
        oldestSequence: head.oldestSequence,
        timetableVersion: head.timetableVersion,
        trips,
      },
    };
  } catch (error) {
    if (error instanceof FrameDecodeError) {
      return { kind: "none", reason: `damaged: ${error.code}`, floor };
    }
    throw error;
  }
}

/** Unix seconds of 2026-01-01T00:00:00Z: sequences and keys of a new chain start above now minus this. */
export const SEQUENCE_EPOCH = 1_767_225_600;

/**
 * The first sequence of a chain that cannot continue the published one: above the head it found and
 * above the clock floor, which only grows faster than deltas (at most one per 2 s) can.
 */
export function newChainStart(now: number, floor: number): number {
  return Math.max(floor + 1, Math.floor(now) - SEQUENCE_EPOCH, 1);
}
