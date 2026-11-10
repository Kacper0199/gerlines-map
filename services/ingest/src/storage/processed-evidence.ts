import type { DB } from "@gerlines/db";
import type { Kysely } from "kysely";

const BATCH = 1000;

export interface ProcessedLookup {
  processed(objectIds: readonly string[]): Promise<ReadonlySet<string>>;
  readonly note: string;
}

export const NOTHING_PROCESSED: ProcessedLookup = {
  processed: async () => new Set<string>(),
  note: "no database asked: no payload counts as processed",
};

/**
 * Raw objects the realtime processor (WP-2.3b) wrote into `rt_payload` without an error. Read only. A database
 * without the table (before migration 0030) holds nothing processed. Contract owed by WP-2.3b before the first
 * apply with this evidence: a row means the payload was applied, never skipped as a duplicate of another source;
 * until then a skipped payload must get an error text or no row.
 */
export function processedInDatabase(db: Kysely<DB>, label: string): ProcessedLookup {
  return {
    note: `rt_payload rows without an error in ${label}`,
    processed: async (objectIds) => {
      const done = new Set<string>();
      for (let start = 0; start < objectIds.length; start += BATCH) {
        const batch = objectIds.slice(start, start + BATCH);
        try {
          const rows = await db
            .selectFrom("rt_payload")
            .select("raw_object_id")
            .where("raw_object_id", "in", batch)
            .where("error", "is", null)
            .execute();
          for (const row of rows) done.add(row.raw_object_id);
        } catch (error) {
          if (
            error instanceof Error &&
            /relation "rt_payload" does not exist/.test(error.message)
          ) {
            return done;
          }
          throw error;
        }
      }
      return done;
    },
  };
}
