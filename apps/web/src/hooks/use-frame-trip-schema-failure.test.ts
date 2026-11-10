import { describe, expect, it, vi } from "vitest";
import { fetchTripOfKey } from "./use-frame-trip.ts";

vi.mock("@gerlines/schema", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

describe("fetchTripOfKey when the schema chunk does not load", () => {
  it("answers an error instead of rejecting", async () => {
    const fetch = async () =>
      new Response(JSON.stringify({ tripInstanceId: "x" }), { status: 200 });
    await expect(fetchTripOfKey(7, { fetch })).resolves.toEqual({ kind: "error" });
  });
});
