import type { DatabaseOptions } from "@gerlines/db";
import type { Logger } from "../log.ts";

/** A connect that takes longer fails, so a hung database never stalls the fetches that await index writes. */
export const RECORDER_CONNECT_TIMEOUT_MS = 5_000;

/**
 * Pool options of the recorder's index database. An error of an idle pooled connection (a database
 * restart) is logged and never ends the process: the files are the truth and the index reconciles later.
 */
export function recorderDatabaseOptions(databaseUrl: string, logger: Logger): DatabaseOptions {
  return {
    databaseUrl,
    applicationName: "gerlines-recorder",
    maxConnections: 4,
    connectionTimeoutMs: RECORDER_CONNECT_TIMEOUT_MS,
    onPoolError: (error) =>
      logger.log("warn", "database connection failed, the index reconciles from files later", {
        error: error.message,
      }),
  };
}
