import { describe, expect, it } from "vitest";
import { irisPath } from "./client.ts";
import { evaArg, PROBE_MAX_CALLS, probeCalls } from "./live.ts";

const AT = Date.parse("2026-11-08T05:40:00Z");

describe("IRIS probe", () => {
  it("asks full changes, the plans from the hour before to six hours ahead, and full changes again", () => {
    const paths = probeCalls(AT, 6).map((call) => irisPath(call.endpoint, 8000105, call.at));
    expect(paths).toEqual([
      "/fchg/8000105",
      "/plan/8000105/261108/05",
      "/plan/8000105/261108/06",
      "/plan/8000105/261108/07",
      "/plan/8000105/261108/08",
      "/plan/8000105/261108/09",
      "/plan/8000105/261108/10",
      "/plan/8000105/261108/11",
      "/plan/8000105/261108/12",
      "/fchg/8000105",
    ]);
    expect(paths).toHaveLength(PROBE_MAX_CALLS);
  });

  it("refuses a probe of more than ten calls", () => {
    expect(() => probeCalls(AT, 7)).toThrow(/at most 10 calls/);
    expect(() => probeCalls(AT, -1)).toThrow(/whole number/);
  });

  it("takes only a seven-digit EVA number", () => {
    expect(evaArg("8000105")).toBe(8000105);
    expect(evaArg(" 8098160 ")).toBe(8098160);
    for (const value of [undefined, "", "abc", "800010", "80001050", "8000105/../x", "-800010"]) {
      expect(() => evaArg(value), String(value)).toThrow(/seven-digit/);
    }
  });
});
