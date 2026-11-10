import { describe, expect, it } from "vitest";
import { assertThrowawayDatabase, databaseNameOf } from "./database-guard.ts";

const url = (path: string) => `postgresql://user:secret@127.0.0.1:5433/${path}`;

describe("databaseNameOf", () => {
  it("reads the name as pg does, decoding percent escapes", () => {
    expect(databaseNameOf(url("gerlines_wp23"))).toBe("gerlines_wp23");
    expect(databaseNameOf(url("%67erlines"))).toBe("gerlines");
    expect(databaseNameOf(url("%67erlines?sslmode=disable"))).toBe("gerlines");
    expect(databaseNameOf(url("gerlines_wp23?database=gerlines"))).toBe("gerlines_wp23");
    expect(databaseNameOf(url(""))).toBeNull();
  });
});

describe("assertThrowawayDatabase", () => {
  it("accepts builder databases", () => {
    for (const name of ["gerlines_wp23", "gerlines_wp23b", "gerlines_rt", "gerlines_test_1"]) {
      expect(() => assertThrowawayDatabase(name, false)).not.toThrow();
    }
  });

  it("refuses the shared database however its name is spelled", () => {
    expect(() => assertThrowawayDatabase(databaseNameOf(url("%67erlines")), false)).toThrow(
      /--allow-shared/,
    );
    expect(() => assertThrowawayDatabase("gerlines", false)).toThrow(/--allow-shared/);
  });

  it("refuses names without a builder suffix and a missing name", () => {
    for (const name of [
      "postgres",
      "gerlines_",
      "Gerlines_wp23",
      "gerlines_prod",
      "%67erlines",
      null,
    ]) {
      expect(() => assertThrowawayDatabase(name, false)).toThrow();
    }
  });

  it("accepts any named database when the shared one is allowed on purpose", () => {
    expect(() => assertThrowawayDatabase("gerlines", true)).not.toThrow();
    expect(() => assertThrowawayDatabase(null, true)).toThrow();
  });
});
