import { describe, expect, it } from "vitest";
import { RouteReveal } from "./route-reveal.ts";

const M_PER_DEGREE_LAT = 111_195;

function route(...points: [number, number, number][]): Float32Array {
  return Float32Array.from(points.flat());
}

const AHEAD = route([10, 50, 0], [10, 50.01, 0], [10, 50.03, 0], [10, 50.06, 0]);
const TOTAL = 0.06 * M_PER_DEGREE_LAT;

describe("RouteReveal", () => {
  it("measures the route ahead in metres along its vertices", () => {
    expect(new RouteReveal().totalMetres(AHEAD)).toBeCloseTo(TOTAL, -1);
  });

  it("returns the whole route once the revealed length reaches its end", () => {
    const reveal = new RouteReveal();
    expect(reveal.prefix(AHEAD, TOTAL + 1)).toBe(AHEAD);
  });

  it("cuts the route at the revealed length with the end point on the shape", () => {
    const reveal = new RouteReveal();
    const cut = reveal.prefix(AHEAD, 0.02 * M_PER_DEGREE_LAT);
    expect(cut.length).toBe(9);
    expect(Array.from(cut.subarray(0, 6)).map((v) => Math.round(v * 1e4) / 1e4)).toEqual([
      10, 50, 0, 10, 50.01, 0,
    ]);
    expect(cut[6]).toBeCloseTo(10, 5);
    expect(cut[7]).toBeCloseTo(50.02, 4);
  });

  it("keeps the cut on the segment of the shape it falls in, with the height interpolated", () => {
    const reveal = new RouteReveal();
    const heights = route([10, 50, 100], [10, 50.01, 100], [10, 50.03, 300], [10, 50.06, 300]);
    const cut = reveal.prefix(heights, 0.02 * M_PER_DEGREE_LAT);
    expect(cut[8]).toBeCloseTo(200, 0);
  });

  it("draws a zero length as the train point alone, so the selected marker keeps its route", () => {
    const cut = new RouteReveal().prefix(AHEAD, 0);
    expect(Array.from(cut)).toEqual([10, 50, 0, 10, 50, 0]);
  });

  it("never reveals backwards as the length grows", () => {
    const reveal = new RouteReveal();
    let previous = 0;
    for (let metres = 0; metres <= TOTAL; metres += TOTAL / 40) {
      const cut = reveal.prefix(AHEAD, metres);
      const tipLat = cut[cut.length - 2] as number;
      expect(tipLat).toBeGreaterThanOrEqual(previous - 1e-6);
      previous = tipLat;
    }
  });

  it("follows the train point at the head while the same route array is reused", () => {
    const reveal = new RouteReveal();
    const ahead = AHEAD.slice();
    reveal.prefix(ahead, 1000);
    ahead[1] = 50.002;
    const cut = reveal.prefix(ahead, 1000);
    expect(cut[1]).toBeCloseTo(50.002, 5);
  });

  it("handles a route with a single point", () => {
    const one = route([10, 50, 0]);
    expect(new RouteReveal().prefix(one, 500)).toBe(one);
  });

  it("measures a route ahead of two points, the last segment of a shape", () => {
    const two = route([10, 50, 0], [10, 50.01, 0]);
    const reveal = new RouteReveal();
    expect(reveal.totalMetres(two)).toBeCloseTo(0.01 * M_PER_DEGREE_LAT, -1);
    const cut = reveal.prefix(two, 0.005 * M_PER_DEGREE_LAT);
    expect(Array.from(cut).every(Number.isFinite)).toBe(true);
    expect(cut[4]).toBeCloseTo(50.005, 4);
    expect(reveal.prefix(two, 2000)).toBe(two);
  });
});
