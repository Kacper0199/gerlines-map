import type { DB } from "@gerlines/db";
import { type Kysely, sql } from "kysely";
import { render } from "../render.ts";
import { TIMETABLE_SOURCE } from "../timetable/loader.ts";
import type { RenderWindow } from "./renderer.ts";

/**
 * The playback chain's cadence (ADR-0014): a delta at most every 10 s and a keyframe every 300 s.
 * Over 2026-10-25 12:00 to 13:00Z it keeps the delta bytes of the live chain (1.13 against 1.21 MB
 * brotli) with a third of the deltas and a tenth of the keyframes.
 */
export const PLAYBACK_INTERVALS = { deltaInterval: 10, keyframeInterval: 300 } as const;

export interface DatabaseRenderOptions {
  readonly db: Kysely<DB>;
  readonly shapesDb?: Kysely<DB>;
  /** The live packs directory: no version is taken whose packs it does not mark complete. */
  readonly packs: string;
  /**
   * Feed version id to Unix seconds, replacing the version's load time: a replay database loaded
   * its versions after the days it replays (`--version-available`).
   */
  readonly versionAvailable?: ReadonlyMap<number, number>;
  readonly progress?: (line: string) => void;
}

/** When each loaded timetable version finished loading, Unix seconds (created_at when unset). */
export async function versionLoadTimes(db: Kysely<DB>): Promise<Map<number, number>> {
  const rows = await sql<{ feed_version_id: number; loaded: number }>`
    SELECT feed_version_id, extract(epoch FROM coalesce(loaded_at, created_at))::float8 AS loaded
      FROM feed_version
     WHERE source_id = ${TIMETABLE_SOURCE} AND status = 'loaded'`.execute(db);
  return new Map(rows.rows.map((row) => [row.feed_version_id, Math.ceil(Number(row.loaded))]));
}

/** Each version's load time, a named instant replacing it. */
export function versionAvailability(
  loadTimes: ReadonlyMap<number, number>,
  named: ReadonlyMap<number, number>,
): Map<number, number> {
  return new Map([...loadTimes, ...named]);
}

/**
 * Renders a window with `live render` on a virtual clock, one tick per second, history as of each
 * tick, and each timetable version only from its load time on (as live run saw it): a backfill or a
 * forced render after a later load still plays the version that was live then. A version
 * loaded while the window renders is hidden too.
 */
export function databaseRenderWindow(options: DatabaseRenderOptions): RenderWindow {
  return async (start, end, out) => {
    const versionAvailable = versionAvailability(
      await versionLoadTimes(options.db),
      options.versionAvailable ?? new Map(),
    );
    const report = await render({
      db: options.db,
      ...(options.shapesDb ? { shapesDb: options.shapesDb } : {}),
      packs: options.packs,
      ...(options.progress ? { progress: options.progress } : {}),
      versionAvailable,
      unlistedVersionAvailable: Number.POSITIVE_INFINITY,
      from: start,
      to: end,
      cadence: 1,
      out,
      holdRule: true,
      ...PLAYBACK_INTERVALS,
    });
    return {
      start,
      end,
      heads: report.heads,
      shapeEpoch: report.shapeEpoch,
      firstSequence: report.firstSequence,
      lastSequence: report.lastSequence,
      wallSeconds: report.wallSeconds,
      ...PLAYBACK_INTERVALS,
    };
  };
}
