import { createShape } from "@gerlines/geo";
import { decodeShapePack, encodeShapePack, shapePolyline } from "@gerlines/live-frame";
import { describe, expect, it } from "vitest";
import {
  closeGate,
  newGeometryReport,
  noteFaults,
  parseShapeNumbers,
  type ShapeFaults,
  type ShapeRow,
  type StubRow,
  shapeFaults,
  shapeRecordOf,
  uTurnsOffStop,
} from "./packs.ts";

const row = (points: number[][]): ShapeRow => ({
  shape_no: 3,
  shape_hash: "cd".repeat(32),
  elevation_source: null,
  tunnel_spans: [],
  stop_arc_m: [0, 300],
  points,
});

describe("shapeFaults", () => {
  it("finds no fault on a straight line with growing M", () => {
    expect(shapeFaults([0, 1, 2], [0, 0, 0], [0, 1, 2])).toEqual({
      turns: 0,
      hairpins: 0,
      fallingM: 0,
      firstHairpinAt: null,
      uTurns: 0,
      firstUTurnAt: null,
    });
  });

  it("counts a vertex that runs out and back as a hairpin", () => {
    const faults = shapeFaults([0, 10, 20, 11, 30], [0, 0, 0, 0.5, 0], [0, 10, 20, 29, 48]);
    expect(faults.hairpins).toBeGreaterThanOrEqual(1);
    expect(faults.firstHairpinAt).toBe(20);
  });

  it("keeps a reversal on an intermediate stop arc out of the hairpins", () => {
    const x = [0, 10, 20, 11, 30];
    const y = [0, 0, 0, 0.5, 0];
    const m = [0, 10, 20, 29, 48];
    const all = shapeFaults(x, y, m, [0, 48]);
    expect(all.turns).toBe(2);
    expect(all.hairpins).toBe(2);
    const atStop = shapeFaults(x, y, m, [0, 20.005, 48]);
    expect(atStop.hairpins).toBe(1);
    expect(atStop.firstHairpinAt).toBe(29);
    expect(shapeFaults(x, y, m, [0, 20.5, 48]).hairpins).toBe(2);
  });

  it("ignores a right angle and zero-length segments", () => {
    expect(shapeFaults([0, 10, 10, 10], [0, 0, 0, 10], [0, 10, 10, 20]).hairpins).toBe(0);
  });

  it("counts falling M", () => {
    expect(shapeFaults([0, 1, 2, 3], [0, 0, 0, 0], [0, 5, 4, 6]).fallingM).toBe(1);
  });
});

/** A polyline from points, with arc length as cumulative distance. */
function line(points: [number, number][]) {
  const x = points.map((p) => p[0]);
  const y = points.map((p) => p[1]);
  const s = [0];
  for (let i = 1; i < points.length; i++) {
    s.push(
      (s[i - 1] as number) +
        Math.hypot(
          (x[i] as number) - (x[i - 1] as number),
          (y[i] as number) - (y[i - 1] as number),
        ),
    );
  }
  return { x, y, s };
}

describe("uTurnsOffStop", () => {
  it("finds a U spread over two right angles that the single-vertex test misses", () => {
    const { x, y, s } = line([
      [0, 0],
      [100, 0],
      [100, 20],
      [0, 20],
    ]);
    expect(shapeFaults(x, y, s).hairpins).toBe(0);
    expect(uTurnsOffStop(x, y, s)).toEqual([{ from: 0, to: 220 }]);
    expect(shapeFaults(x, y, s)).toMatchObject({ uTurns: 1, firstUTurnAt: 0 });
  });

  it("leaves a reversal at an intermediate stop, curves and wide loops alone", () => {
    const u = line([
      [0, 0],
      [100, 0],
      [100, 20],
      [0, 20],
    ]);
    expect(uTurnsOffStop(u.x, u.y, u.s, [0, 110, 220])).toEqual([]);
    expect(uTurnsOffStop(u.x, u.y, u.s, [0, 220])).toHaveLength(1);
    const curve = line([
      [0, 0],
      [100, 0],
      [170, 30],
      [200, 100],
    ]);
    expect(uTurnsOffStop(curve.x, curve.y, curve.s)).toEqual([]);
    const loop = line([
      [0, 0],
      [100, 0],
      [100, 80],
      [0, 80],
    ]);
    expect(uTurnsOffStop(loop.x, loop.y, loop.s)).toEqual([]);
  });

  it("counts a U-turn after a long segment with a stop in its middle", () => {
    const { x, y, s } = line([
      [0, 0],
      [400, 0],
      [400, 20],
      [300, 20],
    ]);
    expect(uTurnsOffStop(x, y, s, [0, 200, 520])).toHaveLength(1);
    expect(uTurnsOffStop(x, y, s, [0, 405, 520])).toEqual([]);
  });

  it("counts a single-vertex spur once", () => {
    const { x, y, s } = line([
      [0, 0],
      [100, 0],
      [60, 1],
      [200, 2],
    ]);
    expect(uTurnsOffStop(x, y, s)).toHaveLength(1);
  });
});

describe("shapeRecordOf", () => {
  it("reports the faults the pack flattens", () => {
    const { record, faults } = shapeRecordOf(
      row([
        [10, 50, 0, 0],
        [10.001, 50, 0, 100],
        [10.002, 50, 0, 90],
        [10.003, 50, 0, 300],
      ]),
    );
    expect(faults.fallingM).toBe(1);
    expect(record.m).toEqual([0, 100, 100, 300]);
  });
});

describe("shapeRecordOf with track stubs (D-055, FORMAT.md 5.3)", () => {
  const line = [
    [10, 50, 100, 0],
    [10.001, 50, 100, 71.6],
    [10.002, 50, 100, 143.3],
  ];
  const west = [
    [10, 50, 100, 0],
    [10, 50.0000007, 100, 0.08],
    [9.999, 50.0000007, 100, 71.7],
    [9.998, 50.0000007, 100, 143.3],
  ];
  const east = [
    [10.002, 50, 100, 0],
    [10.003, 50, 100, 71.6],
  ];
  const withStubs = (stubs: readonly StubRow[]): ShapeRow => ({
    ...row(line),
    stop_arc_m: [0, 143.3],
    stubs,
  });

  it("carries both stubs without the end vertex, distances from it", () => {
    const { record, droppedStubs } = shapeRecordOf(
      withStubs([
        { side: "before", points: west },
        { side: "after", points: east },
      ]),
    );
    expect(droppedStubs).toEqual([]);
    expect(record.stubs?.before?.d).toEqual([0.08, 71.7, 143.3]);
    expect(record.stubs?.before?.x).toHaveLength(3);
    expect(record.stubs?.after?.d).toEqual([71.6]);
    expect((record.stubs?.after?.x[0] ?? 0) - (record.x.at(-1) ?? 0)).toBeCloseTo(111.32, 1);
  });

  it("keeps a stub that starts with a snap under 1 m beside the end vertex", () => {
    const snapped = [
      [10, 50, 100, 0],
      [10, 50.0000072, 100, 0.8],
      [9.999, 50.0000072, 100, 72.4],
    ];
    const { record, droppedStubs } = shapeRecordOf(
      withStubs([{ side: "before", points: snapped }]),
    );
    expect(droppedStubs).toEqual([]);
    expect(record.stubs?.before?.d).toEqual([0.8, 72.4]);
  });

  it("leaves a shape without stub rows as it was", () => {
    expect(shapeRecordOf(row(line)).record.stubs).toBeUndefined();
    expect(shapeRecordOf(withStubs([])).record.stubs).toBeUndefined();
  });

  const faulty: [string, number[][], string][] = [
    [
      "starts away from the end vertex",
      west.map(([a, b, c, d]) => [(a as number) - 0.0001, b as number, c as number, d as number]),
      "start",
    ],
    [
      "runs back along the shape",
      [
        [10, 50, 100, 0],
        [10.001, 50, 100, 71.6],
      ],
      "backwards",
    ],
    [
      "is longer than 400 m",
      [
        [10, 50, 100, 0],
        [9.99, 50, 100, 716],
      ],
      "length",
    ],
    [
      "has falling distance",
      [
        [10, 50, 100, 0],
        [9.999, 50, 100, 71.7],
        [9.998, 50, 100, 60],
      ],
      "distance",
    ],
    [
      "jumps 9 m sideways onto a track before it runs on",
      [
        [10, 50, 100, 0],
        [10, 50.00008, 100, 8.9],
        [9.999, 50.00008, 100, 80.5],
      ],
      "jump",
    ],
    [
      "steps 7 m back along the shape before it runs outward",
      [
        [10, 50, 100, 0],
        [10.0001, 50, 100, 7.2],
        [9.999, 50, 100, 86.4],
      ],
      "jump",
    ],
    [
      "turns back inside",
      [
        [10, 50, 100, 0],
        [9.999, 50, 100, 71.7],
        [9.9995, 50, 100, 107.5],
      ],
      "hairpin",
    ],
  ];

  it("builds the same kernel shape from a 1.2 pack with stubs as from a 1.0 pack without", () => {
    const pack = (stubs: readonly StubRow[]) => {
      const { record } = shapeRecordOf(withStubs(stubs));
      return encodeShapePack({
        kind: "shapePack",
        timetableVersion: 1,
        shapeEpoch: 5,
        shapes: [record],
      });
    };
    const withTrack = pack([{ side: "before", points: west }]);
    const without = pack([]);
    expect(withTrack[5]).toBe(2);
    expect(without[5]).toBe(0);
    const a = shapePolyline(decodeShapePack(withTrack), 0);
    const b = shapePolyline(decodeShapePack(without), 0);
    expect(a.stubBefore?.d.at(-1)).toBe(143.3);
    expect(b.stubBefore).toBeUndefined();
    const kernel = (polyline: typeof a) => {
      const shape = createShape(polyline);
      return [shape.length, shape.vertexCount, Array.from(shape.records)];
    };
    expect(kernel(a)).toEqual(kernel(b));
  });

  it.each(faulty)("drops a stub that %s and names why", (_, points, reason) => {
    const { record, droppedStubs } = shapeRecordOf(withStubs([{ side: "before", points }]));
    expect(record.stubs?.before ?? null).toBeNull();
    expect(droppedStubs).toEqual([`before ${reason}`]);
  });
});

describe("the geometry gate (allowed shapes by number, never by count)", () => {
  const faults = (over: Partial<ShapeFaults>): ShapeFaults => ({
    turns: 0,
    hairpins: 0,
    fallingM: 0,
    firstHairpinAt: null,
    uTurns: 0,
    firstUTurnAt: null,
    ...over,
  });

  it("passes only when every shape with a fault is named for that fault", () => {
    const geometry = newGeometryReport({ uTurnShapes: [105785] });
    noteFaults(geometry, 105785, faults({ uTurns: 1, firstUTurnAt: 26_257 }));
    expect(closeGate(geometry)).toMatchObject({ passed: true, refusedShapes: 0, refused: [] });
    noteFaults(geometry, 7, faults({ uTurns: 1, firstUTurnAt: 10 }));
    expect(closeGate(geometry)).toMatchObject({
      passed: false,
      uTurnShapes: 2,
      refusedShapes: 1,
      refused: [7],
    });
  });

  it("does not let a shape named for U-turns carry a hairpin or falling M", () => {
    const geometry = newGeometryReport({ uTurnShapes: [9] });
    noteFaults(geometry, 9, faults({ uTurns: 1, hairpins: 1, firstHairpinAt: 5 }));
    expect(closeGate(geometry)).toMatchObject({ passed: false, refused: [9] });
    const falling = newGeometryReport({ hairpinShapes: [9], uTurnShapes: [9] });
    noteFaults(falling, 9, faults({ uTurns: 1, hairpins: 1, fallingM: 2 }));
    expect(closeGate(falling).passed).toBe(false);
  });

  it("passes with nothing allowed and nothing found, and names allowed shapes without the fault", () => {
    const geometry = newGeometryReport({ uTurnShapes: [5, 6] });
    noteFaults(geometry, 5, faults({ turns: 3 }));
    noteFaults(geometry, 6, faults({ uTurns: 1 }));
    expect(closeGate(geometry)).toMatchObject({
      passed: true,
      turns: 3,
      allowedUnused: { hairpinShapes: [], fallingMShapes: [], uTurnShapes: [5] },
    });
  });

  it("keeps a U-turn allowance unused when its shape shows only another fault", () => {
    const geometry = newGeometryReport({ uTurnShapes: [9] });
    noteFaults(geometry, 9, faults({ hairpins: 1, firstHairpinAt: 5 }));
    expect(closeGate(geometry)).toMatchObject({
      passed: false,
      refused: [9],
      allowedUnused: { uTurnShapes: [9] },
    });
  });
});

describe("parseShapeNumbers", () => {
  it("reads comma lists of decimal shape numbers, merging repeated options", () => {
    expect(parseShapeNumbers(undefined)).toEqual([]);
    expect(parseShapeNumbers("105785, 106594")).toEqual([105785, 106594]);
    expect(parseShapeNumbers(["105785", "106594,105785"])).toEqual([105785, 106594]);
  });

  it("refuses anything but a positive decimal integer", () => {
    for (const bad of ["8x", "1,,2", "0x10", "1e5", "0b11", "0o7", "+5", "1.0", "-0", "0", "-3"]) {
      expect(() => parseShapeNumbers(bad), bad).toThrow(/shape number/);
    }
  });
});
