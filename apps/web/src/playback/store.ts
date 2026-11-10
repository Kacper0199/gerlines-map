import { create } from "zustand";
import { playbackBaseOf } from "../live/playback/base.ts";
import type { PlaybackState } from "../live/playback/driver.ts";
import { parseWindowList, type WindowList } from "../live/playback/window-index.ts";
import { liveConfigOf, overrideModeOf } from "../live/source.ts";
import type { PlaybackCommand } from "../motion/protocol.ts";

export type ListStatus = "idle" | "loading" | "ready" | "error";

export const SPEEDS = [1, 2, 5, 10, 30, 60] as const;

export interface PlaybackStore {
  readonly panelOpen: boolean;
  /** The worker's state of the playback; null while the live source runs. */
  readonly state: PlaybackState | null;
  readonly listStatus: ListStatus;
  readonly list: WindowList | null;
  /** The speed asked for, kept between playbacks. */
  readonly speed: number;
  /** Sends a command to the worker; null while no live map is mounted. */
  readonly send: ((command: PlaybackCommand) => void) | null;
  attach(send: ((command: PlaybackCommand) => void) | null): void;
  setState(state: PlaybackState | null): void;
  openPanel(): void;
  closePanel(): void;
  loadList(fetcher?: typeof fetch): Promise<void>;
  start(at: number, playing?: boolean): void;
  seek(at: number): void;
  play(): void;
  pause(): void;
  setSpeed(speed: number): void;
  stop(): void;
}

export function playbackListUrl(search: string, development: boolean): string {
  const base = liveConfigOf(search, overrideModeOf(search, development)).baseUrl;
  return `${playbackBaseOf(base)}/windows`;
}

export const usePlaybackStore = create<PlaybackStore>()((set, get) => ({
  panelOpen: false,
  state: null,
  listStatus: "idle",
  list: null,
  speed: 1,
  send: null,
  attach: (send) => set({ send, ...(send === null ? { state: null } : {}) }),
  setState: (state) => set({ state }),
  openPanel: () => {
    set({ panelOpen: true });
    if (get().listStatus !== "loading") void get().loadList();
  },
  closePanel: () => set({ panelOpen: false }),
  loadList: async (fetcher = (...args) => globalThis.fetch(...args)) => {
    set({ listStatus: "loading" });
    try {
      const response = await fetcher(playbackListUrl(window.location.search, import.meta.env.DEV), {
        headers: { accept: "application/json" },
      });
      const list = response.ok ? parseWindowList(await response.json()) : null;
      set(list ? { list, listStatus: "ready" } : { listStatus: "error" });
    } catch {
      set({ listStatus: "error" });
    }
  },
  start: (at, playing = true) => {
    get().send?.({ action: "start", at, speed: get().speed, playing });
  },
  seek: (at) => get().send?.({ action: "seek", at }),
  play: () => get().send?.({ action: "play" }),
  pause: () => get().send?.({ action: "pause" }),
  setSpeed: (speed) => {
    set({ speed });
    if (get().state !== null) get().send?.({ action: "speed", speed });
  },
  stop: () => get().send?.({ action: "stop" }),
}));
