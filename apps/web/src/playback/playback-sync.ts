import type { PlaybackState } from "../live/playback/driver.ts";
import { atOf, writeAt } from "./playback-url.ts";

export const POSITION_WRITE_MS = 3000;
/** A moment in the address this close to the playing one is the same moment. */
const SAME_MOMENT_S = 5;

export interface PlaybackSyncEnvironment {
  readonly location: Pick<Location, "pathname" | "search" | "hash">;
  readonly history: Pick<History, "pushState" | "replaceState">;
  addPopListener(listener: () => void): () => void;
  now(): number;
}

export interface PlaybackSyncTarget {
  state(): PlaybackState | null;
  /** Whether a command can reach the worker yet. */
  ready(): boolean;
  subscribe(listener: () => void): () => void;
  start(at: number): void;
  seek(at: number): void;
  stop(): void;
}

/**
 * Keeps the address and the playback in step (D-057): `?at=` names the moment. Entering a
 * playback and leaving it are new history entries, so Back goes where the visitor came from; the
 * position replaces the current entry at most every three seconds while it plays. A link that
 * carries a moment starts the playback once the worker can take the command; Back and Forward
 * start, seek or stop it. What the address already says is not written again, so an answer to
 * Back never adds an entry.
 */
export function startPlaybackUrlSync(
  environment: PlaybackSyncEnvironment,
  target: PlaybackSyncTarget,
): { stop(): void } {
  const { location, history } = environment;
  let active = target.state() !== null;
  let lastWrite = Number.NEGATIVE_INFINITY;
  let writtenAt: number | null = null;
  let started = false;

  const write = (at: number | null, mode: "pushState" | "replaceState") => {
    const search = writeAt(location.search, at);
    lastWrite = environment.now();
    writtenAt = at;
    if (search === location.search) return;
    history[mode](null, "", `${location.pathname}${search}${location.hash}`);
  };

  const fromAddress = () => {
    const at = atOf(location.search);
    const state = target.state();
    if (at === null) {
      if (state !== null) target.stop();
      return;
    }
    if (state === null) target.start(at);
    else if (Math.abs(at - state.position) > SAME_MOMENT_S) target.seek(at);
  };

  const onPosition = (state: PlaybackState) => {
    if (state.phase === "seeking" || state.phase === "opening" || state.error !== null) return;
    const position = Math.floor(state.position);
    const moved = writtenAt === null || Math.abs(position - writtenAt) > SAME_MOMENT_S;
    const waited = environment.now() - lastWrite >= POSITION_WRITE_MS;
    if (moved && (state.phase !== "playing" || waited)) write(position, "replaceState");
  };

  const onState = () => {
    const state = target.state();
    if (state === null) {
      if (active && atOf(location.search) !== null) write(null, "pushState");
      active = false;
      return;
    }
    if (active) {
      onPosition(state);
      return;
    }
    active = true;
    const known = atOf(location.search);
    write(Math.floor(state.position), known === null ? "pushState" : "replaceState");
  };

  const begin = () => {
    if (started || !target.ready()) return;
    started = true;
    fromAddress();
  };

  const unsubscribe = target.subscribe(() => {
    begin();
    onState();
  });
  const removePop = environment.addPopListener(fromAddress);
  begin();

  return {
    stop() {
      unsubscribe();
      removePop();
    },
  };
}
