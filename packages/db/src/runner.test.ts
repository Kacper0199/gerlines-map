import { describe, expect, it } from "vitest";
import { checksum, type Migration, MigrationError } from "./migrations.ts";
import { applyMigration, migrationTable } from "./runner.ts";

function migration(up: string, down: string, inTransaction = true): Migration {
  return {
    version: 7,
    name: "probe",
    up,
    down,
    upChecksum: checksum(up),
    downChecksum: checksum(down),
    upInTransaction: inTransaction,
    downInTransaction: inTransaction,
  };
}

function fakeClient(fail: Partial<Record<string, Error>> = {}) {
  const queries: string[] = [];
  return {
    queries,
    async query(text: string): Promise<unknown> {
      const label = text.trim().split(/\s+/, 3).join(" ");
      queries.push(label);
      const error = fail[label];
      if (error) {
        throw error;
      }
      return { rows: [] };
    },
  };
}

describe("applyMigration in a transaction", () => {
  it("runs the file and its history row between BEGIN and COMMIT", async () => {
    const client = fakeClient();
    await applyMigration(client, migration("CREATE TABLE a (id int);", "DROP TABLE a;"), "up");
    expect(client.queries).toEqual([
      "BEGIN",
      "CREATE TABLE a",
      `INSERT INTO ${migrationTable}`,
      "COMMIT",
    ]);
  });

  it("reports the migration error when ROLLBACK fails too", async () => {
    const client = fakeClient({
      "CREATE TABLE a": new Error("syntax error at end of input"),
      ROLLBACK: new Error("Connection terminated"),
    });
    const run = applyMigration(client, migration("CREATE TABLE a", "DROP TABLE a;"), "up");
    await expect(run).rejects.toBeInstanceOf(MigrationError);
    await expect(run).rejects.toThrow(/migration 7 probe \(up\) failed: syntax error/);
  });
});

describe("applyMigration without a transaction", () => {
  const sql = "CREATE TABLE a (id int);\nCREATE INDEX CONCURRENTLY a_idx ON a (id);\n";

  it("runs each statement on its own, then writes the history row in a transaction", async () => {
    const client = fakeClient();
    await applyMigration(client, migration(sql, "DROP TABLE a;", false), "up");
    expect(client.queries).toEqual([
      "CREATE TABLE a",
      "CREATE INDEX CONCURRENTLY",
      "BEGIN",
      `INSERT INTO ${migrationTable}`,
      "COMMIT",
    ]);
  });

  it("removes the history row after a down file without a transaction", async () => {
    const client = fakeClient();
    await applyMigration(client, migration(sql, "DROP INDEX CONCURRENTLY a_idx;", false), "down");
    expect(client.queries).toEqual([
      "DROP INDEX CONCURRENTLY",
      "BEGIN",
      `DELETE FROM ${migrationTable}`,
      "COMMIT",
    ]);
  });

  it("stops at the failing statement, writes no history row and names what stays applied", async () => {
    const client = fakeClient({
      "CREATE INDEX CONCURRENTLY": new Error("relation does not exist"),
    });
    await expect(
      applyMigration(client, migration(sql, "DROP TABLE a;", false), "up"),
    ).rejects.toThrow(
      /migration 7 probe \(up\) failed at statement 2 of 2 without a transaction: relation does not exist; statements 1 to 1 stay applied/,
    );
    expect(client.queries).toEqual(["CREATE TABLE a", "CREATE INDEX CONCURRENTLY"]);
  });
});
