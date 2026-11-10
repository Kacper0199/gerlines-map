import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine } from "@secretlint/node";
import { describe, expect, it } from "vitest";
import { mustFail, mustPass, type SecretFixture } from "./secret-fixtures.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

const engine = await createEngine({
  cwd: repoRoot,
  configFilePath: join(repoRoot, ".secretlintrc.json"),
  formatter: "json",
  color: false,
});

function lint(file: string, content: string) {
  return engine.executeOnContent({ content, filePath: join(repoRoot, "fixtures", file) });
}

const byName = (list: readonly SecretFixture[]) =>
  list.map((fixture) => [fixture.name, fixture] as const);

describe("repository secretlint rules", () => {
  it.each(byName(mustFail))("flag %s", async (_name, fixture) => {
    const result = await lint(fixture.file, fixture.content);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("@secretlint/secretlint-rule-pattern");
  });

  it.each(byName(mustPass))("allow %s", async (_name, fixture) => {
    const result = await lint(fixture.file, fixture.content);
    expect(result.ok, result.output).toBe(true);
  });

  it.each([".env.example", "docs/KEYS.md", "docs/development.md", "scripts/check-keys.sh"])(
    "allow the committed %s",
    async (path) => {
      const content = await readFile(join(repoRoot, path), "utf8");
      const result = await lint(path, content);
      expect(result.ok, result.output).toBe(true);
    },
  );
});
