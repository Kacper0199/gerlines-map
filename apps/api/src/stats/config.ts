import { createDatabase, type DatabaseOptions } from "@gerlines/db";
import { ConfigurationError } from "../config.ts";
import { DatabaseStatsReader, StatsService } from "./service.ts";

type Environment = Readonly<Record<string, string | undefined>>;

export const STATS_STATEMENT_TIMEOUT_MS = 10_000;

export const STATS_CONNECTION_TIMEOUT_MS = 2_000;

/**
 * The pool options of the statistics database: `STATS_DATABASE_URL` (a read-only role is enough),
 * else `SEARCH_DATABASE_URL`; undefined when neither is set. A request waits at most 2 s for a
 * connection, so a full pool answers 503 instead of queueing.
 */
export function statsDatabaseOptions(
  env: Environment,
  logger: { error(line: string): void },
): DatabaseOptions | undefined {
  const databaseUrl = env.STATS_DATABASE_URL?.trim() || env.SEARCH_DATABASE_URL?.trim();
  if (!databaseUrl) return undefined;
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    throw new ConfigurationError("STATS_DATABASE_URL must be a postgres:// URL");
  }
  return {
    databaseUrl,
    applicationName: "gerlines-api-stats",
    maxConnections: 6,
    statementTimeoutMs: STATS_STATEMENT_TIMEOUT_MS,
    queryTimeoutMs: STATS_STATEMENT_TIMEOUT_MS + 5_000,
    connectionTimeoutMs: STATS_CONNECTION_TIMEOUT_MS,
    onPoolError: (error) => logger.error(`stats database connection failed: ${error.message}`),
  };
}

/** The statistics service, or undefined when no database is set and the routes answer 503 not_configured. */
export function statsFromEnv(
  env: Environment,
  logger: { error(line: string): void },
): StatsService | undefined {
  const options = statsDatabaseOptions(env, logger);
  return options && new StatsService(new DatabaseStatsReader(createDatabase(options)));
}
