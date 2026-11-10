import { describe, expect, it, vi } from "vitest";

describe("schema loaders", () => {
  it("warms every schema module once and swallows a failing load", async () => {
    vi.resetModules();
    const loaded: string[] = [];
    vi.doMock("@gerlines/schema/search", () => {
      loaded.push("search");
      return {};
    });
    vi.doMock("@gerlines/schema/journeys", () => {
      loaded.push("journeys");
      throw new Error("offline");
    });
    vi.doMock("@gerlines/schema", () => {
      loaded.push("train");
      return {};
    });
    const { warmSchemas } = await import("./schema-loaders.ts");
    expect(() => warmSchemas()).not.toThrow();
    await vi.waitFor(() => expect(loaded.sort()).toEqual(["journeys", "search", "train"]));
  });
});
