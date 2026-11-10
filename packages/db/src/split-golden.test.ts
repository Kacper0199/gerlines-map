import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultMigrationsDir, splitStatements } from "./migrations.ts";

interface SplitCase {
  name: string;
  sql: string;
  statements: string[];
}

interface SplitGolden {
  cases: SplitCase[];
  files: Record<string, string[]>;
}

const goldenPath = fileURLToPath(new URL("./split-golden.json", import.meta.url));

function digest(statement: string): string {
  return createHash("sha256").update(statement, "utf8").digest("hex");
}

async function committedSplits(): Promise<Record<string, string[]>> {
  const names = (await readdir(defaultMigrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const files: Record<string, string[]> = {};
  for (const name of names) {
    const sql = await readFile(join(defaultMigrationsDir, name), "utf8");
    files[name] = splitStatements(sql).map(digest);
  }
  return files;
}

describe("the statement split shared with gerlines_common.migrations", async () => {
  const golden = JSON.parse(await readFile(goldenPath, "utf8")) as SplitGolden;
  const files = await committedSplits();

  if (process.env.GERLINES_UPDATE_SPLIT_GOLDEN === "1") {
    const cases = golden.cases.map((item) => ({ ...item, statements: splitStatements(item.sql) }));
    await writeFile(goldenPath, `${JSON.stringify({ cases, files }, null, 2)}\n`);
    golden.cases = cases;
    golden.files = files;
  }

  it.each(golden.cases)("splits $name as recorded", ({ sql, statements }) => {
    expect(splitStatements(sql)).toEqual(statements);
  });

  it("records the statements of every committed migration file", () => {
    expect(Object.keys(files).length).toBeGreaterThan(40);
    expect(files).toEqual(golden.files);
  });
});
