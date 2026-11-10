import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { adaptGtfsRt, profileFor } from "./adapters.ts";

interface Fixture {
  readonly name: string;
  readonly source: string;
  readonly observedAt: string;
  readonly entities: number;
  readonly sha256: string;
}

const dir = new URL("../../test/fixtures/realtime/", import.meta.url);
const fixtures = JSON.parse(readFileSync(new URL("fixtures.json", dir), "utf8")) as Fixture[];
const update = process.env.UPDATE_GOLDEN === "1";

describe("realtime adapters over recorded fixtures", () => {
  it.each(fixtures.map((fixture) => [fixture.name, fixture] as const))(
    "%s gives its golden events",
    (_name, fixture) => {
      const bytes = readFileSync(new URL(fixture.name, dir));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(fixture.sha256);
      const profile = profileFor(fixture.source);
      if (!profile) throw new Error(`no profile for ${fixture.source}`);
      const result = adaptGtfsRt(bytes, Date.parse(fixture.observedAt), profile);
      if (!result.ok) throw new Error(result.failure.error);
      expect(result.events.length).toBeGreaterThanOrEqual(fixture.entities);
      const golden = new URL(`${fixture.name}.golden.json`, dir);
      const actual = `${JSON.stringify(result, null, 2)}\n`;
      if (update || !existsSync(golden)) writeFileSync(golden, actual);
      expect(actual).toBe(readFileSync(golden, "utf8"));
    },
  );
});
