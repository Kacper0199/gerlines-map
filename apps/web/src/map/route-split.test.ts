import { describe, expect, it } from "vitest";
import { RouteSplitter, routeBounds, splitRoute, splitRoute3d } from "./route-split.ts";

const PATH = Float32Array.from([0, 0, 1, 0, 2, 0, 3, 0]);

describe("splitRoute", () => {
  it("ends the travelled part at the train and starts the route ahead there", () => {
    const { passed, ahead } = splitRoute(PATH, 1, 1.5, 0);

    expect(Array.from(passed)).toEqual([0, 0, 1, 0, 1.5, 0]);
    expect(Array.from(ahead)).toEqual([1.5, 0, 2, 0, 3, 0]);
  });

  it("has only the train position as travelled part at the first vertex", () => {
    const { passed, ahead } = splitRoute(PATH, 0, 0, 0);

    expect(Array.from(passed)).toEqual([0, 0, 0, 0]);
    expect(Array.from(ahead)).toEqual([0, 0, 1, 0, 2, 0, 3, 0]);
  });

  it("has an empty route ahead beyond the last vertex", () => {
    const { passed, ahead } = splitRoute(PATH, 2, 3, 0);

    expect(Array.from(passed)).toEqual([0, 0, 1, 0, 2, 0, 3, 0]);
    expect(Array.from(ahead)).toEqual([3, 0, 3, 0]);
  });

  it("clamps a vertex index that is outside the path", () => {
    const { passed, ahead } = splitRoute(PATH, 99, 3, 0);

    expect(passed.length).toBeGreaterThanOrEqual(4);
    expect(ahead.length).toBeGreaterThanOrEqual(4);
  });
});

describe("routeBounds", () => {
  it("is the box around every vertex of the route ahead", () => {
    const { ahead } = splitRoute(PATH, 1, 1.5, 0.5);

    expect(routeBounds(ahead)).toEqual([
      [1.5, 0],
      [3, 0.5],
    ]);
  });

  it("is null for no route", () => {
    expect(routeBounds(new Float32Array(0))).toBeNull();
  });

  it("is a point box for a train at the end of its route", () => {
    const { ahead } = splitRoute(PATH, 2, 3, 0);

    expect(routeBounds(ahead)).toEqual([
      [3, 0],
      [3, 0],
    ]);
  });
});

describe("splitRoute3d", () => {
  const heights = Float32Array.from([100, 110, 130, 160]);

  it("carries each vertex height and ends the travelled part at the train height", () => {
    const { passed, ahead } = splitRoute3d(PATH, heights, 1, 1.5, 0, 120);

    expect(Array.from(passed)).toEqual([0, 0, 100, 1, 0, 110, 1.5, 0, 120]);
    expect(Array.from(ahead)).toEqual([1.5, 0, 120, 2, 0, 130, 3, 0, 160]);
  });

  it("draws at sea level where the route has no heights", () => {
    const { passed, ahead } = splitRoute3d(PATH, undefined, 1, 1.5, 0, 0);

    expect(Array.from(passed)).toEqual([0, 0, 0, 1, 0, 0, 1.5, 0, 0]);
    expect(Array.from(ahead)).toEqual([1.5, 0, 0, 2, 0, 0, 3, 0, 0]);
  });

  it("agrees with the flat split on the horizontal positions", () => {
    const flat = splitRoute(PATH, 2, 2.5, 0);
    const solid = splitRoute3d(PATH, heights, 2, 2.5, 0, 140);

    expect(solid.passed.filter((_, i) => i % 3 !== 2)).toEqual(flat.passed);
    expect(solid.ahead.filter((_, i) => i % 3 !== 2)).toEqual(flat.ahead);
  });

  it("raises every vertex by the lift and leaves the train point to its own height", () => {
    const { passed, ahead } = splitRoute3d(PATH, heights, 1, 1.5, 0, 120, 5);

    expect(Array.from(passed)).toEqual([0, 0, 105, 1, 0, 115, 1.5, 0, 120]);
    expect(Array.from(ahead)).toEqual([1.5, 0, 120, 2, 0, 135, 3, 0, 165]);
  });

  it("clamps a vertex index that is outside the path", () => {
    const { passed, ahead } = splitRoute3d(PATH, heights, 99, 3, 0, 160);

    expect(passed.length).toBe(12);
    expect(ahead.length).toBe(6);
  });
});

describe("RouteSplitter", () => {
  const heights = Float32Array.from([100, 110, 130, 160]);

  it("gives the same split as splitRoute3d", () => {
    const splitter = new RouteSplitter();
    const got = splitter.split(PATH, heights, 1, 1.5, 0, 120, 5);
    const want = splitRoute3d(PATH, heights, 1, 1.5, 0, 120, 5);

    expect(Array.from(got.passed)).toEqual(Array.from(want.passed));
    expect(Array.from(got.ahead)).toEqual(Array.from(want.ahead));
  });

  it("moves the train point in the same buffers while the train stays on a segment", () => {
    const splitter = new RouteSplitter();
    const first = splitter.split(PATH, heights, 1, 1.2, 0, 112, 5);
    const second = splitter.split(PATH, heights, 1.4, 1.75, 0, 124, 5);

    expect(second.passed).toBe(first.passed);
    expect(second.ahead).toBe(first.ahead);
    expect(Array.from(second.passed)).toEqual([0, 0, 105, 1, 0, 115, 1.75, 0, 124]);
    expect(Array.from(second.ahead)).toEqual([1.75, 0, 124, 2, 0, 135, 3, 0, 165]);
  });

  it("builds new buffers when the train passes a vertex, the lift changes or the route does", () => {
    const splitter = new RouteSplitter();
    const base = splitter.split(PATH, heights, 1, 1.2, 0, 112, 5);
    const passedVertex = splitter.split(PATH, heights, 2, 2.25, 0, 135, 5);
    const lifted = splitter.split(PATH, heights, 2, 2.25, 0, 135, 9);
    const other = splitter.split(Float32Array.from(PATH), heights, 2, 2.25, 0, 135, 9);

    expect(passedVertex.passed).not.toBe(base.passed);
    expect(lifted.passed).not.toBe(passedVertex.passed);
    expect(other.passed).not.toBe(lifted.passed);
    expect(Array.from(lifted.passed)).toEqual([0, 0, 109, 1, 0, 119, 2, 0, 139, 2.25, 0, 135]);
  });
});
