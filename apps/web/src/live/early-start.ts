import type { Palette } from "../motion/frame.ts";
import type { MotionClient } from "../motion/worker-client.ts";
import type { ThemeName } from "../theme/tokens.ts";
import { trainPalette } from "../theme/tokens.ts";
import { liveConfigOf, overrideModeOf } from "./source.ts";

/** An early worker nobody took over by then is stopped: the map is not coming. */
export const EARLY_WORKER_WATCHDOG_MS = 60_000;

let early: Worker | undefined;
let handedOver: Worker | undefined;
let stopWatching: (() => void) | undefined;

function watch(worker: Worker): () => void {
  const onVisibility = () => worker.postMessage({ type: "visibility", hidden: document.hidden });
  document.addEventListener("visibilitychange", onVisibility);
  const timer = setTimeout(abandonEarlyWorker, EARLY_WORKER_WATCHDOG_MS);
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    clearTimeout(timer);
  };
}

/**
 * Starts the live worker before the map code has arrived, so its script, the head and the keyframe download while the
 * map stack does. The shape packs wait (`holdPacks`) until the map takes the worker over, since 2,000 packs would
 * otherwise slow the map code down on a slow link. Until then it follows the tab's visibility, and it is stopped after
 * a minute if the map has not taken it (`abandonEarlyWorker` stops it sooner when the map fails).
 */
export function startLiveEarly(theme: ThemeName, search: string): void {
  if (early || typeof Worker === "undefined") return;
  const worker = new Worker(new URL("./live.worker.ts", import.meta.url), { type: "module" });
  worker.postMessage({
    type: "init-live",
    palette: trainPalette(theme),
    config: {
      ...liveConfigOf(search, overrideModeOf(search, import.meta.env.DEV)),
      holdPacks: true,
    },
  });
  early = worker;
  stopWatching = watch(worker);
}

/** The worker started by `startLiveEarly`, once; undefined when none was started or it was taken. */
export function takeEarlyWorker(): Worker | undefined {
  stopWatching?.();
  stopWatching = undefined;
  handedOver = early;
  early = undefined;
  return handedOver;
}

/** Stops the early worker, taken or not: the map failed, so nothing will use what it reads. */
export function abandonEarlyWorker(): void {
  stopWatching?.();
  stopWatching = undefined;
  early?.terminate();
  handedOver?.terminate();
  early = undefined;
  handedOver = undefined;
}

/** The map took the early worker over: it gets the theme's palette and the motion preference, and its packs may load. */
export function adoptEarlyWorker(
  client: MotionClient,
  palette: Palette,
  reducedMotion: boolean,
): void {
  client.setPalette(palette);
  client.setReducedMotion(reducedMotion);
  client.releasePacks();
}
