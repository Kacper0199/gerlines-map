import type { CarFrame } from "./car-instances.ts";
import type { FleetMerger } from "./fleet.ts";

/** The car frame as the worker posts it: the instances merged into one fleet, the per-mesh arrays left out. */
export function carsOnTheWire(cars: CarFrame, merger: FleetMerger): CarFrame {
  return { ...cars, meshes: [], fleet: merger.merge(cars.meshes) };
}

/** Every buffer of a frame posted by `carsOnTheWire`, to be transferred instead of copied. */
export function carBuffers(cars: CarFrame): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [
    cars.trainKeys.buffer as ArrayBuffer,
    cars.drawnKeys.buffer as ArrayBuffer,
    cars.blends.buffer as ArrayBuffer,
  ];
  const { fleet } = cars;
  if (fleet) {
    buffers.push(
      fleet.positions.buffer as ArrayBuffer,
      fleet.matrices.buffer as ArrayBuffer,
      fleet.colors.buffer as ArrayBuffer,
      fleet.liveryRows.buffer as ArrayBuffer,
      fleet.lamps.buffer as ArrayBuffer,
      fleet.selected.buffer as ArrayBuffer,
      fleet.trainKeys.buffer as ArrayBuffer,
    );
  }
  return buffers;
}
