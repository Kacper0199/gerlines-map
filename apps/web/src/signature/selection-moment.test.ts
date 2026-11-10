import { describe, expect, it, vi } from "vitest";
import { ROUTE_DRAW_MS } from "./route-draw.ts";
import { type MomentFrame, SelectionMoment } from "./selection-moment.ts";

const FLIGHT = { startedAt: 1000, durationMs: 1000, reachMetres: 40_000 };
const FRAME: MomentFrame = { id: "live:1", lon: 8, lat: 50, bearing: 90, legKey: "3/7" };
const AHEAD = Float32Array.from([8, 50, 0, 8, 50.5, 0, 8, 51, 0]);
const ROUTE = { passed: Float32Array.from([8, 50, 0]), ahead: AHEAD };

function setup() {
  let now = 1000;
  const camera = { go: vi.fn(() => FLIGHT), release: vi.fn() };
  const moment = new SelectionMoment(camera, () => now);
  return {
    moment,
    camera,
    at: (ms: number) => {
      now = ms;
    },
  };
}

describe("SelectionMoment", () => {
  it("flies once to the selected train when its frame arrives", () => {
    const t = setup();
    t.moment.select("live:1");
    expect(t.moment.flightPending).toBe(true);
    t.moment.frame(FRAME, undefined);
    t.moment.frame(FRAME, undefined);
    expect(t.camera.go).toHaveBeenCalledTimes(1);
    expect(t.moment.flightPending).toBe(false);
  });

  it("does not fly to a frame of the train selected before", () => {
    const t = setup();
    t.moment.select("live:1");
    t.moment.select("live:2");
    t.moment.frame(FRAME, undefined);
    expect(t.camera.go).not.toHaveBeenCalled();
    expect(t.moment.flightPending).toBe(true);
    t.moment.frame({ ...FRAME, id: "live:2" }, undefined);
    expect(t.camera.go).toHaveBeenCalledTimes(1);
  });

  it("releases the camera when the selection ends and cancels a draw under way", () => {
    const t = setup();
    t.moment.select("live:1");
    t.moment.frame(FRAME, "3/7");
    expect(t.moment.drawn(ROUTE)).not.toBe(ROUTE);
    t.moment.select(null);
    expect(t.camera.release).toHaveBeenCalledTimes(1);
    expect(t.moment.drawn(ROUTE)).toBe(ROUTE);
  });

  it("does not release the camera when another train is selected", () => {
    const t = setup();
    t.moment.select("live:1");
    t.moment.select("live:2");
    expect(t.camera.release).not.toHaveBeenCalled();
  });

  it("waits for the route of the leg of the selected train before the draw starts", () => {
    const t = setup();
    t.moment.select("live:1");
    t.moment.frame(FRAME, undefined);
    expect(t.moment.drawn(ROUTE)).toBe(ROUTE);
    t.moment.frame(FRAME, "other");
    expect(t.moment.drawn(ROUTE)).toBe(ROUTE);
    t.at(1100);
    t.moment.frame(FRAME, "3/7");
    expect(t.moment.drawn(ROUTE).ahead).not.toBe(AHEAD);
  });

  it("shows the whole route once the draw is over, and measures nothing before it starts", () => {
    const t = setup();
    t.moment.select("live:1");
    t.moment.frame(FRAME, "3/7");
    t.at(1000 + 450 + ROUTE_DRAW_MS + 1);
    expect(t.moment.drawn(ROUTE)).toBe(ROUTE);
  });

  it("draws nothing for a cut, the route shows whole", () => {
    const camera = { go: vi.fn(() => ({ ...FLIGHT, durationMs: 0 })), release: vi.fn() };
    const moment = new SelectionMoment(camera, () => 1000);
    moment.select("live:1");
    moment.frame(FRAME, "3/7");
    expect(moment.drawn(ROUTE)).toBe(ROUTE);
  });

  it("draws the whole route when Route is requested", () => {
    const t = setup();
    t.moment.select("live:1");
    t.moment.frame(FRAME, "3/7");
    t.moment.routeRequested();
    expect(t.moment.drawn(ROUTE)).toBe(ROUTE);
  });

  it("a route that arrives after Route was pressed is not drawn", () => {
    const t = setup();
    t.moment.select("live:1");
    t.moment.frame(FRAME, undefined);
    t.moment.routeRequested();
    t.moment.frame(FRAME, "3/7");
    expect(t.moment.drawn(ROUTE)).toBe(ROUTE);
  });

  it("releases the camera when the tilt switch goes off, not when it goes on", () => {
    const t = setup();
    t.moment.tiltSwitched(true);
    expect(t.camera.release).not.toHaveBeenCalled();
    t.moment.tiltSwitched(false);
    expect(t.camera.release).toHaveBeenCalledTimes(1);
  });
});
