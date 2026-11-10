import type { DB } from "@gerlines/db";
import { type Kysely, sql } from "kysely";

export interface FeedFingerprint {
  readonly feedVersionId: number;
  readonly sha256: string;
}

/**
 * Why a shapes database cannot serve the main one, or null: links are matched by
 * `trip_pattern_id` and `feed_version_id`, so every feed version the shapes database links must be
 * the same feed (same sha256) under the same id in the main database.
 */
export function feedMismatch(
  main: readonly FeedFingerprint[],
  shapes: readonly FeedFingerprint[],
): string | null {
  const byId = new Map(main.map((feed) => [feed.feedVersionId, feed.sha256]));
  for (const feed of shapes) {
    const sha = byId.get(feed.feedVersionId);
    if (sha === undefined) return `feed version ${feed.feedVersionId} is not in the main database`;
    if (sha !== feed.sha256)
      return `feed version ${feed.feedVersionId} is another feed in the shapes database (sha256 ${feed.sha256.slice(0, 12)} against ${sha.slice(0, 12)})`;
  }
  return null;
}

async function fingerprints(db: Kysely<DB>, linkedOnly: boolean): Promise<FeedFingerprint[]> {
  const result = await sql<{ id: number; sha256: string }>`
    SELECT v.feed_version_id AS id, v.sha256 FROM feed_version v
     ${linkedOnly ? sql`WHERE EXISTS (SELECT 1 FROM trip_pattern_shape l WHERE l.feed_version_id = v.feed_version_id)` : sql``}
     ORDER BY 1`.execute(db);
  return result.rows.map((row) => ({ feedVersionId: row.id, sha256: row.sha256 }));
}

/** Refuses a shapes database whose linked feed versions differ from the main database's. */
export async function checkShapesDatabase(db: Kysely<DB>, shapesDb: Kysely<DB>): Promise<void> {
  const mismatch = feedMismatch(await fingerprints(db, false), await fingerprints(shapesDb, true));
  if (mismatch)
    throw new Error(`SHAPES_DATABASE_URL does not match the main database: ${mismatch}`);
}
