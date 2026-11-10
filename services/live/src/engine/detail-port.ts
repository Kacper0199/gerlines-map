import type { GeometryGap } from "../model.ts";

/**
 * The state of one trip instance as the live engine holds it at a tick: what WP-3.2b's detail
 * writer needs to keep `TrainDetail` in step with the map (same source, same delay, same version).
 */
export interface LiveInstanceState {
  readonly tripInstanceId: string;
  /** Frame trip key; null while the trip is not drawn. */
  readonly key: number | null;
  readonly serviceDate: string;
  /** The instance's own timetable version (a carried-over instance keeps its old one). */
  readonly feedVersionId: number;
  readonly tripKey: string | null;
  readonly category: string;
  /** The realtime source the instance follows (since: Unix seconds); null for timetable only. */
  readonly source: { readonly sourceId: string; readonly since: number } | null;
  readonly geometry: { readonly available: boolean; readonly reason: GeometryGap | null };
  /** Delay at the next served stop from the source, drawn or not; null without a source. */
  readonly delaySeconds: number | null;
  readonly cancelled: boolean;
  /**
   * Progress by arrival ("reached"): the last served static stop whose expected arrival is at or
   * before the state's time, and the first one after it. The train stands at `lastPassedIndex`
   * until that stop's departure. "Reached" means reached by the times known then, not observed:
   * a train without realtime passes a stop at its scheduled time. Never lower than in an earlier
   * state of the same instance in this process: a forecast that moves a reached stop
   * later holds the train at that stop; only a reached stop the source later cancels gives way to
   * the served stop before it. After a restart the floor starts again (WP-3.2b's writer floors
   * the card across it).
   */
  readonly lastPassedIndex: number | null;
  readonly nextIndex: number | null;
  /** Expected arrival at the destination (predicted, else scheduled), Unix seconds. */
  readonly endsAt: number;
  /** When this state was taken, Unix seconds. */
  readonly at: number;
}

export interface LiveTickUpdate {
  /** Tick time, Unix seconds (of the newest tick merged into this update). */
  readonly at: number;
  /** Newest frame sequence after this tick (TrainDetail.version of the changed instances). */
  readonly sequence: number;
  /** The active chain version; per instance, use `LiveInstanceState.feedVersionId`. */
  readonly timetableVersion: number;
  /**
   * Instances whose state changed: a plan change, a status change, or a step of progress (one
   * arrival or departure each). The newest state per instance wins.
   */
  readonly changed: readonly LiveInstanceState[];
  /** Instances that left the running set, with their final state (progress at `at`). */
  readonly removed: readonly LiveInstanceState[];
}

/**
 * Implemented by WP-3.2b in `src/detail/`. The engine never awaits it inside a tick: updates go to a
 * queue (newest state per instance wins) that one background worker drains, one publish at a time.
 */
export interface DetailPort {
  publish(update: LiveTickUpdate): Promise<void>;
}
