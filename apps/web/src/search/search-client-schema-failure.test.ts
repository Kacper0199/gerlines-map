import { describe, expect, it, vi } from "vitest";
import { fetchSearch, fetchStation } from "./search-client.ts";

vi.mock("@gerlines/schema/search", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

const ok = async () => new Response(JSON.stringify({}), { status: 200 });

describe("the search fetchers when the schema chunk does not load", () => {
  it("fetchSearch answers an error instead of rejecting", async () => {
    await expect(fetchSearch("fra", "en", { fetch: ok })).resolves.toEqual({ kind: "error" });
  });

  it("fetchStation answers an error instead of rejecting", async () => {
    await expect(fetchStation("a", { fetch: ok })).resolves.toEqual({ kind: "error" });
  });
});
