import { createShapeSample, type Shape, sampleShape } from "./shape.ts";

/** A car with its own two bogies: body length and distance from each body end to its bogie pivot, metres. */
export interface CarSpec {
  readonly length: number;
  readonly bogieInset: number;
}

/**
 * Train geometry measured backwards from the front of the train, in metres of arc length.
 * bogieOffsets are increasing; car c rests on bogies carFront[c] and carRear[c] and its body centre
 * lies at carCentreFraction[c] of the way from the front pivot to the rear pivot.
 */
export interface Consist {
  readonly length: number;
  readonly carCount: number;
  readonly bogieOffsets: Float64Array;
  readonly carFront: Int32Array;
  readonly carRear: Int32Array;
  readonly carCentreFraction: Float64Array;
}

/** Floats per car in placeCars output: x, y (Web Mercator m), z (m), yaw, pitch (radians). */
export const CAR_POSE_STRIDE = 5;

interface ConsistDraft {
  bogies: number[];
  front: number[];
  rear: number[];
  centre: number[];
}

function finishConsist(draft: ConsistDraft, length: number): Consist {
  return {
    length,
    carCount: draft.front.length,
    bogieOffsets: Float64Array.from(draft.bogies),
    carFront: Int32Array.from(draft.front),
    carRear: Int32Array.from(draft.rear),
    carCentreFraction: Float64Array.from(draft.centre),
  };
}

/** Conventional cars, each on its own two bogies, coupled with `couplingGap` metres between bodies. */
export function conventionalConsist(cars: readonly CarSpec[], couplingGap = 0): Consist {
  const draft: ConsistDraft = { bogies: [], front: [], rear: [], centre: [] };
  let offset = 0;
  cars.forEach((car, index) => {
    if (!(car.length > 0 && car.bogieInset >= 0 && 2 * car.bogieInset < car.length)) {
      throw new RangeError(`car ${index} needs both bogies inside its body`);
    }
    if (index > 0) offset += couplingGap;
    draft.front.push(draft.bogies.length);
    draft.bogies.push(offset + car.bogieInset);
    draft.rear.push(draft.bogies.length);
    draft.bogies.push(offset + car.length - car.bogieInset);
    draft.centre.push(0.5);
    offset += car.length;
  });
  return finishConsist(draft, offset);
}

/**
 * An articulated unit with Jacobs bogies: n bodies on n + 1 bogies, neighbouring bodies sharing the
 * bogie at their joint. `endOverhang` is the distance from each end of the unit to its outer bogie.
 */
export function articulatedConsist(bodyLengths: readonly number[], endOverhang: number): Consist {
  const count = bodyLengths.length;
  const first = bodyLengths[0] ?? 0;
  const last = bodyLengths[count - 1] ?? 0;
  if (count === 0 || endOverhang < 0 || endOverhang >= first || endOverhang >= last) {
    throw new RangeError("an articulated unit needs bodies longer than its end overhang");
  }
  const draft: ConsistDraft = { bogies: [endOverhang], front: [], rear: [], centre: [] };
  let bodyStart = 0;
  bodyLengths.forEach((length, index) => {
    const bodyEnd = bodyStart + length;
    const frontPivot = draft.bogies[index] as number;
    const rearPivot = index === count - 1 ? bodyEnd - endOverhang : bodyEnd;
    draft.bogies.push(rearPivot);
    draft.front.push(index);
    draft.rear.push(index + 1);
    draft.centre.push((bodyStart + length / 2 - frontPivot) / (rearPivot - frontPivot));
    bodyStart = bodyEnd;
  });
  return finishConsist(draft, bodyStart);
}

/** Couples units (front to back) with `couplingGap` metres between them. */
export function joinConsists(units: readonly Consist[], couplingGap = 0): Consist {
  const draft: ConsistDraft = { bogies: [], front: [], rear: [], centre: [] };
  let offset = 0;
  units.forEach((unit, index) => {
    if (index > 0) offset += couplingGap;
    const base = draft.bogies.length;
    for (const bogie of unit.bogieOffsets) draft.bogies.push(offset + bogie);
    for (let c = 0; c < unit.carCount; c++) {
      draft.front.push(base + (unit.carFront[c] as number));
      draft.rear.push(base + (unit.carRear[c] as number));
      draft.centre.push(unit.carCentreFraction[c] as number);
    }
    offset += unit.length;
  });
  return finishConsist(draft, offset);
}

/** Floats per bogie in placeBogies output: x, y (Web Mercator m), z (m). */
export const BOGIE_POINT_STRIDE = 3;

const bogieSample = createShapeSample();
let bogieScratch = new Float64Array(64 * BOGIE_POINT_STRIDE);

/**
 * Writes the shape point of every bogie pivot of a train whose front is at arc length `headS`
 * into `out` (BOGIE_POINT_STRIDE floats per bogie) and returns how far the furthest bogie lies
 * beyond either end of the shape (0 when the whole train is on it).
 */
export function placeBogies(
  shape: Shape,
  headS: number,
  consist: Consist,
  out: Float64Array,
): number {
  const bogies = consist.bogieOffsets;
  let hint = 0;
  let beyond = 0;
  for (let b = 0; b < bogies.length; b++) {
    hint = sampleShape(shape, headS - (bogies[b] as number), bogieSample, hint);
    const o = b * BOGIE_POINT_STRIDE;
    out[o] = bogieSample.x;
    out[o + 1] = bogieSample.y;
    out[o + 2] = bogieSample.z;
    if (bogieSample.beyondEnd > beyond) beyond = bogieSample.beyondEnd;
  }
  return beyond;
}

/**
 * Places every car of a train whose front is at arc length `headS`: the bogie pivots are points of
 * the shape, the body centre lies on the chord between its two pivots, yaw is the map-plane angle
 * of the chord (radians, counterclockwise from east, in the direction of travel) and pitch its
 * grade. Writes CAR_POSE_STRIDE floats per car into `out`; returns the same overhang as placeBogies.
 */
export function placeCars(
  shape: Shape,
  headS: number,
  consist: Consist,
  out: Float64Array,
): number {
  const bogies = consist.bogieOffsets;
  if (bogieScratch.length < bogies.length * BOGIE_POINT_STRIDE) {
    bogieScratch = new Float64Array(bogies.length * BOGIE_POINT_STRIDE);
  }
  const points = bogieScratch;
  const beyond = placeBogies(shape, headS, consist, points);
  for (let c = 0; c < consist.carCount; c++) {
    const front = consist.carFront[c] as number;
    const rear = consist.carRear[c] as number;
    const f = consist.carCentreFraction[c] as number;
    const fo = front * BOGIE_POINT_STRIDE;
    const ro = rear * BOGIE_POINT_STRIDE;
    const fx = points[fo] as number;
    const fy = points[fo + 1] as number;
    const fz = points[fo + 2] as number;
    const dx = (points[ro] as number) - fx;
    const dy = (points[ro + 1] as number) - fy;
    const dz = (points[ro + 2] as number) - fz;
    const span = (bogies[rear] as number) - (bogies[front] as number);
    const o = c * CAR_POSE_STRIDE;
    out[o] = fx + f * dx;
    out[o + 1] = fy + f * dy;
    out[o + 2] = fz + f * dz;
    out[o + 3] = Math.atan2(-dy, -dx);
    out[o + 4] = Math.asin(Math.max(-1, Math.min(1, -dz / span)));
  }
  return beyond;
}
