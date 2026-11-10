import { describe, expect, it } from "vitest";
import type { SelectionStops } from "../motion/protocol.ts";
import { acceptRoute } from "./route-slot.ts";

const selected = (id: string, legKey = "3/7") => ({
  id,
  lon: 0,
  lat: 0,
  bearing: 0,
  z: 0,
  alpha: 1,
  legKey,
  vertex: 0,
});
const stops = (first: number): SelectionStops => ({
  vertices: Float32Array.of(first, first + 1),
  firstStop: 0,
  arrivals: new Float64Array(0),
  departures: new Float64Array(0),
  cancelled: new Uint8Array(0),
});
const path = Float32Array.of(0, 0, 1, 1);

describe("acceptRoute", () => {
  it("takes the route and the stops of the frame of the selected train", () => {
    const next = acceptRoute(
      "live:2",
      selected("live:2"),
      { path, heights: undefined, stops: stops(1) },
      undefined,
    );
    expect(next.route).toMatchObject({ legKey: "3/7", path });
    expect(next.route?.stops).toEqual(Float32Array.of(1, 2));
    expect(next.report).toEqual(stops(1));
  });

  it("ignores a late frame of the train selected before", () => {
    const old = { legKey: "9/9", path, heights: undefined, stops: undefined };
    const next = acceptRoute(
      "live:2",
      selected("live:1", "9/9"),
      { path, heights: undefined, stops: stops(5) },
      old,
    );
    expect(next.route).toBe(old);
    expect(next.report).toBeUndefined();
  });

  it("ignores every frame while nothing is selected", () => {
    const next = acceptRoute(
      null,
      selected("live:1"),
      { path, heights: undefined, stops: stops(5) },
      undefined,
    );
    expect(next.route).toBeUndefined();
    expect(next.report).toBeUndefined();
  });

  it("updates only the stops of the route when the stops come again without a path", () => {
    const held = { legKey: "3/7", path, heights: undefined, stops: Float32Array.of(1, 2) };
    const next = acceptRoute(
      "live:2",
      selected("live:2"),
      { path: undefined, heights: undefined, stops: stops(7) },
      held,
    );
    expect(next.route).toMatchObject({ legKey: "3/7", path });
    expect(next.route?.stops).toEqual(Float32Array.of(7, 8));
    expect(next.report).toEqual(stops(7));
  });

  it("reports no stops for a new route that has none, and nothing for a frame without route data", () => {
    const withoutStops = acceptRoute(
      "live:2",
      selected("live:2"),
      { path, heights: undefined, stops: undefined },
      undefined,
    );
    expect(withoutStops.report).toBeNull();
    const held = { legKey: "3/7", path, heights: undefined, stops: Float32Array.of(1, 2) };
    const nothing = acceptRoute(
      "live:2",
      selected("live:2"),
      { path: undefined, heights: undefined, stops: undefined },
      held,
    );
    expect(nothing.route).toBe(held);
    expect(nothing.report).toBeUndefined();
  });
});
