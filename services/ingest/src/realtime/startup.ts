import { unlink, writeFile } from "node:fs/promises";
import type { DB } from "@gerlines/db";
import { type Kysely, sql } from "kysely";
import type { Clock } from "../clock.ts";
import type { Logger } from "../log.ts";

/** The migration that brings the tables a live run writes (0041 realtime_live). */
export const REQUIRED_MIGRATION = 41;

/** Throws when a file cannot be written next to `path`, so a checkpoint that would fail stops the start. */
export async function probeWritable(path: string): Promise<void> {
  const probe = `${path}.probe-${process.pid}`;
  try {
    await writeFile(probe, "", { mode: 0o600 });
    await unlink(probe);
  } catch (error) {
    throw new Error(`checkpoint directory is not writable: ${(error as Error).message}`);
  }
}

/**
 * Waits until the database carries the realtime migration (the recorder's runner applies it), logging
 * once a minute; false when `signal` aborts first.
 */
export async function waitForSchema(
  db: Kysely<DB>,
  clock: Clock,
  logger: Logger,
  signal: AbortSignal,
  everyMs = 30_000,
): Promise<boolean> {
  let waited = 0;
  while (!signal.aborted) {
    const row = await sql<{ ok: boolean }>`
      SELECT EXISTS (SELECT 1 FROM gerlines_meta.migration
                      WHERE version = ${REQUIRED_MIGRATION}) AS ok`.execute(db);
    if (row.rows[0]?.ok === true) return true;
    if (waited % 60_000 === 0) {
      logger.log("warn", "waiting for the realtime migration", {
        migration: REQUIRED_MIGRATION,
        waitedS: waited / 1000,
      });
    }
    await clock.sleep(everyMs, signal);
    waited += everyMs;
  }
  return false;
}
