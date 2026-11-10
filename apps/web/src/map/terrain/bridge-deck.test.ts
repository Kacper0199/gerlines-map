import { describe, expect, it } from "vitest";
import { BridgeDeck, CHORD_CLEARANCE_M, LIFT_RAMP_M_PER_M } from "./bridge-deck.ts";
import type { DeckWindows } from "./deck-windows.ts";

function deckOf(
  id: string,
  first: number,
  points: readonly (readonly [number, number, number])[],
): DeckWindows {
  return {
    shapeIds: [id],
    first: Uint32Array.from([first]),
    counts: Uint32Array.from([points.length]),
    paths: Float32Array.from(points.flat()),
  };
}

const LINE = [
  [8, 50, 300],
  [8.001, 50, 300],
  [8.002, 50, 300],
  [8.003, 50, 300],
  [8.004, 50, 300],
] as const;

function triples(path: Float32Array): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < path.length; i += 3) {
    out.push([path[i] as number, path[i + 1] as number, path[i + 2] as number]);
  }
  return out;
}

function runsOf(
  bridges: BridgeDeck,
  deck: DeckWindows,
  ground: Parameters<BridgeDeck["measure"]>[1],
) {
  bridges.measure(deck, ground);
  return bridges.data(0).map((entry) => entry.path);
}

describe("BridgeDeck", () => {
  it("draws the stretch where the chord runs high above the ground, a viaduct", () => {
    const valley = (lon: number) => (lon > 8.0009 && lon < 8.0031 ? 120 : 295);
    const runs = runsOf(new BridgeDeck(), deckOf("a", 10, LINE), (lon) => valley(lon));

    expect(runs).toHaveLength(1);
    const middle = triples(runs[0] as Float32Array).slice(1, -1);
    expect(middle).toEqual(
      [
        [8.001, 50, 300],
        [8.002, 50, 300],
        [8.003, 50, 300],
      ].map((t) => t.map(Math.fround)),
    );
  });

  it("brings both ends of a stretch down to the terrain, so the line joins the rail", () => {
    const valley = (lon: number) => (lon > 8.0009 && lon < 8.0031 ? 120 : 295);
    const runs = runsOf(new BridgeDeck(), deckOf("a", 0, LINE), (lon) => valley(lon));
    const path = triples(runs[0] as Float32Array);

    expect(path).toHaveLength(5);
    expect(path[0]).toEqual([8, 50, 295].map(Math.fround));
    expect(path[4]).toEqual([8.004, 50, 295].map(Math.fround));
  });

  it("starts at the window edge when the stretch begins on the first vertex", () => {
    const high = () => 100;
    const runs = runsOf(new BridgeDeck(), deckOf("a", 0, LINE), high);
    expect(triples(runs[0] as Float32Array)).toHaveLength(5);
  });

  it("draws nothing where the track follows the ground", () => {
    expect(runsOf(new BridgeDeck(), deckOf("a", 0, LINE), () => 296)).toHaveLength(0);
  });

  it("draws nothing in a tunnel, where the chord is under the ground", () => {
    expect(runsOf(new BridgeDeck(), deckOf("a", 0, LINE), () => 450)).toHaveLength(0);
  });

  it("needs more than the clearance, so a little sag over rolling ground is not a bridge", () => {
    const sag = CHORD_CLEARANCE_M - 1;
    expect(runsOf(new BridgeDeck(), deckOf("a", 0, LINE), () => 300 - sag)).toHaveLength(0);
    expect(
      runsOf(new BridgeDeck(), deckOf("a", 0, LINE), () => 300 - CHORD_CLEARANCE_M - 1),
    ).toHaveLength(1);
  });

  it("lifts the drawn line by the marker lift but not the ends on the ground", () => {
    const bridges = new BridgeDeck();
    const valley = (lon: number) => (lon > 8.0009 && lon < 8.0031 ? 120 : 295);
    bridges.measure(deckOf("a", 0, LINE), valley);
    const path = triples((bridges.data(2)[0] as { path: Float32Array }).path);

    expect(path.map((p) => p[2])).toEqual([295, 302, 302, 302, 295].map(Math.fround));
  });

  it("brings the lift in along the track from a joint with the rail, so no step shows at an abutment", () => {
    const bridges = new BridgeDeck();
    const valley = (lon: number) => (lon > 8.0009 && lon < 8.0031 ? 120 : 295);
    bridges.measure(deckOf("a", 0, LINE), valley);
    const heights = triples((bridges.data(12)[0] as { path: Float32Array }).path).map((p) => p[2]);

    expect(heights[0]).toBe(295);
    expect(heights[4]).toBe(295);
    const spacing = 111_320 * Math.cos((50 * Math.PI) / 180) * 0.001;
    const lift = (steps: number) => Math.min(12, (steps * spacing) / LIFT_RAMP_M_PER_M);
    expect(heights[1]).toBeCloseTo(300 + lift(1), 1);
    expect(heights[2]).toBeCloseTo(300 + lift(2), 1);
    expect(heights[3]).toBeCloseTo(300 + lift(1), 1);
    expect((heights[1] as number) - 300).toBeGreaterThan(0);
    expect((heights[1] as number) - 300).toBeLessThan(12);
  });

  it("keeps the whole lift at the edge of the window, where no rail joins", () => {
    const bridges = new BridgeDeck();
    bridges.measure(deckOf("a", 0, LINE), () => 100);
    const heights = triples((bridges.data(5)[0] as { path: Float32Array }).path).map((p) => p[2]);
    expect(heights).toEqual([305, 305, 305, 305, 305]);
  });

  it("does not guess where the terrain's own tile has not loaded and measures again later", () => {
    const bridges = new BridgeDeck();
    const input = deckOf("a", 0, LINE);
    bridges.measure(input, () => undefined);
    expect(bridges.data(0)).toHaveLength(0);
    expect(bridges.unmeasured).toBe(4);
    bridges.measure(input, () => null);
    expect(bridges.unmeasured).toBe(4);
    bridges.measure(input, () => 100);
    expect(bridges.data(0)).toHaveLength(1);
    expect(bridges.unmeasured).toBe(0);
  });

  it("never remembers a segment it could not measure on the terrain's own tile", () => {
    const bridges = new BridgeDeck();
    const input = deckOf("a", 0, LINE);
    bridges.measure(input, () => undefined);
    let asked = 0;
    bridges.measure(input, () => {
      asked++;
      return 295;
    });
    expect(asked).toBe(3 * 4);
    expect(bridges.data(0)).toHaveLength(0);
  });

  it("remembers what it measured and asks the terrain once per segment", () => {
    const bridges = new BridgeDeck();
    let asked = 0;
    const ground = () => {
      asked++;
      return 100;
    };
    bridges.measure(deckOf("a", 0, LINE), ground);
    expect(asked).toBe(3 * 4);
    bridges.measure(deckOf("a", 2, LINE.slice(2)), ground);
    expect(asked).toBe(3 * 4);
    bridges.measure(deckOf("b", 0, LINE), ground);
    expect(asked).toBe(2 * 3 * 4);
  });

  it("keeps what the latest views needed and forgets the oldest first", () => {
    const bridges = new BridgeDeck(8);
    let asked = 0;
    const ground = () => {
      asked++;
      return 100;
    };
    for (const id of ["a", "b", "c", "d", "e"]) bridges.measure(deckOf(id, 0, LINE), ground);
    asked = 0;
    bridges.measure(deckOf("d", 0, LINE), ground);
    expect(asked).toBe(0);
    bridges.measure(deckOf("a", 0, LINE), ground);
    expect(asked).toBe(3 * 4);
  });

  it("keeps a whole view in memory even when it holds more segments than the memory", () => {
    const bridges = new BridgeDeck(4);
    const wide = deckOf(
      "a",
      0,
      Array.from({ length: 21 }, (_, i) => [8 + i * 0.001, 50, 300] as const),
    );
    let asked = 0;
    const ground = () => {
      asked++;
      return 100;
    };
    bridges.measure(wide, ground);
    expect(asked).toBe(3 * 20);
    asked = 0;
    bridges.measure(wide, ground);
    expect(asked).toBe(0);
  });

  it("gives one path per stretch and none for a window of one vertex", () => {
    const flags = (lon: number) => (lon < 8.001 || lon > 8.003 ? 100 : 299);
    const runs = runsOf(new BridgeDeck(), deckOf("a", 0, LINE), flags);
    expect(runs.length).toBe(2);
    expect(runsOf(new BridgeDeck(), deckOf("a", 0, [LINE[0]]), () => 0)).toEqual([]);
  });

  it("hands out the same data again while nothing changed, so the layers do not rebuild", () => {
    const bridges = new BridgeDeck();
    const input = deckOf("a", 0, LINE);
    bridges.measure(input, () => 100);
    const first = bridges.data(12);
    expect(bridges.data(12)).toBe(first);
    expect(bridges.data(12.2)).toBe(first);
    bridges.measure(input, () => 100);
    expect(bridges.data(12)).toBe(first);
    expect(bridges.data(30)).not.toBe(first);
  });

  it("hands out new data when the stretches change", () => {
    const bridges = new BridgeDeck();
    bridges.measure(deckOf("a", 0, LINE), () => 100);
    const first = bridges.data(0);
    bridges.measure(deckOf("b", 0, LINE.slice(0, 3)), () => 100);
    expect(bridges.data(0)).not.toBe(first);
  });

  it("clears its data when told to", () => {
    const bridges = new BridgeDeck();
    bridges.measure(deckOf("a", 0, LINE), () => 100);
    bridges.clear();
    expect(bridges.data(0)).toHaveLength(0);
  });
  it("skips the segments outside the view and does not count them as unmeasured", () => {
    const bridges = new BridgeDeck();
    const view = { west: 7.9, east: 8.0015, south: 49.9, north: 50.1 };
    let asked = 0;
    bridges.measure(
      deckOf("a", 0, LINE),
      () => {
        asked++;
        return undefined;
      },
      view,
    );
    expect(bridges.unmeasured).toBe(2);
    expect(asked).toBe(2);
  });

  it("draws the part of a bridge that is in the view and ends it on the ground at the edge", () => {
    const bridges = new BridgeDeck();
    const view = { west: 7.9, east: 8.0025, south: 49.9, north: 50.1 };
    bridges.measure(deckOf("a", 0, LINE), () => 100, view);
    const path = triples((bridges.data(5)[0] as { path: Float32Array }).path);
    const heights = path.map((p) => p[2] as number);
    expect(heights.slice(0, 3)).toEqual([305, 305, 305]);
    expect(heights[3]).toBeCloseTo(300 + 71.55 / LIFT_RAMP_M_PER_M, 1);
    expect(heights[4]).toBe(100);
  });

  it("measures the segments in the view when the view is not given", () => {
    const bridges = new BridgeDeck();
    bridges.measure(deckOf("a", 0, LINE), () => undefined);
    expect(bridges.unmeasured).toBe(4);
  });

  it("counts an end vertex without ground as unmeasured, so the end is tried again", () => {
    const bridges = new BridgeDeck();
    const ground = (lon: number) => {
      if (Math.abs(lon - 8) < 1e-6 || Math.abs(lon - 8.004) < 1e-6) return undefined;
      return lon > 8.0009 && lon < 8.0031 ? 120 : 295;
    };
    bridges.measure(deckOf("a", 0, LINE), ground);
    expect(bridges.data(0)).toHaveLength(1);
    expect(bridges.unmeasured).toBe(2);
  });

  it("does not count an end vertex outside the view as unmeasured", () => {
    const bridges = new BridgeDeck();
    const view = { west: 7.9, east: 8.0025, south: 49.9, north: 50.1 };
    const ground = (lon: number) => (lon > 8.0035 ? undefined : 120);
    bridges.measure(deckOf("a", 0, LINE), ground, view);
    expect(bridges.unmeasured).toBe(0);
  });

  describe("in steps", () => {
    const wide = deckOf(
      "w",
      0,
      Array.from({ length: 21 }, (_, i) => [8 + i * 0.001, 50, 300] as const),
    );

    it("measures a long window over several calls and publishes it when it is done", () => {
      const bridges = new BridgeDeck();
      let asked = 0;
      const ground = () => {
        asked++;
        return 100;
      };
      bridges.begin(wide);
      expect(bridges.pending).toBe(true);
      let steps = 0;
      while (!bridges.step(ground, 12)) {
        steps++;
        expect(bridges.data(0)).toHaveLength(0);
        expect(asked).toBeLessThanOrEqual((steps + 1) * 12);
      }
      expect(steps).toBeGreaterThanOrEqual(4);
      expect(bridges.pending).toBe(false);
      expect(bridges.data(0)).toHaveLength(1);
    });

    it("changes its published version only when a pass ends with other stretches, so the map knows to draw them", () => {
      const bridges = new BridgeDeck();
      const start = bridges.published;
      bridges.begin(wide);
      while (!bridges.step(() => 100, 12)) expect(bridges.published).toBe(start);
      const found = bridges.published;
      expect(found).not.toBe(start);
      bridges.begin(wide);
      while (!bridges.step(() => 100, 12)) expect(bridges.published).toBe(found);
      expect(bridges.published).toBe(found);
      bridges.clear();
      expect(bridges.published).not.toBe(found);
    });

    it("keeps the last result until the new pass is done", () => {
      const bridges = new BridgeDeck();
      bridges.measure(deckOf("a", 0, LINE), () => 100);
      const before = bridges.data(0);
      expect(before).toHaveLength(1);
      bridges.begin(wide);
      bridges.step(() => 100, 3);
      expect(bridges.data(0)).toBe(before);
    });

    it("does not ask again for segments an earlier pass measured", () => {
      const bridges = new BridgeDeck();
      let asked = 0;
      const ground = () => {
        asked++;
        return 100;
      };
      bridges.begin(wide);
      bridges.step(ground, 30);
      const first = asked;
      bridges.begin(wide);
      while (!bridges.step(ground, 30));
      expect(asked).toBe(3 * 20);
      expect(first).toBeGreaterThan(0);
    });

    it("starts over when a new pass begins and drops the old one", () => {
      const bridges = new BridgeDeck();
      bridges.begin(wide);
      bridges.step(() => 100, 6);
      bridges.begin(deckOf("a", 0, LINE));
      while (!bridges.step(() => 100, 6));
      expect(bridges.data(0)).toHaveLength(1);
      expect((bridges.data(0)[0] as { path: Float32Array }).path).toHaveLength(15);
    });

    it("clear drops a pass in progress", () => {
      const bridges = new BridgeDeck();
      bridges.begin(wide);
      bridges.clear();
      expect(bridges.pending).toBe(false);
      expect(bridges.step(() => 100, 6)).toBe(true);
    });
  });
});
