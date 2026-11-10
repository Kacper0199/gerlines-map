import { startPlaybackUrlSync } from "./playback-sync.ts";
import { usePlaybackStore } from "./store.ts";

/** The address sync over the window and the playback store, started once the map is mounted. */
export function browserPlaybackSync(): { stop(): void } {
  const store = usePlaybackStore;
  return startPlaybackUrlSync(
    {
      location: window.location,
      history: window.history,
      addPopListener: (listener) => {
        window.addEventListener("popstate", listener);
        return () => window.removeEventListener("popstate", listener);
      },
      now: () => performance.now(),
    },
    {
      state: () => store.getState().state,
      ready: () => store.getState().send !== null,
      subscribe: (listener) => store.subscribe(listener),
      start: (at) => store.getState().start(at),
      seek: (at) => store.getState().seek(at),
      stop: () => store.getState().stop(),
    },
  );
}
