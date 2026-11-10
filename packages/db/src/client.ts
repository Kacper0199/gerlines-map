import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { DB } from "./generated/database.ts";

export interface DatabaseOptions {
  databaseUrl: string;
  applicationName: string;
  maxConnections?: number;
  /** Postgres cancels a statement that runs longer. */
  statementTimeoutMs?: number;
  /** The client gives up waiting for an answer after this long. */
  queryTimeoutMs?: number;
  /** Acquiring a pooled connection or connecting fails after this long (pg waits forever otherwise). */
  connectionTimeoutMs?: number;
  /** Errors of idle pooled connections (a database restart); without it they end the process. */
  onPoolError?: (error: Error) => void;
  /** Every transaction of the pool is read only (`default_transaction_read_only`), whatever the role may do. */
  readOnly?: boolean;
}

export function poolConfig(options: DatabaseOptions): pg.PoolConfig {
  return {
    connectionString: options.databaseUrl,
    application_name: options.applicationName,
    max: options.maxConnections ?? 10,
    ...(options.statementTimeoutMs === undefined
      ? {}
      : { statement_timeout: options.statementTimeoutMs }),
    ...(options.queryTimeoutMs === undefined ? {} : { query_timeout: options.queryTimeoutMs }),
    ...(options.connectionTimeoutMs === undefined
      ? {}
      : { connectionTimeoutMillis: options.connectionTimeoutMs }),
    ...(options.readOnly ? { options: "-c default_transaction_read_only=on" } : {}),
  };
}

export function createDatabase(options: DatabaseOptions): Kysely<DB> {
  const pool = new pg.Pool(poolConfig(options));
  if (options.onPoolError) pool.on("error", options.onPoolError);
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}
