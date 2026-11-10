import { isAbsolute } from "node:path";
import { Hono } from "hono";
import { notFound } from "../server/app.ts";
import { createPlaybackApp } from "./app.ts";
import { PlaybackCache } from "./cache.ts";

/** `LIVE_PLAYBACK_DIR`: the rendered windows `live run` serves read only; unset keeps playback off. */
export function playbackDirectory(env: NodeJS.ProcessEnv): string | null {
  const value = env.LIVE_PLAYBACK_DIR?.trim();
  if (!value) return null;
  if (!isAbsolute(value)) throw new Error("LIVE_PLAYBACK_DIR must be an absolute directory");
  return value;
}

export function playbackState(directory: string | null): string {
  return directory ? `serving ${directory}` : "off (no LIVE_PLAYBACK_DIR)";
}

/** The live routes plus, when a playback directory is given, the playback routes without rendering. */
export function withPlayback(live: Hono, directory: string | null, now: () => number): Hono {
  if (!directory) return live;
  const app = new Hono();
  app.route("/", createPlaybackApp({ cache: new PlaybackCache(directory), renderer: null, now }));
  app.route("/", live);
  app.notFound(() => notFound());
  return app;
}
