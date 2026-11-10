import type {
  DataSourceState,
  DataSourceStatus,
  DataStatus,
  LiveEngineStatus,
} from "@gerlines/schema/status";
import { LIVE_SILENCE_MS } from "../trains/routes.ts";
import { feedHolds, STATUS_FEEDS, type StatusFeed } from "./feeds.ts";

/** What the database the recorder writes says of one recorder source. */
export interface RecordedSource {
  readonly source: string;
  /** The newest stored payload (`raw_object.observed_at`), null when none is stored. */
  readonly recordedAt: number | null;
  /** The recorder holds a running record run for it (`ingest_run`). */
  readonly recording: boolean;
}

/** What the live engine last wrote to Valkey: its confirmed tick and the newest payload per source. */
export interface LiveFreshness {
  readonly confirmed: string | null;
  readonly feeds: Readonly<Record<string, string>>;
}

export interface StatusReadings {
  readonly recorded: readonly RecordedSource[];
  /** Null when the live store is not configured or did not answer. */
  readonly live: LiveFreshness | null;
}

const HOUR_MS = 60 * 60_000;

/** A feed without new data for this long (or three thresholds, if longer) counts as down. */
export const DOWN_AFTER_MS = HOUR_MS;

/** The live store drops the confirmation 15 min after the last tick (DETAIL_TTL_S of services/live). */
export const LIVE_DOWN_AFTER_MS = 15 * 60_000;

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function instant(text: string | null | undefined): number | null {
  if (text === null || text === undefined) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

function newest(values: readonly (number | null)[]): number | null {
  let found: number | null = null;
  for (const value of values) {
    if (value !== null && (found === null || value > found)) found = value;
  }
  return found;
}

/**
 * `recording` is a `record` run with status running. A recorder that crashes leaves its run running
 * (`ingest_run` has no heartbeat and `finished_at` stays null until the run ends), so after a crash
 * the age of the newest stored payload decides: stale past the threshold, down after an hour. A
 * timetable has no threshold and stays ok.
 */
function feedState(
  feed: StatusFeed,
  recordedAt: number | null,
  recording: boolean,
  dataTime: number | null,
  now: number,
): DataSourceState {
  if (recordedAt === null) return "not_recorded";
  if (!recording) return "down";
  if (feed.staleAfterSeconds === null) return "ok";
  const limit = feed.staleAfterSeconds * 1000;
  const age = now - recordedAt;
  if (age > Math.max(DOWN_AFTER_MS, 3 * limit)) return "down";
  if (age > limit) return "stale";
  if (dataTime !== null && now - dataTime > limit) return "stale";
  return "ok";
}

function sourceStatus(
  feed: StatusFeed,
  recorded: readonly RecordedSource[],
  live: LiveFreshness | null,
  now: number,
): DataSourceStatus {
  const members = recorded.filter((row) => feedHolds(feed, row.source));
  const recordedAt = newest(members.map((row) => row.recordedAt));
  const recording = members.some((row) => row.recording && row.recordedAt !== null);
  const dataTime = live
    ? newest(
        Object.entries(live.feeds)
          .filter(([source]) => feedHolds(feed, source))
          .map(([, observed]) => instant(observed)),
      )
    : null;
  return {
    id: feed.id,
    name: feed.name,
    kind: feed.kind,
    country: feed.country,
    recordedAt: iso(recordedAt),
    dataTime: iso(dataTime),
    staleAfterSeconds: feed.staleAfterSeconds,
    state: feedState(feed, recordedAt, recording, dataTime, now),
  };
}

function liveStatus(live: LiveFreshness | null, now: number): LiveEngineStatus {
  const staleAfterSeconds = LIVE_SILENCE_MS / 1000;
  const confirmed = live ? instant(live.confirmed) : null;
  if (live === null || confirmed === null) {
    return {
      confirmedAt: null,
      frameAgeSeconds: null,
      staleAfterSeconds,
      state: live === null ? "not_recorded" : "down",
    };
  }
  const ageMs = Math.max(0, now - confirmed);
  const state: DataSourceState =
    ageMs > LIVE_DOWN_AFTER_MS ? "down" : ageMs > LIVE_SILENCE_MS ? "stale" : "ok";
  return {
    confirmedAt: iso(confirmed),
    frameAgeSeconds: Math.round(ageMs / 1000),
    staleAfterSeconds,
    state,
  };
}

/** The data status at `now` from the recorder's rows and the live engine's last write. */
export function buildDataStatus(
  { recorded, live }: StatusReadings,
  now: number,
  feeds: readonly StatusFeed[] = STATUS_FEEDS,
): DataStatus {
  return {
    at: new Date(now).toISOString(),
    live: liveStatus(live, now),
    sources: feeds.map((feed) => sourceStatus(feed, recorded, live, now)),
  };
}
