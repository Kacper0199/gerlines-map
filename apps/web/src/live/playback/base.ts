export const DEFAULT_PLAYBACK_BASE = "/playback/v1";
const LIVE_BASE_END = /\/live\/v1$/;

/** The playback routes that sit beside the live ones (`/live/v1` becomes `/playback/v1`). */
export function playbackBaseOf(liveBase: string): string {
  return LIVE_BASE_END.test(liveBase)
    ? liveBase.replace(LIVE_BASE_END, DEFAULT_PLAYBACK_BASE)
    : DEFAULT_PLAYBACK_BASE;
}
