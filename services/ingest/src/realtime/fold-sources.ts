import type { DB } from "@gerlines/db";
import type { Kysely } from "kysely";
import { DB_MARKETPLACE, DB_METADATA } from "../sources.ts";
import { IRIS_SOURCE, irisRecording } from "./iris.ts";

/** The `source` row of a logical source that folds several recorded ones and is polled by none. */
export interface FoldSourceRow {
  readonly source_id: string;
  readonly name: string;
  readonly homepage_url: string;
  readonly licence: string;
  readonly licence_url: string;
  readonly attribution: string;
}

export const IRIS_FOLD_SOURCE: FoldSourceRow = {
  source_id: IRIS_SOURCE,
  name: "DB Timetables (IRIS) realtime of the long-distance station cover",
  homepage_url: `${DB_MARKETPLACE}/timetables`,
  licence: DB_METADATA.licence,
  licence_url: DB_METADATA.licenceUrl,
  attribution: DB_METADATA.attribution,
};

/** The logical sources a run folds rows under that no recorder registers: `db-iris` for IRIS answers. */
export function foldSourceRows(sources: readonly string[]): FoldSourceRow[] {
  return sources.some((source) => irisRecording(source) !== null) ? [IRIS_FOLD_SOURCE] : [];
}

/** Registers those sources, so realtime rows can name them; returns their ids. */
export async function registerFoldSources(
  db: Kysely<DB>,
  sources: readonly string[],
): Promise<string[]> {
  const rows = foldSourceRows(sources);
  for (const row of rows) {
    await db
      .insertInto("source")
      .values(row)
      .onConflict((conflict) =>
        conflict.column("source_id").doUpdateSet({
          name: row.name,
          homepage_url: row.homepage_url,
          licence: row.licence,
          licence_url: row.licence_url,
          attribution: row.attribution,
        }),
      )
      .execute();
  }
  return rows.map((row) => row.source_id);
}
