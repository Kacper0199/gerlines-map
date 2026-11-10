import { describe, expect, it } from "vitest";
import { SELECT_MIN_ZOOM, SELECT_PITCH } from "../map/camera-constants.ts";
import {
  atTarget,
  chasePadding,
  FLIGHT_MAX_MS,
  FLIGHT_MIN_MS,
  isPitched,
  metresPerPixel,
  planSelection,
} from "./camera-plan.ts";

const VIEWPORT = { width: 1440, height: 900 };
const HOME = { lng: 10.0, lat: 51.0, zoom: 5.6, pitch: 0 };
const OPTIONS = { reducedMotion: false, tilt: true, maxZoom: 17 };

describe("planSelection", () => {
  it("tilts and zooms in to the selection zoom on a flight from the national view", () => {
    const plan = planSelection(HOME, { lng: 8.68, lat: 50.11 }, VIEWPORT, OPTIONS);
    expect(plan.mode).toBe("fly");
    expect(plan.zoom).toBe(SELECT_MIN_ZOOM);
    expect(plan.pitch).toBe(SELECT_PITCH);
  });

  it("keeps a zoom that is already closer, and the pitch of a view already tilted further", () => {
    const close = { lng: 8.7, lat: 50.1, zoom: 14, pitch: 58 };
    const plan = planSelection(close, { lng: 8.71, lat: 50.11 }, VIEWPORT, OPTIONS);
    expect(plan.zoom).toBe(14);
    expect(plan.pitch).toBe(58);
    expect(plan.mode).toBe("ease");
  });

  it("eases when the train is within a screen and flies when it is further", () => {
    const view = { lng: 8.7, lat: 50.1, zoom: 12, pitch: 0 };
    expect(planSelection(view, { lng: 8.72, lat: 50.11 }, VIEWPORT, OPTIONS).mode).toBe("ease");
    expect(planSelection(view, { lng: 11.5, lat: 48.1 }, VIEWPORT, OPTIONS).mode).toBe("fly");
  });

  it("lasts longer for a longer way, within the bounds", () => {
    const view = { lng: 8.7, lat: 50.1, zoom: 12, pitch: 0 };
    const near = planSelection(view, { lng: 8.71, lat: 50.1 }, VIEWPORT, OPTIONS);
    const middle = planSelection(view, { lng: 9.4, lat: 50.4 }, VIEWPORT, OPTIONS);
    const far = planSelection(view, { lng: 13.4, lat: 52.5 }, VIEWPORT, OPTIONS);
    expect(near.durationMs).toBeGreaterThanOrEqual(FLIGHT_MIN_MS);
    expect(middle.durationMs).toBeGreaterThan(near.durationMs);
    expect(far.durationMs).toBeGreaterThanOrEqual(middle.durationMs);
    expect(far.durationMs).toBeLessThanOrEqual(FLIGHT_MAX_MS);
  });

  it("cuts instead of flying under reduced motion, and still arrives tilted", () => {
    const plan = planSelection(HOME, { lng: 8.68, lat: 50.11 }, VIEWPORT, {
      ...OPTIONS,
      reducedMotion: true,
    });
    expect(plan).toMatchObject({ mode: "cut", durationMs: 0, pitch: SELECT_PITCH });
  });

  it("keeps the pitch when the tilt is switched off", () => {
    const plan = planSelection(HOME, { lng: 8.68, lat: 50.11 }, VIEWPORT, {
      ...OPTIONS,
      tilt: false,
    });
    expect(plan.pitch).toBe(0);
    expect(plan.zoom).toBe(SELECT_MIN_ZOOM);
  });

  it("never plans past the maximum zoom", () => {
    const plan = planSelection(HOME, { lng: 8.68, lat: 50.11 }, VIEWPORT, {
      ...OPTIONS,
      maxZoom: 11,
    });
    expect(plan.zoom).toBe(11);
  });
});

describe("metresPerPixel", () => {
  it("halves with each zoom level and shrinks towards the poles", () => {
    expect(metresPerPixel(10, 50) / metresPerPixel(11, 50)).toBeCloseTo(2, 5);
    expect(metresPerPixel(10, 60)).toBeLessThan(metresPerPixel(10, 40));
  });
});

describe("chasePadding", () => {
  const PADDING = { top: 24, bottom: 72, left: 412, right: 248 };

  it("moves a northbound train below the middle of the free area when the view is tilted", () => {
    const padded = chasePadding(PADDING, 0, SELECT_PITCH, 900);
    expect(padded.top).toBeGreaterThan(PADDING.top);
    expect(padded.bottom).toBe(PADDING.bottom);
  });

  it("moves a southbound train above the middle", () => {
    const padded = chasePadding(PADDING, 180, SELECT_PITCH, 900);
    expect(padded.bottom).toBeGreaterThan(PADDING.bottom);
    expect(padded.top).toBe(PADDING.top);
  });

  it("leaves an eastbound train and a flat view alone", () => {
    expect(chasePadding(PADDING, 90, SELECT_PITCH, 900)).toEqual(PADDING);
    expect(chasePadding(PADDING, 0, 0, 900)).toEqual(PADDING);
  });

  it("leaves at least 30 % of the screen height free", () => {
    const tight = { top: 172, bottom: 340, left: 12, right: 12 };
    const padded = chasePadding(tight, 0, SELECT_PITCH, 844);
    expect(844 - padded.top - padded.bottom).toBeGreaterThanOrEqual(844 * 0.3);
  });
});

describe("atTarget", () => {
  const plan = { zoom: 11.5, pitch: 55 };

  it("is true when the centre, zoom and pitch are where the plan puts them", () => {
    const view = { lng: 10, lat: 51, zoom: 11.5, pitch: 55 };
    expect(atTarget(view, { lng: 10, lat: 51 }, plan)).toBe(true);
    expect(atTarget(view, { lng: 10.1, lat: 51 }, plan)).toBe(false);
    expect(atTarget({ ...view, zoom: 11 }, { lng: 10, lat: 51 }, plan)).toBe(false);
    expect(atTarget({ ...view, pitch: 40 }, { lng: 10, lat: 51 }, plan)).toBe(false);
  });
});

describe("isPitched", () => {
  it("counts a map as tilted from half a degree", () => {
    expect(isPitched(0)).toBe(false);
    expect(isPitched(0.4)).toBe(false);
    expect(isPitched(0.6)).toBe(true);
    expect(isPitched(55)).toBe(true);
  });
});
