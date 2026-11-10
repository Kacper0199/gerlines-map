import { describe, expect, it } from "vitest";
import { DRAW_LEAD, drawStart, ROUTE_DRAW_MS, RouteDraw } from "./route-draw.ts";

describe("RouteDraw", () => {
  it("lets the whole route through when nothing is armed", () => {
    expect(new RouteDraw().metres(1000, 50_000)).toBeNull();
  });

  it("shows nothing before its start and the full reach after the duration", () => {
    const draw = new RouteDraw();
    draw.arm(1000, 40_000);
    expect(draw.metres(900, 90_000)).toBe(0);
    expect(draw.metres(1000 + ROUTE_DRAW_MS, 90_000)).toBeNull();
  });

  it("grows the revealed length steadily and never past the reach before the end", () => {
    const draw = new RouteDraw();
    draw.arm(0, 40_000);
    const samples = [0, 0.25, 0.5, 0.75, 0.99].map((f) => draw.metres(f * ROUTE_DRAW_MS, 90_000));
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i] as number).toBeGreaterThan(samples[i - 1] as number);
    }
    expect(samples[4] as number).toBeLessThanOrEqual(40_000);
  });

  it("ends at the route end for a route shorter than the reach", () => {
    const draw = new RouteDraw();
    draw.arm(0, 40_000);
    expect(draw.metres(ROUTE_DRAW_MS / 2, 10_000)).toBeLessThan(10_000);
    expect(draw.metres(ROUTE_DRAW_MS, 10_000)).toBeNull();
  });

  it("is finished after the duration and stays finished", () => {
    const draw = new RouteDraw();
    draw.arm(0, 40_000);
    expect(draw.active(ROUTE_DRAW_MS - 1)).toBe(true);
    expect(draw.metres(ROUTE_DRAW_MS + 5, 90_000)).toBeNull();
    expect(draw.active(ROUTE_DRAW_MS + 5)).toBe(false);
  });

  it("is cancelled by cancel", () => {
    const draw = new RouteDraw();
    draw.arm(0, 40_000);
    draw.cancel();
    expect(draw.metres(10, 90_000)).toBeNull();
  });
});

describe("drawStart", () => {
  const flight = { startedAt: 1000, durationMs: 1000 };

  it("starts a share of the way into the flight when the route is known early", () => {
    expect(drawStart(flight, 1050)).toBe(1000 + DRAW_LEAD * 1000);
  });

  it("starts at once when the route arrives after that point", () => {
    expect(drawStart(flight, 2500)).toBe(2500);
  });

  it("does not run for a cut", () => {
    expect(drawStart({ startedAt: 1000, durationMs: 0 }, 1000)).toBeNull();
  });
});

describe("RouteDraw with a short route", () => {
  it("never returns a length that is not finite", () => {
    const draw = new RouteDraw();
    draw.arm(0, 40_000);
    expect(Number.isFinite(draw.metres(100, 1200) as number)).toBe(true);
  });
});
