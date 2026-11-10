import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { isUnreachableError } from "./probe.ts";

function errorWithCode(code: string, message = `connect ${code}`): Error {
  return Object.assign(new Error(message), { code });
}

describe("isUnreachableError", () => {
  it.each(["ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH"])("treats %s as unreachable", (code) => {
    expect(isUnreachableError(errorWithCode(code))).toBe(true);
  });

  it("treats the pg connection timeout as unreachable", () => {
    expect(isUnreachableError(new Error("timeout expired"))).toBe(true);
  });

  it("treats an AggregateError of refused addresses as unreachable", () => {
    const error = new AggregateError(
      [errorWithCode("ECONNREFUSED"), errorWithCode("ECONNREFUSED")],
      "",
    );
    expect(isUnreachableError(error)).toBe(true);
  });

  it.each([
    ["wrong password", errorWithCode("28P01", "password authentication failed")],
    ["missing database", errorWithCode("3D000", "database does not exist")],
    ["missing role", errorWithCode("28000", "role does not exist")],
    ["unknown host", errorWithCode("ENOTFOUND")],
    ["protocol error", new Error("Connection terminated unexpectedly")],
    ["mixed AggregateError", new AggregateError([errorWithCode("ECONNREFUSED"), new Error("x")])],
    ["empty AggregateError", new AggregateError([])],
    ["non-error value", "ECONNREFUSED"],
  ])("does not treat a %s as unreachable", (_name, error) => {
    expect(isUnreachableError(error)).toBe(false);
  });
});

describe("package scripts", () => {
  it("load the root .env in every script that talks to the database", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };
    const databaseScripts = Object.entries(manifest.scripts).filter(
      ([name]) => name.startsWith("db:") || name === "test:integration",
    );
    expect(databaseScripts.map(([name]) => name)).toContain("test:integration");
    for (const [, command] of databaseScripts) {
      expect(command).toMatch(/^node --env-file-if-exists=\.\.\/\.\.\/\.env /);
    }
  });
});
