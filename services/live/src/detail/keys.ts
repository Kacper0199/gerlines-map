/**
 * Valkey keys and Centrifugo channels of the train detail (design note §4). `apps/api` reads the same
 * keys from its own copy in `apps/api/src/trains/reader.ts`; both test the literal names.
 */
export const DETAIL_TTL_S = 15 * 60;

export function trainDetailKey(tripInstanceId: string): string {
  return `live:train:${tripInstanceId}`;
}

/** When a train left the running set (ISO instant); the API caps the served `asOf` there. */
export function trainLeftKey(tripInstanceId: string): string {
  return `live:left:${tripInstanceId}`;
}

/** The trip instance a frame key stands for, written by the live engine (WP-3.2a). */
export function frameKeyKey(frameKey: number): string {
  return `live:inst:${frameKey}`;
}

/** When the live engine last confirmed the details, as an ISO instant. */
export const DETAIL_CONFIRMED_KEY = "live:detail:confirmed";

/** Newest payload per realtime source (hash of source id to ISO instant). */
export const DETAIL_FEEDS_KEY = "live:detail:feeds";

export function trainChannel(tripInstanceId: string): string {
  return `train:${tripInstanceId}`;
}
