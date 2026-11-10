import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as constants from "./constants.ts";
import * as journeys from "./journeys.ts";
import * as search from "./search.ts";
import * as trainDetail from "./train-detail.ts";

describe("constants", () => {
  it("imports nothing, so the page can read paths and limits without the schema library", () => {
    const source = readFileSync(new URL("./constants.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/zod/);
  });

  it("is what the schema modules export under the same names", () => {
    expect(search.SEARCH_PATH).toBe(constants.SEARCH_PATH);
    expect(search.SEARCH_QUERY_MAX).toBe(constants.SEARCH_QUERY_MAX);
    expect(journeys.JOURNEYS_PATH).toBe(constants.JOURNEYS_PATH);
    expect(journeys.JOURNEY_RELIABILITY_TRAINS_MAX).toBe(constants.JOURNEY_RELIABILITY_TRAINS_MAX);
    expect(trainDetail.trainDetailPath("a b")).toBe(constants.trainDetailPath("a b"));
    expect(trainDetail.liveKeyPath(7)).toBe("/api/v1/live/keys/7");
  });
});
