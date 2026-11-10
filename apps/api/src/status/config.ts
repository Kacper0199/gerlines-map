import { createDatabase, type DatabaseOptions } from "@gerlines/db";
import { ConfigurationError } from "../config.ts";
import { StatusService } from "./service.ts";
import { DatabaseRecorderStore, type LiveFreshnessReader } from "./store.ts";

type Environment = Readonly<Record<string, string | undefined>>;

export const STATUS_STATEMENT_TIMEOUT_MS = 5_000;

const DATABASE_VARIABLES = [
  "STATUS_DATABASE_URL",
  "STATS_DATABASE_URL",
  "SEARCH_DATABASE_URL",
] as const;

/**
 * The pool of the status reads: `STATUS_DATABASE_URL` (a read-only role is enough), else the
 * statistics or search database; undefined when none is set. Two connections: one read per 30 s.
 * Its transactions are read only, since the fallbacks may be roles that own their tables.
 */
export function statusDatabaseOptions(
  env: Environment,
  logger: { error(line: string): void },
): DatabaseOptions | undefined {
  const variable = DATABASE_VARIABLES.find((name) => env[name]?.trim());
  const databaseUrl = variable && env[variable]?.trim();
  if (!variable || !databaseUrl) return undefined;
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    throw new ConfigurationError(`${variable} must be a postgres:// URL`);
  }
  return {
    databaseUrl,
    applicationName: "gerlines-api-status",
    maxConnections: 2,
    statementTimeoutMs: STATUS_STATEMENT_TIMEOUT_MS,
    queryTimeoutMs: STATUS_STATEMENT_TIMEOUT_MS + 2_000,
    connectionTimeoutMs: 2_000,
    readOnly: true,
    onPoolError: (error) => logger.error(`status database connection failed: ${error.name}`),
  };
}

/** The status service, or undefined when no database is set and the route answers 503 not_configured. */
export function statusFromEnv(
  env: Environment,
  logger: { error(line: string): void },
  live: LiveFreshnessReader | undefined,
): StatusService | undefined {
  const options = statusDatabaseOptions(env, logger);
  return (
    options &&
    new StatusService({
      store: new DatabaseRecorderStore(createDatabase(options)),
      live,
      logger,
    })
  );
}
