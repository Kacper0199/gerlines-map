import type { Locale } from "./locale.ts";
import { m } from "./paraglide/messages.js";

export const PLAYBACK_ERROR_CODES = [
  "not_rendered",
  "not_settled",
  "too_old",
  "epoch_mismatch",
  "offline",
  "unreadable",
] as const;
export type PlaybackErrorCode = (typeof PLAYBACK_ERROR_CODES)[number];

/** The timeline's strings (WP-7.6b), loaded with the lazy panel; the bar's three live in the entry copy. */
export function createPlaybackCopy(locale: Locale) {
  const o = { locale };
  return {
    title: m.playback_title({}, o),
    close: m.playback_close({}, o),
    play: m.playback_play({}, o),
    pause: m.playback_pause({}, o),
    day: m.playback_day({}, o),
    hour: m.playback_hour({}, o),
    speed: m.playback_speed({}, o),
    scrubber: m.playback_scrubber({}, o),
    time: m.playback_time({}, o),
    start: m.playback_start({}, o),
    hint: m.playback_hint({}, o),
    hourMissing: m.playback_hour_missing({}, o),
    loading: m.playback_loading({}, o),
    seeking: m.playback_seeking({}, o),
    empty: m.playback_empty({}, o),
    listError: m.playback_list_error({}, o),
    retry: m.playback_retry({}, o),
    ended: m.playback_ended({}, o),
    errors: {
      not_rendered: m.playback_error_not_rendered({}, o),
      not_settled: m.playback_error_not_settled({}, o),
      too_old: m.playback_error_too_old({}, o),
      epoch_mismatch: m.playback_error_epoch_mismatch({}, o),
      offline: m.playback_error_offline({}, o),
      unreadable: m.playback_error_unreadable({}, o),
    } satisfies Record<PlaybackErrorCode, string>,
  };
}

export type PlaybackCopy = ReturnType<typeof createPlaybackCopy>;

const cache = new Map<Locale, PlaybackCopy>();

export function playbackCopyFor(locale: Locale): PlaybackCopy {
  const cached = cache.get(locale);
  if (cached !== undefined) {
    return cached;
  }
  const created = createPlaybackCopy(locale);
  cache.set(locale, created);
  return created;
}
