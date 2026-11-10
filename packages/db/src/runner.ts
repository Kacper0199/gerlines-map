import pg from "pg";
import {
  type AppliedMigration,
  loadMigrations,
  type Migration,
  MigrationError,
  type MigrationStatusRow,
  migrationStatus,
  planDown,
  planUp,
  splitStatements,
} from "./migrations.ts";

export const migrationLockKey = "7244618842011453289";
export const migrationTable = "gerlines_meta.migration";

export class MigrationLockError extends MigrationError {}

export interface RunnerOptions {
  databaseUrl: string;
  migrationsDir?: string;
  lockWaitMs?: number;
}

export interface MigrationResult {
  version: number;
  name: string;
  durationMs: number;
}

const historyDdl = `
CREATE SCHEMA IF NOT EXISTS gerlines_meta;
CREATE TABLE IF NOT EXISTS gerlines_meta.migration (
  version integer PRIMARY KEY CHECK (version > 0),
  name text NOT NULL,
  up_checksum text NOT NULL CHECK (up_checksum ~ '^[0-9a-f]{64}$'),
  down_checksum text NOT NULL CHECK (down_checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now(),
  duration_ms integer NOT NULL CHECK (duration_ms >= 0)
);`;

const lockPollMs = 250;

async function acquireLock(client: pg.Client, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS locked",
      [migrationLockKey],
    );
    if (result.rows[0]?.locked) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new MigrationLockError(
        `another migration run holds the lock (advisory lock ${migrationLockKey})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(lockPollMs, waitMs)));
  }
}

async function readApplied(client: pg.Client): Promise<AppliedMigration[]> {
  const exists = await client.query<{ present: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS present",
    [migrationTable],
  );
  if (!exists.rows[0]?.present) {
    return [];
  }
  const result = await client.query<AppliedMigration>(
    `SELECT version, name, up_checksum AS "upChecksum", down_checksum AS "downChecksum"
       FROM ${migrationTable} ORDER BY version`,
  );
  return result.rows;
}

async function withClient<T>(
  options: RunnerOptions,
  work: (client: pg.Client, migrations: Migration[]) => Promise<T>,
): Promise<T> {
  const migrations = await loadMigrations(options.migrationsDir);
  const client = new pg.Client({
    connectionString: options.databaseUrl,
    application_name: "gerlines-migrate",
  });
  await client.connect();
  try {
    return await work(client, migrations);
  } finally {
    await client.end();
  }
}

function withLockedClient<T>(
  options: RunnerOptions,
  work: (client: pg.Client, migrations: Migration[]) => Promise<T>,
): Promise<T> {
  return withClient(options, async (client, migrations) => {
    await client.query("SET lock_timeout = '30s'");
    await acquireLock(client, options.lockWaitMs ?? 10_000);
    await client.query(historyDdl);
    return work(client, migrations);
  });
}

export interface Queryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function recordHistory(
  client: Queryable,
  migration: Migration,
  direction: "up" | "down",
  started: number,
): Promise<void> {
  if (direction === "up") {
    await client.query(
      `INSERT INTO ${migrationTable} (version, name, up_checksum, down_checksum, duration_ms)
         VALUES ($1, $2, $3, $4, $5)`,
      [
        migration.version,
        migration.name,
        migration.upChecksum,
        migration.downChecksum,
        Math.round(performance.now() - started),
      ],
    );
  } else {
    await client.query(`DELETE FROM ${migrationTable} WHERE version = $1`, [migration.version]);
  }
}

async function inTransaction(client: Queryable, work: () => Promise<void>): Promise<void> {
  await client.query("BEGIN");
  try {
    await work();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function runStatements(
  client: Queryable,
  migration: Migration,
  direction: "up" | "down",
): Promise<void> {
  const statements = splitStatements(direction === "up" ? migration.up : migration.down);
  for (const [index, statement] of statements.entries()) {
    try {
      await client.query(statement);
    } catch (error) {
      const applied =
        index === 0 ? "no statement was applied" : `statements 1 to ${index} stay applied`;
      throw new MigrationError(
        `migration ${migration.version} ${migration.name} (${direction}) failed at statement ${index + 1} of ${statements.length} without a transaction: ${reasonOf(error)}; ${applied}, repair them by hand before running again`,
        { cause: error },
      );
    }
  }
}

export async function applyMigration(
  client: Queryable,
  migration: Migration,
  direction: "up" | "down",
): Promise<MigrationResult> {
  const started = performance.now();
  const transactional =
    direction === "up" ? migration.upInTransaction : migration.downInTransaction;
  if (!transactional) {
    await runStatements(client, migration, direction);
  }
  try {
    await inTransaction(client, async () => {
      if (transactional) {
        await client.query(direction === "up" ? migration.up : migration.down);
      }
      await recordHistory(client, migration, direction, started);
    });
  } catch (error) {
    throw new MigrationError(
      `migration ${migration.version} ${migration.name} (${direction}) failed: ${reasonOf(error)}`,
      { cause: error },
    );
  }
  return {
    version: migration.version,
    name: migration.name,
    durationMs: Math.round(performance.now() - started),
  };
}

async function runAll(
  client: pg.Client,
  plan: Migration[],
  direction: "up" | "down",
): Promise<MigrationResult[]> {
  const results: MigrationResult[] = [];
  for (const migration of plan) {
    results.push(await applyMigration(client, migration, direction));
  }
  return results;
}

export function migrateUp(
  options: RunnerOptions & { targetVersion?: number },
): Promise<MigrationResult[]> {
  return withLockedClient(options, async (client, migrations) =>
    runAll(client, planUp(migrations, await readApplied(client), options.targetVersion), "up"),
  );
}

export function migrateDown(
  options: RunnerOptions & { steps: number },
): Promise<MigrationResult[]> {
  return withLockedClient(options, async (client, migrations) =>
    runAll(client, planDown(migrations, await readApplied(client), options.steps), "down"),
  );
}

export function migrateDownAll(options: RunnerOptions): Promise<MigrationResult[]> {
  return withLockedClient(options, async (client, migrations) => {
    const applied = await readApplied(client);
    if (applied.length === 0) {
      return [];
    }
    return runAll(client, planDown(migrations, applied, applied.length), "down");
  });
}

export function getStatus(options: RunnerOptions): Promise<MigrationStatusRow[]> {
  return withClient(options, async (client, migrations) =>
    migrationStatus(migrations, await readApplied(client)),
  );
}
