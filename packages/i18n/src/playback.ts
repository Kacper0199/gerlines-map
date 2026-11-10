import { type PlaybackCopy, playbackCopyFor } from "./copy-playback.ts";
import { useLocale } from "./react.ts";

export {
  PLAYBACK_ERROR_CODES,
  type PlaybackCopy,
  type PlaybackErrorCode,
  playbackCopyFor,
} from "./copy-playback.ts";

export function usePlaybackCopy(): PlaybackCopy {
  return playbackCopyFor(useLocale());
}
