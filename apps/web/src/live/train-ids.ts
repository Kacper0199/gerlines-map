export const LIVE_ID_PREFIX = "live:";

/** The selection id of a train of our own frames (its frame key). */
export function liveTrainId(key: number): string {
  return `${LIVE_ID_PREFIX}${key}`;
}

/** The frame key of a selection id, null for ids of other sources. */
export function liveKeyOf(id: string | null): number | null {
  if (id === null || !id.startsWith(LIVE_ID_PREFIX)) return null;
  const key = Number(id.slice(LIVE_ID_PREFIX.length));
  return Number.isSafeInteger(key) && key > 0 ? key : null;
}
