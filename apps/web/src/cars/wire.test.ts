import { describe, expect, it } from "vitest";
import type { CarFrame, MeshInstances } from "./car-instances.ts";
import { FleetMerger, fleetOf } from "./fleet.ts";
import { carBuffers, carsOnTheWire } from "./wire.ts";

function instances(mesh: string, lod: number, keys: number[]): MeshInstances {
  const count = keys.length;
  return {
    mesh,
    lod,
    count,
    positions: Float64Array.from(
      { length: 3 * count },
      (_, i) => 7 + (keys[Math.floor(i / 3)] as number),
    ),
    matrices: Float32Array.from({ length: 12 * count }, (_, i) => i),
    colors: Uint8Array.from({ length: 4 * count }, (_, i) => i % 200),
    liveryRows: Float32Array.from(keys),
    lamps: new Float32Array(2 * count),
    selected: new Float32Array(count),
    trainKeys: Int32Array.from(keys),
  };
}

function cars(): CarFrame {
  return {
    meshes: [instances("a", 0, [1, 2]), instances("b", 1, [3])],
    trainKeys: Int32Array.from([1, 2, 3]),
    drawnKeys: Int32Array.from([1, 2]),
    blends: Float32Array.from([1, 0.5]),
    wanted: ["c@1"],
    fade: 0.8,
  };
}

describe("carsOnTheWire", () => {
  it("replaces the per-mesh arrays with the merged fleet and keeps everything else", () => {
    const frame = cars();
    const wire = carsOnTheWire(frame, new FleetMerger());
    expect(wire.meshes).toEqual([]);
    expect(wire.fleet?.ranges.reduce((sum, range) => sum + range.count, 0)).toBe(3);
    expect(wire.fleet?.ranges.map((range) => range.mesh)).toEqual(["a", "b"]);
    expect(wire.wanted).toEqual(["c@1"]);
    expect(wire.fade).toBe(0.8);
    const fleet = fleetOf(wire);
    const keys = fleet.ranges.flatMap((range) => [
      ...fleet.trainKeys.slice(range.start, range.start + range.count),
    ]);
    expect(keys).toEqual([1, 2, 3]);
  });

  it("transfers every array of the frame and nothing else, and the page reads the same numbers", () => {
    const wire = carsOnTheWire(cars(), new FleetMerger());
    const expected = fleetOf(wire);
    const positions = [...expected.positions];
    const matrices = [...expected.matrices];
    const buffers = carBuffers(wire);
    expect(new Set(buffers).size).toBe(buffers.length);
    expect(buffers.length).toBe(10);
    const received = structuredClone(wire, { transfer: buffers });
    expect(wire.fleet?.positions.byteLength).toBe(0);
    expect([...fleetOf(received).positions]).toEqual(positions);
    expect([...fleetOf(received).matrices]).toEqual(matrices);
    expect(received.fleet?.ranges).toEqual(expected.ranges);
    expect(received.fleet?.staticsVersion).toBe(expected.staticsVersion);
  });

  it("keeps the statics version from one posted frame to the next when nothing static changed", () => {
    const merger = new FleetMerger();
    const first = carsOnTheWire(cars(), merger);
    const version = first.fleet?.staticsVersion;
    structuredClone(first, { transfer: carBuffers(first) });
    const second = carsOnTheWire(cars(), merger);
    expect(second.fleet?.staticsVersion).toBe(version);
  });

  it("sends an empty fleet when no car is placed", () => {
    const none: CarFrame = {
      ...cars(),
      meshes: [],
      trainKeys: new Int32Array(0),
      drawnKeys: new Int32Array(0),
      blends: new Float32Array(0),
    };
    const wire = carsOnTheWire(none, new FleetMerger());
    expect(wire.fleet?.count).toBe(0);
    expect(() => structuredClone(wire, { transfer: carBuffers(wire) })).not.toThrow();
  });
});
