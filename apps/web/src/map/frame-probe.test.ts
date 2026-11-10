import { describe, expect, it } from "vitest";
import type { FrameGroup } from "../motion/frame.ts";
import { nearestTrains } from "./frame-probe.ts";

function group(points: Array<[number, number]>): FrameGroup {
  return {
    hollow: false,
    count: points.length,
    positions: new Float32Array(points.flatMap(([lon, lat]) => [lon, lat, 0])),
    iconAngles: new Float32Array(points.length),
    sizes: new Float32Array(points.length),
    fillColors: new Uint8Array(points.length * 4),
    lineColors: new Uint8Array(points.length * 4),
    ids: undefined,
  };
}

describe("nearestTrains", () => {
  it("lists the trains of every group nearest to a point first, with the ids sent earlier", () => {
    const groups = [
      group([
        [9.0, 50.0],
        [7.7, 50.4],
      ]),
      group([[7.6, 50.5]]),
    ];
    const found = nearestTrains(groups, [["a", "b"], ["c"]], [7.6, 50.4], 2);
    expect(found.map((train) => train.id)).toEqual(["b", "c"]);
    expect(found[0]?.lon).toBeCloseTo(7.7, 4);
  });

  it("skips trains whose id was never sent and stops at the limit", () => {
    const groups = [
      group([[7.6, 50.4]]),
      group([
        [7.6, 50.4],
        [7.6, 50.4],
        [7.6, 50.4],
      ]),
    ];
    expect(nearestTrains(groups, [undefined, ["x", "y", "z"]], [7.6, 50.4], 2)).toHaveLength(2);
    expect(nearestTrains(groups, [], [7.6, 50.4], 5)).toEqual([]);
  });
});
