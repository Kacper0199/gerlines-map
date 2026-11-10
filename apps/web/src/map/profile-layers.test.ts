import { describe, expect, it } from "vitest";
import type { ProfileLeg, ProfileOverlay } from "../profile/model.ts";
import { CURTAIN_PX_PER_MINUTE, type ProfileLayerInput, ProfileLayers } from "./profile-layers.ts";

const known = (runs: number, median: number, p80: number) =>
  ({ status: "known", runs, medianGainS: median, p80GainS: p80 }) as const;

function leg(index: number, train: ProfileLeg["train"], all = known(900, 0, 60)): ProfileLeg {
  return {
    index,
    from: `S${index}`,
    to: `S${index + 1}`,
    fromVertex: index * 10,
    toVertex: (index + 1) * 10,
    train,
    all,
  };
}

const LEGS: ProfileLeg[] = [
  leg(0, known(24, 0, 60)),
  leg(1, known(24, 180, 300)),
  leg(2, { status: "missing", runs: 3, reason: "too_few_runs" }),
  leg(3, known(24, -60, 0)),
];
const OVERLAY: ProfileOverlay = { legs: LEGS, quantile: "median" };

const PATH = Float32Array.from(Array.from({ length: 41 }, (_, i) => [10 + i * 0.01, 50]).flat());
const HEIGHTS = Float32Array.from(Array.from({ length: 41 }, (_, i) => 100 + i));
const STOPS = Float32Array.of(0, 10, 20, 30, 40);

function input(patch: Partial<ProfileLayerInput> = {}): ProfileLayerInput {
  return {
    overlay: OVERLAY,
    route: { path: PATH, heights: HEIGHTS, stops: STOPS },
    lift: 5,
    zoom: 9,
    lat: 50,
    theme: "dark",
    terrain: true,
    pitched: true,
    vertex: 12,
    hover: null,
    ...patch,
  };
}

function propsOf<T>(layers: readonly { id: string; props: unknown }[], id: string): T {
  return layers.find((layer) => layer.id === id)?.props as T;
}

describe("ProfileLayers", () => {
  it("draws the casing, the coloured route, the missing legs and, in a pitched view, the curtain", () => {
    const layers = new ProfileLayers().build(input());
    expect(layers.map((layer) => layer.id)).toEqual([
      "profile-casing",
      "profile-hit",
      "profile-route",
      "profile-missing",
      "profile-curtain",
    ]);
  });

  it("leaves the curtain out of a flat view", () => {
    const ids = new ProfileLayers()
      .build(input({ pitched: false, terrain: false }))
      .map((l) => l.id);
    expect(ids).not.toContain("profile-curtain");
    expect(ids).toContain("profile-route");
  });

  it("puts a hovered leg under the route in the ink colour", () => {
    const ids = new ProfileLayers().build(input({ hover: 1 })).map((l) => l.id);
    expect(ids.indexOf("profile-hover")).toBeGreaterThan(ids.indexOf("profile-casing"));
    expect(ids.indexOf("profile-hover")).toBeLessThan(ids.indexOf("profile-route"));
  });

  it("splits the legs: figures into the route, the others into dashes and a pick area", () => {
    const layers = new ProfileLayers().build(input());
    const data = (id: string) => propsOf<{ data: { leg: number }[] }>(layers, id).data;
    expect(data("profile-route").map((d) => d.leg)).toEqual([0, 1, 3]);
    expect(data("profile-hit").map((d) => d.leg)).toEqual([2]);
    expect(new Set(data("profile-missing").map((d) => d.leg))).toEqual(new Set([2]));
    expect(data("profile-missing").length).toBeGreaterThan(1);
  });

  it("makes a curtain only for legs that lose time, one polygon each, with the minutes as height", () => {
    const layers = new ProfileLayers().build(input());
    const data = propsOf<{ data: { leg: number; minutes: number }[] }>(
      layers,
      "profile-curtain",
    ).data;
    expect(data.map((d) => [d.leg, d.minutes])).toEqual([[1, 3]]);
  });

  it("follows the quantile for colours and heights", () => {
    const layers = new ProfileLayers().build(input({ overlay: { ...OVERLAY, quantile: "p80" } }));
    const data = propsOf<{ data: { leg: number; minutes: number }[] }>(
      layers,
      "profile-curtain",
    ).data;
    expect(data.map((d) => [d.leg, d.minutes])).toEqual([
      [0, 1],
      [1, 5],
    ]);
  });

  it("scales the curtain with the view so a minute stays the same number of pixels", () => {
    const at = (zoom: number) =>
      propsOf<{ elevationScale: number }>(
        new ProfileLayers().build(input({ zoom })),
        "profile-curtain",
      ).elevationScale;
    expect(at(9) / at(10)).toBeCloseTo(2, 5);
    expect(at(9)).toBeGreaterThan(CURTAIN_PX_PER_MINUTE);
  });

  it("reuses the geometry while the route, the legs and the view bucket stay the same", () => {
    const layers = new ProfileLayers();
    const a = layers.assembled(input());
    const b = layers.assembled(input({ vertex: 30, hover: 2, zoom: 9.1 }));
    expect(b).toBe(a);
    expect(layers.assembled(input({ zoom: 11 }))).not.toBe(a);
    expect(layers.assembled(input({ lift: 9 }))).not.toBe(a);
  });

  it("hands deck the same data arrays frame after frame so the paths are not rebuilt", () => {
    const layers = new ProfileLayers();
    const dataOf = (patch: Partial<ProfileLayerInput>, id: string) =>
      propsOf<{ data: unknown }>(layers.build(input(patch)), id).data;
    for (const id of ["profile-casing", "profile-route", "profile-curtain", "profile-missing"]) {
      expect(dataOf({ vertex: 30, hover: 1 }, id)).toBe(dataOf({ vertex: 12, hover: 1 }, id));
    }
    expect(dataOf({ theme: "light" }, "profile-curtain")).not.toBe(dataOf({}, "profile-curtain"));
  });

  it("dims the legs the train has passed through the colour accessor and its trigger", () => {
    const layers = new ProfileLayers();
    const route = (vertex: number) =>
      propsOf<{
        data: never[];
        getColor: (d: never) => number[];
        updateTriggers: { getColor: unknown[] };
      }>(layers.build(input({ vertex })), "profile-route");
    const early = route(5);
    const late = route(25);
    expect(early.getColor(early.data[0] as never)[3]).toBe(255);
    expect(late.getColor(late.data[0] as never)[3]).toBeLessThan(255);
    expect(late.updateTriggers.getColor).not.toEqual(early.updateTriggers.getColor);
  });

  it("dims the dashes of a missing leg the train has passed, with the trigger that redraws them", () => {
    const layers = new ProfileLayers();
    const dashes = (vertex: number) =>
      propsOf<{
        data: never[];
        getColor: (d: never) => number[];
        updateTriggers: { getColor: unknown[] };
      }>(layers.build(input({ vertex })), "profile-missing");
    const before = dashes(25);
    const after = dashes(35);
    expect(before.getColor(before.data[0] as never)[3]).toBe(255);
    expect(after.getColor(after.data[0] as never)[3]).toBeLessThan(255);
    expect(after.updateTriggers.getColor).not.toEqual(before.updateTriggers.getColor);
  });

  it("draws nothing for stops that do not match the legs", () => {
    const layers = new ProfileLayers().build(
      input({ route: { path: PATH, heights: HEIGHTS, stops: Float32Array.of(0, 10) } }),
    );
    expect(layers).toEqual([]);
  });
});
