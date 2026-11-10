import { describe, expect, it } from "vitest";
import type { StaticRun } from "../model.ts";
import { AvailableFrom, parseAvailability } from "./available.ts";
import type { FeedVersionInfo, TimetableSource } from "./loader.ts";

const V1: FeedVersionInfo = {
  feedVersionId: 1,
  publishedOn: "2026-10-19",
  validFrom: null,
  validTo: null,
};
const V2: FeedVersionInfo = { ...V1, feedVersionId: 2, publishedOn: "2026-11-02" };

class Inner implements TimetableSource {
  async versions() {
    return [V1, V2];
  }
  async runsOn(): Promise<readonly StaticRun[]> {
    return [];
  }
  async shapeCoverage() {
    return { coverage: 1, runs: 0 };
  }
  async placeCoordinates() {
    return new Map([["p", { lon: 8, lat: 50 }]]);
  }
}

describe("AvailableFrom", () => {
  it("hides a version until the clock reaches its availability", async () => {
    let now = Date.parse("2026-11-06T00:00:00Z") / 1000;
    const at = Date.parse("2026-11-06T00:30:00Z") / 1000;
    const source = new AvailableFrom(new Inner(), new Map([[2, at]]), () => now);
    expect((await source.versions()).map((v) => v.feedVersionId)).toEqual([1]);
    now = at;
    expect((await source.versions()).map((v) => v.feedVersionId)).toEqual([1, 2]);
    expect(await source.shapeCoverage(2, "2026-11-06")).toEqual({ coverage: 1, runs: 0 });
    expect(await source.placeCoordinates()).toEqual(new Map([["p", { lon: 8, lat: 50 }]]));
  });

  it("hides a version it names no instant for when unlisted versions are hidden", async () => {
    const at = Date.parse("2026-11-06T00:30:00Z") / 1000;
    const source = new AvailableFrom(
      new Inner(),
      new Map([[1, at]]),
      () => at,
      Number.POSITIVE_INFINITY,
    );
    expect((await source.versions()).map((v) => v.feedVersionId)).toEqual([1]);
  });

  it("parses id=instant pairs and refuses anything else", () => {
    expect(parseAvailability(["2=2026-11-06T00:30:00Z"])).toEqual(
      new Map([[2, Date.parse("2026-11-06T00:30:00Z") / 1000]]),
    );
    expect(() => parseAvailability(["2"])).toThrow(/ID=ISO/);
    expect(() => parseAvailability(["x=2026-11-06T00:30:00Z"])).toThrow(/ID=ISO/);
    expect(() => parseAvailability(["2=yesterday"])).toThrow(/ID=ISO/);
  });
});
