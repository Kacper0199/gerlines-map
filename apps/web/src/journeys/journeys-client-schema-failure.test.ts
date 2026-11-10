import { describe, expect, it, vi } from "vitest";
import { fetchJourneys, fetchReliability } from "./journeys-client.ts";

vi.mock("@gerlines/schema/journeys", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

const ok = async () => new Response(JSON.stringify({}), { status: 200 });

describe("the journey fetchers when the schema chunk does not load", () => {
  it("fetchJourneys answers unavailable instead of rejecting", async () => {
    await expect(
      fetchJourneys(
        { from: "a", to: "b", time: null, arriveBy: false, categories: null, operator: null },
        { fetch: ok },
      ),
    ).resolves.toEqual({ kind: "error", error: "unavailable" });
  });

  it("fetchReliability answers an error instead of rejecting", async () => {
    await expect(fetchReliability(["ld~1"], { fetch: ok })).resolves.toEqual({ kind: "error" });
  });
});
