import type { LiveConfig } from "../motion/protocol.ts";

/** What the page may override from its address: everything in development, little with `?probe`. */
export type OverrideMode = "development" | "probe" | "production";

export const DEFAULT_LIVE_BASE = "/live/v1";
export const DEFAULT_PUSH_PATH = "/connection/websocket";
const POLL_MS = 1000;
const MIN_POLL_MS = 100;
const MAX_REPLAY_SPEED = 60;

export function overrideModeOf(search: string, development: boolean): OverrideMode {
  if (development) return "development";
  return new URLSearchParams(search).has("probe") ? "probe" : "production";
}

function baseOf(value: string | null, mode: OverrideMode): string {
  if (value === null || mode === "production") return DEFAULT_LIVE_BASE;
  const trimmed = value.replace(/\/+$/, "");
  if (/^\/(?!\/)[\w./-]*$/.test(trimmed)) return trimmed;
  const absolute = /^https?:\/\/[\w.[\]:-]+(?::\d+)?(?:\/[\w./-]*)?$/.test(trimmed);
  return absolute && mode === "development" ? trimmed : DEFAULT_LIVE_BASE;
}

/**
 * The push server of a page that follows live frames: our own `/connection/websocket` in a
 * production page; with `?probe` or in development `?push=<path>` (a ws or http url too in
 * development) names another and `?push=off` polls only, and a development page without `?push`
 * polls (the dev server has no push route). A replay has no push server.
 */
function pushOf(value: string | null, mode: OverrideMode, replay: boolean): string | undefined {
  if (replay) return undefined;
  if (mode === "production") return DEFAULT_PUSH_PATH;
  if (value === null) return mode === "probe" ? DEFAULT_PUSH_PATH : undefined;
  if (value === "off") return undefined;
  if (/^\/(?!\/)[\w./-]*$/.test(value)) return value;
  const absolute = /^(?:wss?|https?):\/\/[\w.[\]:-]+(?::\d+)?(?:\/[\w./-]*)?$/.test(value);
  return absolute && mode === "development" ? value : undefined;
}

/**
 * Where the live objects are and how fast their clock runs. `?live=<path>` (a url too in
 * development) names another server and `?replay=<speed>` says the server replays recorded frames at
 * that many plan seconds per second; both are ignored in a production page, so a shared link cannot
 * show another server's trains under our name or run the clock fast. A replay polls once per plan
 * second, so the display never waits for a head that holds many seconds of frames.
 */
export function liveConfigOf(search: string, mode: OverrideMode = "production"): LiveConfig {
  const params = new URLSearchParams(search);
  const speed = Number(params.get("replay"));
  const replay =
    mode !== "production" && params.has("replay") && Number.isFinite(speed) && speed > 0;
  const timeScale = replay ? Math.min(speed, MAX_REPLAY_SPEED) : 1;
  const pushUrl = pushOf(params.get("push"), mode, replay);
  return {
    baseUrl: baseOf(params.get("live"), mode),
    pollMs: Math.max(MIN_POLL_MS, Math.round(POLL_MS / timeScale)),
    ...(pushUrl ? { pushUrl } : {}),
    timeScale,
    replay,
    probe: mode !== "production",
  };
}
