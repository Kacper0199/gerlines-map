import { describe, expect, it, vi } from "vitest";
import type { MeshInstances } from "./car-instances.ts";
import { FleetMerger, fleetIndexAttribute, fleetOf, mergeFleet } from "./fleet.ts";
import { shiftedLayouts, unboundAttributes } from "./fleet-layer.ts";

function instances(mesh: string, lod: number, keys: number[]): MeshInstances {
  const count = keys.length;
  return {
    mesh,
    lod,
    count,
    positions: Float64Array.from(
      { length: 3 * count },
      (_, i) => keys[Math.floor(i / 3)] as number,
    ),
    matrices: Float32Array.from(
      { length: 12 * count },
      (_, i) => keys[Math.floor(i / 12)] as number,
    ),
    colors: Uint8Array.from({ length: 4 * count }, (_, i) => keys[Math.floor(i / 4)] as number),
    liveryRows: Float32Array.from(keys),
    lamps: Float32Array.from({ length: 2 * count }, (_, i) => keys[Math.floor(i / 2)] as number),
    selected: new Float32Array(count),
    trainKeys: Int32Array.from(keys),
  };
}

describe("mergeFleet (T-5.2-a)", () => {
  const meshes = [
    instances("a", 0, [1, 2]),
    instances("empty", 0, []),
    instances("b", 1, [3, 4, 5]),
  ];

  it("puts every mesh's instances into one set of arrays, each mesh a contiguous range", () => {
    const fleet = mergeFleet(meshes);
    expect(fleet.count).toBe(5);
    expect(fleet.ranges).toEqual([
      { mesh: "a", lod: 0, start: 0, count: 2 },
      { mesh: "b", lod: 1, start: 2, count: 3 },
    ]);
    expect([...fleet.trainKeys]).toEqual([1, 2, 3, 4, 5]);
    expect([...fleet.liveryRows]).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps the stride of every attribute", () => {
    const fleet = mergeFleet(meshes);
    expect(fleet.positions.length).toBe(15);
    expect(fleet.matrices.length).toBe(60);
    expect(fleet.colors.length).toBe(20);
    expect(fleet.lamps.length).toBe(10);
    expect([...fleet.positions.slice(6, 9)]).toEqual([3, 3, 3]);
    expect([...fleet.matrices.slice(24, 36)]).toEqual(new Array(12).fill(3));
  });

  it("merges a frame once however often it is asked for", () => {
    const frame = { meshes } as never;
    expect(fleetOf(frame)).toBe(fleetOf(frame));
  });
});

describe("fleetIndexAttribute", () => {
  it("counts up from zero and is handed out again until the fleet outgrows it", () => {
    const small = fleetIndexAttribute(3);
    expect([...small.value.slice(0, 4)]).toEqual([0, 1, 2, 3]);
    expect(fleetIndexAttribute(100)).toBe(small);
    const big = fleetIndexAttribute(small.value.length + 1);
    expect(big).not.toBe(small);
    expect(big.value[big.value.length - 1]).toBe(big.value.length - 1);
  });
});

describe("shiftedLayouts", () => {
  const layouts = [
    {
      name: "instanceColors",
      stepMode: "instance",
      byteStride: 4,
      attributes: [{ attribute: "instanceColors", format: "unorm8x4", byteOffset: 0 }],
    },
    {
      name: "instanceModelMatrix",
      stepMode: "instance",
      byteStride: 48,
      attributes: [
        { attribute: "instanceModelMatrixCol0", format: "float32x3", byteOffset: 0 },
        { attribute: "instanceModelMatrixCol1", format: "float32x3", byteOffset: 12 },
      ],
    },
  ] as never;

  it("moves every attribute by the slice start times its buffer's stride", () => {
    const shifted = shiftedLayouts(layouts, 10) as unknown as {
      attributes: { byteOffset: number }[];
    }[];
    expect(shifted[0]?.attributes.map((a) => a.byteOffset)).toEqual([40]);
    expect(shifted[1]?.attributes.map((a) => a.byteOffset)).toEqual([480, 492]);
  });

  it("leaves the layouts alone for a slice that starts at zero", () => {
    expect(shiftedLayouts(layouts, 0)).toBe(layouts);
  });
});

describe("unboundAttributes", () => {
  const buffer = { id: "positions" };
  const attributes = (value: unknown) => ({
    instancePositions: { getValue: () => ({ instancePositions: value }) },
    instanceColors: { getValue: () => ({ instanceColors: "colors" }) },
  });

  it("passes every attribute the first time and only changed buffers afterwards", () => {
    const model = {} as never;
    expect(Object.keys(unboundAttributes(model, attributes(buffer)))).toEqual([
      "instancePositions",
      "instanceColors",
    ]);
    expect(Object.keys(unboundAttributes(model, attributes(buffer)))).toEqual([]);
    expect(Object.keys(unboundAttributes(model, attributes({ id: "grown" })))).toEqual([
      "instancePositions",
    ]);
  });

  it("keeps a separate record for every model", () => {
    expect(Object.keys(unboundAttributes({} as never, attributes(buffer)))).toHaveLength(2);
    expect(Object.keys(unboundAttributes({} as never, attributes(buffer)))).toHaveLength(2);
  });
});

describe("FleetMerger (the worker merges, the page does not)", () => {
  const frameOf = (keys: number[]) => [instances("a", 0, keys), instances("b", 1, [9])];

  it("carries every mesh's values in its range, as the packed merge does, and leaves the room between the slots empty", () => {
    const meshes = frameOf([1, 2, 3]);
    const packed = mergeFleet(meshes);
    const slotted = new FleetMerger().merge(meshes);
    expect(slotted.ranges.map((r) => [r.mesh, r.lod, r.count])).toEqual(
      packed.ranges.map((r) => [r.mesh, r.lod, r.count]),
    );
    expect(slotted.count).toBeGreaterThanOrEqual(packed.count);
    expect(slotted.positions.length).toBe(3 * slotted.count);
    expect(slotted.matrices.length).toBe(12 * slotted.count);
    slotted.ranges.forEach((range, i) => {
      const same = packed.ranges[i] as (typeof packed.ranges)[number];
      expect([...slotted.trainKeys.slice(range.start, range.start + range.count)]).toEqual([
        ...packed.trainKeys.slice(same.start, same.start + same.count),
      ]);
      expect([
        ...slotted.positions.slice(3 * range.start, 3 * (range.start + range.count)),
      ]).toEqual([...packed.positions.slice(3 * same.start, 3 * (same.start + same.count))]);
    });
    const used = new Set(
      slotted.ranges.flatMap((r) => Array.from({ length: r.count }, (_, k) => r.start + k)),
    );
    for (let i = 0; i < slotted.count; i++) {
      if (!used.has(i)) expect(slotted.trainKeys[i]).toBe(0);
    }
  });

  it("keeps each mesh at the same start while its trains come and go", () => {
    const merger = new FleetMerger();
    const startsOf = (keys: number[]) =>
      merger.merge(frameOf(keys)).ranges.map((r) => [r.mesh, r.start]);
    const first = startsOf([1, 2, 3, 4]);
    expect(startsOf([1, 2, 3])).toEqual(first);
    expect(startsOf([1, 2, 3, 4, 5, 6])).toEqual(first);
    expect(startsOf([2])).toEqual(first);
  });

  it("keeps the statics version while colour, livery, lamps and selection stay equal", () => {
    const merger = new FleetMerger();
    const first = merger.merge(frameOf([1, 2, 3]));
    const moved = frameOf([1, 2, 3]);
    (moved[0]?.positions as Float64Array)[0] = 50;
    (moved[0]?.matrices as Float32Array)[3] = 0.5;
    expect(merger.merge(moved).staticsVersion).toBe(first.staticsVersion);
  });

  it("still sees equal statics after the page took the arrays of the last frame (transferred, so empty here)", () => {
    const merger = new FleetMerger();
    const first = merger.merge(frameOf([1, 2, 3]));
    structuredClone(first, {
      transfer: [
        first.colors.buffer,
        first.liveryRows.buffer,
        first.lamps.buffer,
        first.selected.buffer,
      ],
    });
    expect(first.colors.length).toBe(0);
    expect(merger.merge(frameOf([1, 2, 3])).staticsVersion).toBe(first.staticsVersion);
  });

  it("moves to a new version when any static value, or the number of instances, changes", () => {
    const merger = new FleetMerger();
    let version = merger.merge(frameOf([1, 2, 3])).staticsVersion;
    const changes: ((meshes: MeshInstances[]) => void)[] = [
      (meshes) => {
        (meshes[0]?.colors as Uint8Array)[1] = 77;
      },
      (meshes) => {
        (meshes[0]?.liveryRows as Float32Array)[0] = 55;
      },
      (meshes) => {
        (meshes[0]?.lamps as Float32Array)[3] = 2;
      },
      (meshes) => {
        (meshes[1]?.selected as Float32Array)[0] = 1;
      },
    ];
    for (const change of changes) {
      const meshes = frameOf([1, 2, 3]);
      change(meshes);
      const next = merger.merge(meshes).staticsVersion;
      expect(next).not.toBe(version);
      version = next;
      expect(merger.merge(meshes).staticsVersion).toBe(version);
    }
    const bigger = merger.merge(frameOf([1, 2, 3, 4])).staticsVersion;
    expect(bigger).not.toBe(version);
  });

  it("hands the page a fleet that fleetOf returns as it is", () => {
    const fleet = new FleetMerger().merge(frameOf([1, 2]));
    expect(fleetOf({ meshes: [], fleet } as never)).toBe(fleet);
  });

  it("copies the static columns only when they changed", () => {
    const merger = new FleetMerger();
    merger.merge(frameOf([1, 2, 3]));
    const copies = vi.spyOn(Uint8Array.prototype, "slice");
    const floats = vi.spyOn(Float32Array.prototype, "slice");
    try {
      for (let i = 0; i < 5; i++) merger.merge(frameOf([1, 2, 3]));
      expect(copies).not.toHaveBeenCalled();
      expect(floats).not.toHaveBeenCalled();
      const changed = frameOf([1, 2, 3]);
      (changed[0]?.colors as Uint8Array)[1] = 99;
      merger.merge(changed);
      expect(copies).toHaveBeenCalled();
    } finally {
      copies.mockRestore();
      floats.mockRestore();
    }
  });

  it("tells one merger's versions from another's with an epoch", () => {
    const a = new FleetMerger().merge(frameOf([1, 2, 3]));
    const b = new FleetMerger().merge(frameOf([1, 2, 3]));
    expect(a.staticsVersion).toBe(b.staticsVersion);
    expect(a.staticsEpoch).not.toBe(b.staticsEpoch);
    const merger = new FleetMerger();
    expect(merger.merge(frameOf([1])).staticsEpoch).toBe(
      merger.merge(frameOf([1, 2])).staticsEpoch,
    );
  });

  it("counts the slots that moved from one frame to the next and the room it holds (probe numbers)", () => {
    const merger = new FleetMerger();
    merger.merge(frameOf([1, 2, 3]));
    merger.merge(frameOf([1, 2]));
    expect(merger.stats().moves).toBe(0);
    merger.merge([
      instances(
        "a",
        0,
        Array.from({ length: 400 }, (_, i) => i + 1),
      ),
      instances("b", 1, [9]),
    ]);
    expect(merger.stats().moves).toBe(1);
    const stats = merger.stats();
    expect(stats.slots).toBeGreaterThanOrEqual(401);
  });
});
