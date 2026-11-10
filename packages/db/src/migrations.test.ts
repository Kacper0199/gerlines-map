import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AppliedMigration,
  checksum,
  loadMigrations,
  type Migration,
  migrationStatus,
  parseMigrationFileName,
  planDown,
  planUp,
  splitStatements,
  verifyHistory,
} from "./migrations.ts";

function migration(version: number, name = `step_${version}`): Migration {
  const up = `CREATE TABLE t${version} (id int);`;
  const down = `DROP TABLE t${version};`;
  return {
    version,
    name,
    up,
    down,
    upChecksum: checksum(up),
    downChecksum: checksum(down),
    upInTransaction: true,
    downInTransaction: true,
  };
}

function appliedFrom(m: Migration): AppliedMigration {
  return {
    version: m.version,
    name: m.name,
    upChecksum: m.upChecksum,
    downChecksum: m.downChecksum,
  };
}

const three = [migration(1), migration(2), migration(3)];

describe("parseMigrationFileName", () => {
  it.each([
    ["0001_extensions.up.sql", { version: 1, name: "extensions", direction: "up" }],
    ["0042_id_map.down.sql", { version: 42, name: "id_map", direction: "down" }],
    ["9999_a1_b2.up.sql", { version: 9999, name: "a1_b2", direction: "up" }],
  ])("parses %s", (fileName, expected) => {
    expect(parseMigrationFileName(fileName)).toEqual(expected);
  });

  it.each([
    "0000_zero.up.sql",
    "001_short.up.sql",
    "0001_Upper.up.sql",
    "0001_dash-name.up.sql",
    "0001_trailing_.up.sql",
    "0001_name.sideways.sql",
    "0001_name.up.SQL",
    "0001_.up.sql",
  ])("rejects %s", (fileName) => {
    expect(parseMigrationFileName(fileName)).toBeNull();
  });
});

describe("checksum", () => {
  it("is the lowercase sha256 hex of the content", () => {
    expect(checksum("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("treats CRLF and LF line endings as the same content", () => {
    expect(checksum("SELECT 1;\r\nSELECT 2;\r\n")).toBe(checksum("SELECT 1;\nSELECT 2;\n"));
  });

  it("changes when the content changes", () => {
    expect(checksum("SELECT 1;")).not.toBe(checksum("SELECT 2;"));
  });
});

describe("splitStatements", () => {
  it("splits on semicolons and keeps each statement with its terminator", () => {
    expect(splitStatements("CREATE TABLE a (id int);\nDROP TABLE b;\n")).toEqual([
      "CREATE TABLE a (id int);",
      "DROP TABLE b;",
    ]);
  });

  it("keeps a last statement without a semicolon", () => {
    expect(splitStatements("SELECT 1;\nSELECT 2\n")).toEqual(["SELECT 1;", "SELECT 2"]);
  });

  it("drops parts that hold only comments or whitespace", () => {
    expect(splitStatements("-- header\n;\n/* note */\nSELECT 1;\n-- trailing\n")).toEqual([
      "/* note */\nSELECT 1;",
    ]);
  });

  it.each([
    ["a string literal", "SELECT 'a;b''c;';", ["SELECT 'a;b''c;';"]],
    ["an escape string", "SELECT E'it\\'s;';", ["SELECT E'it\\'s;';"]],
    ["a quoted identifier", 'SELECT 1 AS "x;""y";', ['SELECT 1 AS "x;""y";']],
    ["a line comment", "SELECT 1 -- not; here\n;", ["SELECT 1 -- not; here\n;"]],
    ["a nested block comment", "SELECT /* a /* b; */ c; */ 1;", ["SELECT /* a /* b; */ c; */ 1;"]],
    [
      "a dollar-quoted body",
      "CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $fn$ BEGIN RETURN 1; END $fn$;",
      ["CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $fn$ BEGIN RETURN 1; END $fn$;"],
    ],
    [
      "an anonymous dollar quote",
      "DO $$ BEGIN PERFORM 1; END $$;",
      ["DO $$ BEGIN PERFORM 1; END $$;"],
    ],
  ])("ignores semicolons inside %s", (_name, sql, expected) => {
    expect(splitStatements(sql)).toEqual(expected);
  });

  it("does not take a positional parameter for a dollar quote", () => {
    expect(splitStatements("PREPARE p AS SELECT $1;\nSELECT 2;")).toEqual([
      "PREPARE p AS SELECT $1;",
      "SELECT 2;",
    ]);
  });
});

describe("loadMigrations", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gerlines-migrations-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function files(entries: Record<string, string>): Promise<void> {
    for (const [name, content] of Object.entries(entries)) {
      await writeFile(join(dir, name), content);
    }
  }

  it("pairs up and down files and sorts them by version", async () => {
    await files({
      "0002_second.up.sql": "B",
      "0002_second.down.sql": "b",
      "0001_first.down.sql": "a",
      "0001_first.up.sql": "A",
      "README.md": "ignored",
    });
    const loaded = await loadMigrations(dir);
    expect(loaded.map(({ version, name, up, down }) => ({ version, name, up, down }))).toEqual([
      { version: 1, name: "first", up: "A", down: "a" },
      { version: 2, name: "second", up: "B", down: "b" },
    ]);
    expect(loaded[0]?.upChecksum).toBe(checksum("A"));
    expect(loaded[0]?.downChecksum).toBe(checksum("a"));
  });

  it("returns an empty list for a folder without migrations", async () => {
    expect(await loadMigrations(dir)).toEqual([]);
  });

  it("rejects a migration without a down file", async () => {
    await files({ "0001_first.up.sql": "A" });
    await expect(loadMigrations(dir)).rejects.toThrow(/migration 1 first has no down file/);
  });

  it("rejects a migration without an up file", async () => {
    await files({ "0001_first.down.sql": "a" });
    await expect(loadMigrations(dir)).rejects.toThrow(/migration 1 first has no up file/);
  });

  it("rejects two names for one version", async () => {
    await files({ "0001_first.up.sql": "A", "0001_other.down.sql": "a" });
    await expect(loadMigrations(dir)).rejects.toThrow(/version 1 is used by two names/);
  });

  it("rejects an SQL file with an invalid name", async () => {
    await files({ "1_first.up.sql": "A" });
    await expect(loadMigrations(dir)).rejects.toThrow(/invalid migration file name 1_first.up.sql/);
  });

  it("runs a file in a transaction unless its first line opts out", async () => {
    await files({
      "0001_first.up.sql": "-- gerlines:no-transaction\nCREATE INDEX CONCURRENTLY i ON t (c);\n",
      "0001_first.down.sql": "DROP INDEX i;\n",
    });
    const [loaded] = await loadMigrations(dir);
    expect(loaded).toMatchObject({ upInTransaction: false, downInTransaction: true });
  });

  it("treats the opt-out further down the file as an ordinary comment", async () => {
    await files({
      "0001_first.up.sql": "SELECT 1;\n-- gerlines:no-transaction\n",
      "0001_first.down.sql": "SELECT 1;\n",
    });
    const [loaded] = await loadMigrations(dir);
    expect(loaded?.upInTransaction).toBe(true);
  });

  it("rejects an unknown gerlines directive", async () => {
    await files({
      "0001_first.up.sql": "-- gerlines:no-transactions\nSELECT 1;\n",
      "0001_first.down.sql": "SELECT 1;\n",
    });
    await expect(loadMigrations(dir)).rejects.toThrow(
      /migration 1 first \(up\) has an unknown directive -- gerlines:no-transactions/,
    );
  });

  it.each([
    ["BEGIN", "BEGIN;\nCREATE TABLE t (id int);\nCOMMIT;\n"],
    ["COMMIT", "CREATE TABLE t (id int);\ncommit;\n"],
    ["ROLLBACK", "SELECT 1;\nROLLBACK;\n"],
    ["START TRANSACTION", "start  transaction;\nSELECT 1;\n"],
    ["END", "SELECT 1;\n-- done\nEND;\n"],
    ["SAVEPOINT", "SAVEPOINT s;\n"],
  ])("rejects a file that contains %s", async (keyword, sql) => {
    await files({ "0001_first.up.sql": "SELECT 1;\n", "0001_first.down.sql": sql });
    await expect(loadMigrations(dir)).rejects.toThrow(
      new RegExp(`migration 1 first \\(down\\) contains ${keyword}`),
    );
  });

  it("rejects transaction control in a file that opts out of the transaction", async () => {
    await files({
      "0001_first.up.sql": "-- gerlines:no-transaction\nSELECT 1;\nCOMMIT;\n",
      "0001_first.down.sql": "SELECT 1;\n",
    });
    await expect(loadMigrations(dir)).rejects.toThrow(/\(up\) contains COMMIT/);
  });

  it("accepts BEGIN and END inside a function body", async () => {
    await files({
      "0001_first.up.sql":
        "CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$\nBEGIN\n  RETURN NEW;\nEND\n$$;\n",
      "0001_first.down.sql": "DROP FUNCTION f();\n",
    });
    await expect(loadMigrations(dir)).resolves.toHaveLength(1);
  });

  it("loads the committed migrations of this package", async () => {
    const committed = await loadMigrations();
    expect(committed.map(({ version, name }) => `${version} ${name}`)).toEqual([
      "1 extensions",
      "2 provenance",
      "3 stops",
      "4 id_map",
      "5 recording",
      "6 observed_at",
      "10 catalog",
      "11 timetable",
      "20 shape_pattern",
      "21 trip_pattern_shape",
      "30 realtime",
      "40 catalog_seeds",
      "41 realtime_live",
      "50 live",
      "55 train_detail",
      "56 livery_roles",
      "57 shape_registry_append_only",
      "60 land",
      "61 stat_functions",
      "62 stat_level1",
      "63 rollups",
      "64 rollups_threshold",
      "65 shape_stub",
      "66 land_rollups",
      "85 formation_observation",
      "86 fleet_rule",
      "87 backfill",
      "89 vehicle_photo",
      "91 formation_observation_day",
      "92 stop_place_search_name",
      "95 rollup_columnstore",
      "96 history_archive",
      "97 photo_pick_prefix",
    ]);
  });
});

describe("0064 rollups_threshold", () => {
  it("sets a threshold on both level-1 sources in its first two statements", async () => {
    const found = (await loadMigrations()).find(({ version }) => version === 64);
    const refreshed = splitStatements(found?.up ?? "")
      .slice(0, 2)
      .map((statement) => /refresh_continuous_aggregate\('(\w+)'/.exec(statement)?.[1]);
    expect(refreshed).toEqual(["station_day", "segment_day"]);
  });
});

describe("verifyHistory", () => {
  it("accepts an empty history", () => {
    expect(() => verifyHistory(three, [])).not.toThrow();
  });

  it("accepts a history that matches the files", () => {
    expect(() => verifyHistory(three, three.slice(0, 2).map(appliedFrom))).not.toThrow();
  });

  it("rejects an applied migration whose file is gone", () => {
    expect(() => verifyHistory(three.slice(0, 1), three.slice(0, 2).map(appliedFrom))).toThrow(
      /applied migration 2 step_2 has no file/,
    );
  });

  it("rejects an applied migration that was renamed", () => {
    const applied = [{ ...appliedFrom(migration(1)), name: "old_name" }];
    expect(() => verifyHistory(three, applied)).toThrow(/was old_name, the file is now step_1/);
  });

  it("rejects an up file that changed after it was applied", () => {
    const applied = [{ ...appliedFrom(migration(1)), upChecksum: checksum("other") }];
    expect(() => verifyHistory(three, applied)).toThrow(/changed after it was applied/);
  });

  it("rejects a down file that changed after it was applied", () => {
    const applied = [{ ...appliedFrom(migration(1)), downChecksum: checksum("other") }];
    expect(() => verifyHistory(three, applied)).toThrow(/changed after it was applied/);
  });

  it("rejects a pending migration older than the newest applied one", () => {
    const applied = [appliedFrom(migration(1)), appliedFrom(migration(3))];
    expect(() => verifyHistory(three, applied)).toThrow(
      /migration 2 step_2 is pending but older than applied version 3/,
    );
  });
});

describe("planUp", () => {
  it("plans every pending migration in ascending order", () => {
    expect(planUp(three, [appliedFrom(migration(1))]).map((m) => m.version)).toEqual([2, 3]);
  });

  it("stops at the target version", () => {
    expect(planUp(three, [], 2).map((m) => m.version)).toEqual([1, 2]);
  });

  it("plans nothing when everything is applied", () => {
    expect(planUp(three, three.map(appliedFrom))).toEqual([]);
  });

  it("rejects an unknown target version", () => {
    expect(() => planUp(three, [], 7)).toThrow(/no migration with version 7/);
  });

  it("verifies the history before planning", () => {
    const applied = [{ ...appliedFrom(migration(1)), upChecksum: checksum("other") }];
    expect(() => planUp(three, applied)).toThrow(/checksum mismatch/);
  });
});

describe("planDown", () => {
  it("plans the newest applied migrations in descending order", () => {
    expect(planDown(three, three.map(appliedFrom), 2).map((m) => m.version)).toEqual([3, 2]);
  });

  it("plans at most the applied migrations", () => {
    expect(planDown(three, [appliedFrom(migration(1))], 5).map((m) => m.version)).toEqual([1]);
  });

  it("plans nothing when nothing is applied", () => {
    expect(planDown(three, [], 1)).toEqual([]);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects %s steps", (steps) => {
    expect(() => planDown(three, [], steps)).toThrow(/positive integer/);
  });

  it("verifies the history before planning", () => {
    const applied = [{ ...appliedFrom(migration(1)), downChecksum: checksum("other") }];
    expect(() => planDown(three, applied, 1)).toThrow(/checksum mismatch/);
  });
});

describe("migrationStatus", () => {
  it("marks each migration applied or pending", () => {
    expect(migrationStatus(three, [appliedFrom(migration(1))])).toEqual([
      { version: 1, name: "step_1", state: "applied" },
      { version: 2, name: "step_2", state: "pending" },
      { version: 3, name: "step_3", state: "pending" },
    ]);
  });
});
