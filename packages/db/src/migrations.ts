import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const defaultMigrationsDir = fileURLToPath(new URL("../migrations/", import.meta.url));

export type Direction = "up" | "down";

export interface MigrationFileName {
  version: number;
  name: string;
  direction: Direction;
}

export interface Migration {
  version: number;
  name: string;
  up: string;
  down: string;
  upChecksum: string;
  downChecksum: string;
  upInTransaction: boolean;
  downInTransaction: boolean;
}

export interface AppliedMigration {
  version: number;
  name: string;
  upChecksum: string;
  downChecksum: string;
}

export interface MigrationStatusRow {
  version: number;
  name: string;
  state: "applied" | "pending";
}

export class MigrationError extends Error {
  override readonly name = "MigrationError";
}

const fileNamePattern = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.(up|down)\.sql$/;

export function parseMigrationFileName(fileName: string): MigrationFileName | null {
  const match = fileNamePattern.exec(fileName);
  if (!match) {
    return null;
  }
  const [, version, name, direction] = match;
  const parsedVersion = Number(version);
  if (parsedVersion === 0 || name === undefined) {
    return null;
  }
  return { version: parsedVersion, name, direction: direction as Direction };
}

export const noTransactionDirective = "-- gerlines:no-transaction";

const directivePrefix = "-- gerlines:";
const identifierChar = /[A-Za-z0-9_$]/;
const dollarTag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;
const transactionControl = [
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "ABORT",
  "END",
  "SAVEPOINT",
  "RELEASE",
  "START TRANSACTION",
  "PREPARE TRANSACTION",
];

function skipQuoted(sql: string, from: number, quote: string, backslashEscapes: boolean): number {
  let i = from + 1;
  while (i < sql.length) {
    const char = sql[i];
    if (backslashEscapes && char === "\\") {
      i += 2;
    } else if (char === quote) {
      if (sql[i + 1] !== quote) {
        return i + 1;
      }
      i += 2;
    } else {
      i += 1;
    }
  }
  return sql.length;
}

function skipBlockComment(sql: string, from: number): number {
  let depth = 0;
  let i = from;
  while (i < sql.length) {
    if (sql.startsWith("/*", i)) {
      depth += 1;
      i += 2;
    } else if (sql.startsWith("*/", i)) {
      depth -= 1;
      i += 2;
      if (depth === 0) {
        return i;
      }
    } else {
      i += 1;
    }
  }
  return sql.length;
}

function skipLineComment(sql: string, from: number): number {
  const end = sql.indexOf("\n", from);
  return end === -1 ? sql.length : end + 1;
}

function stripLeadingComments(statement: string): string {
  let rest = statement.trimStart();
  for (;;) {
    if (rest.startsWith("--")) {
      rest = rest.slice(skipLineComment(rest, 0)).trimStart();
    } else if (rest.startsWith("/*")) {
      rest = rest.slice(skipBlockComment(rest, 0)).trimStart();
    } else {
      return rest;
    }
  }
}

function skipDollarQuote(sql: string, from: number): number {
  const tag = dollarTag.exec(sql.slice(from))?.[0];
  if (tag === undefined) {
    return from + 1;
  }
  const close = sql.indexOf(tag, from + tag.length);
  return close === -1 ? sql.length : close + tag.length;
}

function skipToken(sql: string, from: number): number {
  const char = sql[from];
  const previous = sql[from - 1] ?? "";
  if (sql.startsWith("--", from)) {
    return skipLineComment(sql, from);
  }
  if (sql.startsWith("/*", from)) {
    return skipBlockComment(sql, from);
  }
  if (char === "'") {
    const escapeString = /[Ee]/.test(previous) && !identifierChar.test(sql[from - 2] ?? "");
    return skipQuoted(sql, from, "'", escapeString);
  }
  if (char === '"') {
    return skipQuoted(sql, from, '"', false);
  }
  if (char === "$" && !identifierChar.test(previous)) {
    return skipDollarQuote(sql, from);
  }
  return from + 1;
}

function hasContent(statement: string): boolean {
  return stripLeadingComments(statement).replace(/^;/, "").trim() !== "";
}

export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let i = 0;
  while (i <= sql.length) {
    if (i === sql.length || sql[i] === ";") {
      const statement = sql.slice(start, i + 1).trim();
      if (hasContent(statement)) {
        statements.push(statement);
      }
      i += 1;
      start = i;
    } else {
      i = skipToken(sql, i);
    }
  }
  return statements;
}

function transactionControlIn(statements: string[]): string | undefined {
  for (const statement of statements) {
    const words = stripLeadingComments(statement)
      .split(/[\s;(]+/, 2)
      .join(" ")
      .toUpperCase();
    const found = transactionControl.find(
      (keyword) => words === keyword || words.startsWith(`${keyword} `),
    );
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function inspectScript(label: string, sql: string): boolean {
  const firstLine = (sql.replaceAll("\r\n", "\n").split("\n", 1)[0] ?? "").trim();
  const optedOut = firstLine === noTransactionDirective;
  if (!optedOut && firstLine.startsWith(directivePrefix)) {
    throw new MigrationError(`migration ${label} has an unknown directive ${firstLine}`);
  }
  const control = transactionControlIn(splitStatements(sql));
  if (control !== undefined) {
    throw new MigrationError(
      `migration ${label} contains ${control}; the runner manages transactions, use ${noTransactionDirective} on the first line to run a file without one`,
    );
  }
  return !optedOut;
}

export function checksum(sql: string): string {
  return createHash("sha256").update(sql.replaceAll("\r\n", "\n"), "utf8").digest("hex");
}

export async function loadMigrations(dir: string = defaultMigrationsDir): Promise<Migration[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const halves = new Map<number, { name: string; up?: string; down?: string }>();

  for (const entry of entries) {
    if (!(entry.isFile() && entry.name.endsWith(".sql"))) {
      continue;
    }
    const parsed = parseMigrationFileName(entry.name);
    if (!parsed) {
      throw new MigrationError(
        `invalid migration file name ${entry.name}, expected NNNN_snake_name.up.sql or .down.sql`,
      );
    }
    const pair = halves.get(parsed.version) ?? { name: parsed.name };
    if (pair.name !== parsed.name) {
      throw new MigrationError(
        `version ${parsed.version} is used by two names: ${pair.name} and ${parsed.name}`,
      );
    }
    pair[parsed.direction] = await readFile(join(dir, entry.name), "utf8");
    halves.set(parsed.version, pair);
  }

  return [...halves.entries()]
    .sort(([a], [b]) => a - b)
    .map(([version, { name, up, down }]) => {
      if (up === undefined || down === undefined) {
        const missing = up === undefined ? "up" : "down";
        throw new MigrationError(`migration ${version} ${name} has no ${missing} file`);
      }
      return {
        version,
        name,
        up,
        down,
        upChecksum: checksum(up),
        downChecksum: checksum(down),
        upInTransaction: inspectScript(`${version} ${name} (up)`, up),
        downInTransaction: inspectScript(`${version} ${name} (down)`, down),
      };
    });
}

export function verifyHistory(migrations: Migration[], applied: AppliedMigration[]): void {
  const byVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  for (const row of applied) {
    const migration = byVersion.get(row.version);
    if (!migration) {
      throw new MigrationError(`applied migration ${row.version} ${row.name} has no file`);
    }
    if (migration.name !== row.name) {
      throw new MigrationError(
        `applied migration ${row.version} was ${row.name}, the file is now ${migration.name}`,
      );
    }
    if (migration.upChecksum !== row.upChecksum || migration.downChecksum !== row.downChecksum) {
      throw new MigrationError(
        `migration ${row.version} ${row.name} changed after it was applied (checksum mismatch)`,
      );
    }
  }

  const appliedVersions = new Set(applied.map((row) => row.version));
  const highestApplied = Math.max(0, ...appliedVersions);
  const skipped = migrations.find(
    (migration) => migration.version < highestApplied && !appliedVersions.has(migration.version),
  );
  if (skipped) {
    throw new MigrationError(
      `migration ${skipped.version} ${skipped.name} is pending but older than applied version ${highestApplied}`,
    );
  }
}

export function planUp(
  migrations: Migration[],
  applied: AppliedMigration[],
  targetVersion?: number,
): Migration[] {
  verifyHistory(migrations, applied);
  if (targetVersion !== undefined && !migrations.some((m) => m.version === targetVersion)) {
    throw new MigrationError(`no migration with version ${targetVersion}`);
  }
  const appliedVersions = new Set(applied.map((row) => row.version));
  return migrations.filter(
    (migration) =>
      !appliedVersions.has(migration.version) &&
      (targetVersion === undefined || migration.version <= targetVersion),
  );
}

export function planDown(
  migrations: Migration[],
  applied: AppliedMigration[],
  steps: number,
): Migration[] {
  if (!Number.isInteger(steps) || steps < 1) {
    throw new MigrationError(`rollback steps must be a positive integer, got ${steps}`);
  }
  verifyHistory(migrations, applied);
  const byVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  return [...applied]
    .sort((a, b) => b.version - a.version)
    .slice(0, steps)
    .map((row) => byVersion.get(row.version))
    .filter((migration): migration is Migration => migration !== undefined);
}

export function migrationStatus(
  migrations: Migration[],
  applied: AppliedMigration[],
): MigrationStatusRow[] {
  verifyHistory(migrations, applied);
  const appliedVersions = new Set(applied.map((row) => row.version));
  return migrations.map(({ version, name }) => ({
    version,
    name,
    state: appliedVersions.has(version) ? "applied" : "pending",
  }));
}
