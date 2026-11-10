import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DB } from "@gerlines/db";
import {
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStore } from "../publish/storage.ts";
import { buildPacks, type ShapeRow } from "./packs.ts";

const EPOCH = 4;

function fakeDb(state: { rows: ShapeRow[] }): Kysely<DB> {
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      const text = query.sql;
      if (text.includes("max(epoch)")) return { rows: [{ epoch: EPOCH }] as R[] };
      if (text.includes("to_regclass('shape_stub')")) return { rows: [{ found: true }] as R[] };
      if (text.includes("FROM shape_pattern s")) {
        const [after, , limit] = query.parameters as number[];
        const rows = state.rows.filter((row) => row.shape_no > (after ?? 0)).slice(0, limit);
        return { rows: rows as R[] };
      }
      throw new Error(`unexpected query ${text}`);
    },
    // biome-ignore lint/correctness/useYield: the build never streams
    async *streamQuery() {
      throw new Error("not streamed");
    },
  };
  const driver: Driver = {
    async init() {},
    async acquireConnection() {
      return connection;
    },
    async beginTransaction() {},
    async commitTransaction() {},
    async rollbackTransaction() {},
    async releaseConnection() {},
    async destroy() {},
  };
  return new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

const line = [
  [10, 50, 100, 0],
  [10.001, 50, 100, 71.6],
  [10.002, 50, 100, 143.3],
];
const east = [
  [10.002, 50, 100, 0],
  [10.003, 50, 100, 71.6],
];
const shape = (shapeNo: number, hash: string, stubs: ShapeRow["stubs"] = null): ShapeRow => ({
  shape_no: shapeNo,
  shape_hash: hash.repeat(64),
  elevation_source: null,
  tunnel_spans: [],
  stop_arc_m: [0, 143.3],
  points: line,
  stubs,
});

describe("buildPacks republishing into a held epoch", () => {
  let dir: string;
  let store: FileStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gerlines-packs-"));
    store = new FileStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps the held packs and completes a second timetable version of the same shapes", async () => {
    const db = fakeDb({ rows: [shape(1, "a"), shape(2, "b", [{ side: "after", points: east }])] });
    const first = await buildPacks(db, store, { timetableVersion: 1 });
    expect([first.written, first.complete]).toEqual([2, true]);

    const second = await buildPacks(db, store, { timetableVersion: 2 });
    expect(second).toMatchObject({ written: 0, unchanged: 2, stale: 0, failed: 0 });
    expect(second.complete).toBe(true);
    expect(await store.hasPacks(EPOCH, 2)).toBe(true);
  });

  it("refuses a held pack whose content changed, without marking the version complete", async () => {
    await buildPacks(fakeDb({ rows: [shape(1, "a")] }), store, { timetableVersion: 1 });
    const withStub = fakeDb({ rows: [shape(1, "a", [{ side: "after", points: east }])] });

    const report = await buildPacks(withStub, store, { timetableVersion: 2 });
    expect(report).toMatchObject({ stale: 1, unchanged: 0, complete: false });
    expect(report.failures[0]).toContain("register a new shape epoch");
    expect(await store.hasPacks(EPOCH, 2)).toBe(false);
  });

  it("stops when a held number names another hash", async () => {
    await buildPacks(fakeDb({ rows: [shape(1, "a")] }), store, { timetableVersion: 1 });
    await expect(
      buildPacks(fakeDb({ rows: [shape(1, "c")] }), store, { timetableVersion: 2 }),
    ).rejects.toThrow("refusing to publish");
  });
});
