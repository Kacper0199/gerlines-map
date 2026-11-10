import { describe, expect, it } from "vitest";
import vectors from "../test-vectors/user-agent.json" with { type: "json" };
import { userAgent } from "./user-agent.ts";

const base = { appName: "gerlines", version: "0.1.0", contact: "trains@example.org" };

describe("userAgent", () => {
  it.each(vectors.valid)("formats $appName $version $contact", ({ expected, ...parts }) => {
    expect(userAgent(parts)).toBe(expected);
  });

  it.each(vectors.invalidAppName)("rejects app name %j", (appName) => {
    expect(() => userAgent({ ...base, appName })).toThrow(/app name/);
  });

  it.each(vectors.invalidVersion)("rejects version %j", (version) => {
    expect(() => userAgent({ ...base, version })).toThrow(/version/);
  });

  it.each(vectors.invalidContact)("rejects contact %j", (contact) => {
    expect(() => userAgent({ ...base, contact })).toThrow(/contact/);
  });
});
