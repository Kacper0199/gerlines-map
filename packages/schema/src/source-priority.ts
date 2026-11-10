/**
 * The realtime source rule shared by the live engine and the train detail API (D-038, D-041 item 3):
 * one source per trip instance, never mixed per stop, chosen by a priority that depends on the
 * category and kept (sticky) until the held source has been quiet for SOURCE_SWITCH_AFTER_S while
 * another source reported the instance. IRIS outside hsr and ld gives way to any fresh better
 * ranked source at once.
 */

export type SourceGroup = "iris" | "gtfsde" | "delfi" | "regional" | "neighbour";

/**
 * Seconds a held source must have been quiet for this instance, while another source reported it,
 * before the choice moves on.
 */
export const SOURCE_SWITCH_AFTER_S = 900;

/**
 * Seconds after a choice during which a better ranked source that reports the instance still takes
 * over: sources are polled at different phases, so the first one to report is not always the best.
 */
export const SOURCE_SETTLE_S = 120;

const GROUP_OF: Readonly<Record<string, SourceGroup>> = {
  "db-iris": "iris",
  "gtfsde-rt": "gtfsde",
  "delfi-gtfs-rt": "delfi",
  "delfi-gtfs-rt-deincr": "delfi",
  "mobilithek-delfi-gtfs-rt": "delfi",
  "vbb-gtfs-rt": "regional",
  "vbn-gtfs-rt": "regional",
};

const LONG_DISTANCE_ORDER: readonly SourceGroup[] = [
  "iris",
  "gtfsde",
  "delfi",
  "regional",
  "neighbour",
];
const DEFAULT_ORDER: readonly SourceGroup[] = ["delfi", "gtfsde", "regional", "neighbour", "iris"];

const isLongDistance = (category: string | null) => category === "hsr" || category === "ld";

/** The priority group of a source id; unknown sources count as neighbours (lowest German rank). */
export function sourceGroup(sourceId: string): SourceGroup {
  return GROUP_OF[sourceId] ?? "neighbour";
}

/**
 * Rank of a source for a category, lower is better: `hsr` and `ld` take IRIS, gtfs.de, DELFI, VBB
 * and VBN, then the neighbours; every other category DELFI, gtfs.de, VBB and VBN, the neighbours,
 * then IRIS.
 */
export function sourceRank(category: string | null, sourceId: string): number {
  const order = isLongDistance(category) ? LONG_DISTANCE_ORDER : DEFAULT_ORDER;
  return order.indexOf(sourceGroup(sourceId));
}

/** When a source first and last reported one trip instance, in Unix seconds. */
export interface SourceActivity {
  readonly sourceId: string;
  readonly firstSeen: number;
  readonly lastSeen: number;
}

/** The source an instance follows and since when (Unix seconds). */
export interface HeldSource {
  readonly sourceId: string;
  readonly since: number;
}

function better(category: string | null, a: SourceActivity, b: SourceActivity): boolean {
  const rankA = sourceRank(category, a.sourceId);
  const rankB = sourceRank(category, b.sourceId);
  return rankA < rankB || (rankA === rankB && a.sourceId < b.sourceId);
}

function best(
  category: string | null,
  activity: readonly SourceActivity[],
): SourceActivity | undefined {
  let found: SourceActivity | undefined;
  for (const entry of activity) {
    if (!found || better(category, entry, found)) found = entry;
  }
  return found;
}

/**
 * IRIS held for a category that ranks it last: IRIS names trains hours ahead and reports every few
 * minutes, so it is often first and never quiet, and stickiness alone would keep it.
 */
function irisOutOfPlace(category: string | null, held: SourceActivity): boolean {
  return sourceGroup(held.sourceId) === "iris" && !isLongDistance(category);
}

/**
 * The source to follow at `now` (Unix seconds), given the one held so far (null for none) and each
 * source's activity for the instance. Returns `held` itself when the choice stays, a new
 * HeldSource when it changes, null when no source has reported yet. A stateless reader passes
 * `held = null` and gets the best ranked source that has reported.
 */
export function chooseSource(
  category: string | null,
  held: HeldSource | null,
  activity: readonly SourceActivity[],
  now: number,
): HeldSource | null {
  const reported = activity.filter((entry) => entry.firstSeen <= now);
  const fresh = best(
    category,
    reported.filter((entry) => now - entry.lastSeen < SOURCE_SWITCH_AFTER_S),
  );
  const top = fresh ?? best(category, reported);
  if (!top) return held;
  const current = held ? reported.find((entry) => entry.sourceId === held.sourceId) : undefined;
  if (!held || !current) return { sourceId: top.sourceId, since: now };
  if (fresh && irisOutOfPlace(category, current) && better(category, fresh, current)) {
    return { sourceId: fresh.sourceId, since: now };
  }
  if (now - current.lastSeen < SOURCE_SWITCH_AFTER_S) {
    const settling = now - held.since < SOURCE_SETTLE_S;
    return settling && fresh && better(category, fresh, current)
      ? { sourceId: fresh.sourceId, since: held.since }
      : held;
  }
  return fresh && fresh.sourceId !== held.sourceId
    ? { sourceId: fresh.sourceId, since: now }
    : held;
}
