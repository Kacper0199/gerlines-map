import { describe, expect, it } from "vitest";
import type { Frame, FrameGroup } from "../motion/frame.ts";
import { drawsEveryFrame, type GateView, nearScale, RepaintGate } from "./repaint-gate.ts";

const VIEW: GateView = {
  zoom: 5.5,
  lng: 10.4,
  lat: 51.2,
  pitch: 0,
  bearing: 0,
  chevronPixels: 0,
  nearScale: 1,
  width: 1440,
  height: 900,
  padding: "0,0,0,0",
};
const CHEVRONS: GateView = { ...VIEW, zoom: 12, chevronPixels: 24 };
const WORLD_PIXELS = 512 * 2 ** 5.5;

function group(overrides: Partial<FrameGroup> = {}): FrameGroup {
  return {
    hollow: false,
    count: 2,
    positions: Float32Array.of(9, 50, 0, 11, 52, 0),
    iconAngles: Float32Array.of(10, 200),
    sizes: Float32Array.of(12, 12),
    fillColors: Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 255),
    lineColors: Uint8Array.of(0, 0, 0, 255, 0, 0, 0, 255),
    ids: undefined,
    ...overrides,
  };
}

function frame(g: FrameGroup = group(), extra: Partial<Frame> = {}): Frame {
  return { groups: [g], selected: null, ...extra };
}

function movedEast(pixels: number): FrameGroup {
  return group({ positions: Float32Array.of(9 + (pixels / WORLD_PIXELS) * 360, 50, 0, 11, 52, 0) });
}

function movedNorth(pixels: number, lat = 50): FrameGroup {
  const mercator = (degrees: number) => Math.log(Math.tan(Math.PI / 4 + (degrees * Math.PI) / 360));
  const target = mercator(lat) + (pixels / WORLD_PIXELS) * 2 * Math.PI;
  const degrees = (2 * Math.atan(Math.exp(target)) - Math.PI / 2) * (180 / Math.PI);
  return group({ positions: Float32Array.of(9, degrees, 0, 11, 52, 0) });
}

function risen(metres: number): FrameGroup {
  return group({ positions: Float32Array.of(9, 50, metres, 11, 52, 0) });
}

describe("RepaintGate", () => {
  it("draws the first frame", () => {
    expect(new RepaintGate().shouldDraw(frame(), VIEW, 0)).toBe(true);
  });

  it("skips a frame that moved no train by half a pixel", () => {
    const gate = new RepaintGate();
    gate.shouldDraw(frame(), VIEW, 0);
    expect(gate.shouldDraw(frame(movedEast(0.3)), VIEW, 10)).toBe(false);
  });

  it("draws once a train is half a pixel from where it was last drawn, counting the skipped frames", () => {
    const gate = new RepaintGate();
    gate.shouldDraw(frame(), VIEW, 0);
    expect(gate.shouldDraw(frame(movedEast(0.3)), VIEW, 10)).toBe(false);
    expect(gate.shouldDraw(frame(movedEast(0.6)), VIEW, 20)).toBe(true);
    expect(gate.shouldDraw(frame(movedEast(0.7)), VIEW, 30)).toBe(false);
  });

  it("draws at once when the view changes", () => {
    const gate = new RepaintGate();
    gate.shouldDraw(frame(), VIEW, 0);
    for (const changed of [
      { ...VIEW, zoom: 5.6 },
      { ...VIEW, lng: 10.5 },
      { ...VIEW, lat: 51.3 },
      { ...VIEW, pitch: 10 },
      { ...VIEW, bearing: 5 },
    ]) {
      expect(gate.shouldDraw(frame(), changed, 10)).toBe(true);
      expect(gate.shouldDraw(frame(), changed, 20)).toBe(false);
    }
  });

  it("draws when a train changes colour, size, group or the ids", () => {
    const gate = new RepaintGate();
    gate.shouldDraw(frame(), VIEW, 0);
    expect(
      gate.shouldDraw(
        frame(group({ fillColors: Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 200) })),
        VIEW,
        1,
      ),
    ).toBe(true);
    expect(gate.shouldDraw(frame(group({ sizes: Float32Array.of(12, 14) })), VIEW, 2)).toBe(true);
    expect(gate.shouldDraw(frame(group({ ids: ["a", "b"] })), VIEW, 3)).toBe(true);
    expect(gate.shouldDraw(frame(group({ hollow: true })), VIEW, 4)).toBe(true);
    expect(gate.shouldDraw({ groups: [group(), group()], selected: null }, VIEW, 5)).toBe(true);
    expect(
      gate.shouldDraw(frame(group({ count: 1, positions: Float32Array.of(9, 50, 0) })), VIEW, 6),
    ).toBe(true);
  });

  it("ignores a turn while only dots are drawn", () => {
    const gate = new RepaintGate();
    gate.shouldDraw(frame(), VIEW, 0);
    expect(gate.shouldDraw(frame(group({ iconAngles: Float32Array.of(90, 20) })), VIEW, 1)).toBe(
      false,
    );
  });

  it("draws when a chevron turns until its tip has moved half a pixel and not for less", () => {
    const gate = new RepaintGate();
    const real = (angles: number[]) =>
      group({ sizes: Float32Array.of(1, 1), iconAngles: Float32Array.from(angles) });
    gate.shouldDraw(frame(real([10, 200])), CHEVRONS, 0);
    expect(gate.shouldDraw(frame(real([11.5, 199])), CHEVRONS, 1)).toBe(false);
    expect(gate.shouldDraw(frame(real([12.6, 200])), CHEVRONS, 2)).toBe(true);
  });

  it("measures a turn across north as the short way", () => {
    const gate = new RepaintGate();
    gate.shouldDraw(
      frame(group({ sizes: Float32Array.of(1, 1), iconAngles: Float32Array.of(359.95, 0) })),
      CHEVRONS,
      0,
    );
    expect(
      gate.shouldDraw(
        frame(group({ sizes: Float32Array.of(1, 1), iconAngles: Float32Array.of(0.05, 0) })),
        CHEVRONS,
        1,
      ),
    ).toBe(false);
  });

  it("draws every frame while a train is selected or cars are drawn", () => {
    const gate = new RepaintGate();
    const selected = {
      id: "a",
      lon: 9,
      lat: 50,
      bearing: 0,
      z: 0,
      alpha: 1,
      legKey: "k",
      vertex: 0,
    };
    gate.shouldDraw(frame(), VIEW, 0);
    expect(gate.shouldDraw(frame(group(), { selected }), VIEW, 1)).toBe(true);
    expect(gate.shouldDraw(frame(group(), { selected }), VIEW, 2)).toBe(true);
    expect(gate.shouldDraw(frame(group(), { cars: {} as never }), VIEW, 3)).toBe(true);
  });

  it("counts a rise as screen distance, so metres that are a fraction of a pixel do not draw", () => {
    const gate = new RepaintGate();
    gate.shouldDraw(frame(), VIEW, 0);
    expect(gate.shouldDraw(frame(risen(120)), VIEW, 1)).toBe(false);
    expect(gate.shouldDraw(frame(risen(900)), VIEW, 2)).toBe(true);
  });

  it("draws for a rise of a few metres at street zoom, where they are pixels", () => {
    const street: GateView = { ...VIEW, zoom: 16 };
    const gate = new RepaintGate();
    gate.shouldDraw(frame(), street, 0);
    expect(gate.shouldDraw(frame(risen(0.3)), street, 1)).toBe(false);
    expect(gate.shouldDraw(frame(risen(4)), street, 2)).toBe(true);
  });

  it("measures distance in Mercator pixels, the same at every latitude", () => {
    for (const lat of [47.5, 50, 54.5]) {
      const atLat = (pixels: number) =>
        frame(
          group({
            positions: Float32Array.of(9 + (pixels / WORLD_PIXELS) * 360, lat, 0, 11, 52, 0),
          }),
        );
      const gate = new RepaintGate();
      gate.shouldDraw(atLat(0), VIEW, 0);
      expect(gate.shouldDraw(atLat(0.45), VIEW, 1)).toBe(false);
      expect(gate.shouldDraw(atLat(0.55), VIEW, 2)).toBe(true);
    }
  });

  it("counts a step north by the Mercator stretch, not by degrees", () => {
    const gate = new RepaintGate();
    gate.shouldDraw(frame(), VIEW, 0);
    expect(gate.shouldDraw(frame(movedNorth(0.45)), VIEW, 1)).toBe(false);
    expect(gate.shouldDraw(frame(movedNorth(0.55)), VIEW, 2)).toBe(true);
  });

  it("holds a train to a finer limit when the view is pitched and the nearest rows magnify it", () => {
    const pitched: GateView = { ...VIEW, pitch: 60, nearScale: 1.58 };
    const gate = new RepaintGate();
    gate.shouldDraw(frame(), pitched, 0);
    expect(gate.shouldDraw(frame(movedEast(0.4)), pitched, 1)).toBe(true);
    const flat = new RepaintGate();
    flat.shouldDraw(frame(), VIEW, 0);
    expect(flat.shouldDraw(frame(movedEast(0.4)), VIEW, 1)).toBe(false);
  });

  it("draws when the canvas is resized or its padding changes, which move the labels", () => {
    const gate = new RepaintGate();
    gate.shouldDraw(frame(), VIEW, 0);
    expect(gate.shouldDraw(frame(), { ...VIEW, width: 1000 }, 1)).toBe(true);
    expect(gate.shouldDraw(frame(), { ...VIEW, width: 1000, height: 700 }, 2)).toBe(true);
    expect(
      gate.shouldDraw(frame(), { ...VIEW, width: 1000, height: 700, padding: "0,300,0,0" }, 3),
    ).toBe(true);
    expect(
      gate.shouldDraw(frame(), { ...VIEW, width: 1000, height: 700, padding: "0,300,0,0" }, 4),
    ).toBe(false);
  });

  it("draws the next frame again when the map did not draw the last one", () => {
    const gate = new RepaintGate();
    expect(gate.shouldDraw(frame(), VIEW, 0)).toBe(true);
    gate.forget();
    expect(gate.shouldDraw(frame(), VIEW, 1)).toBe(true);
  });

  it("starts from nothing after a selected train, so the first frame after it draws", () => {
    const gate = new RepaintGate();
    const selected = {
      id: "a",
      lon: 9,
      lat: 50,
      bearing: 0,
      z: 0,
      alpha: 1,
      legKey: "k",
      vertex: 0,
    };
    gate.shouldDraw(frame(), VIEW, 0);
    gate.shouldDraw(frame(group(), { selected }), VIEW, 1);
    expect(gate.shouldDraw(frame(), VIEW, 2)).toBe(true);
    expect(gate.shouldDraw(frame(), VIEW, 3)).toBe(false);
  });

  it("scales a pitched view from the centre scale and the scale of the nearest row", () => {
    expect(nearScale(100, 100)).toBe(1);
    expect(nearScale(100, 63)).toBeCloseTo(100 / 63, 6);
    expect(nearScale(100, 140)).toBe(1);
    expect(nearScale(100, 0)).toBe(1);
  });

  it("draws again after the longest time without a draw and when asked to forget", () => {
    const gate = new RepaintGate({ maxAgeMs: 1000 });
    gate.shouldDraw(frame(), VIEW, 0);
    expect(gate.shouldDraw(frame(), VIEW, 999)).toBe(false);
    expect(gate.shouldDraw(frame(), VIEW, 1000)).toBe(true);
    gate.forget();
    expect(gate.shouldDraw(frame(), VIEW, 1001)).toBe(true);
  });

  it("keeps what it compares against when the worker reuses its buffers", () => {
    const gate = new RepaintGate();
    const positions = Float32Array.of(9, 50, 0, 11, 52, 0);
    gate.shouldDraw(frame(group({ positions })), VIEW, 0);
    positions[0] = 9.5;
    expect(gate.shouldDraw(frame(group({ positions })), VIEW, 1)).toBe(true);
  });
});

describe("drawsEveryFrame", () => {
  it("is on for a probe page that asks for it and for nothing else", () => {
    expect(drawsEveryFrame("?probe=1&repaint=always")).toBe(true);
    expect(drawsEveryFrame("?repaint=always")).toBe(false);
    expect(drawsEveryFrame("?probe=1")).toBe(false);
    expect(drawsEveryFrame("?probe=1&repaint=gated")).toBe(false);
    expect(drawsEveryFrame("")).toBe(false);
  });
});
