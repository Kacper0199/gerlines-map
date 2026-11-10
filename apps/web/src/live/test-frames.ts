import {
  type Delta,
  encodeDelta,
  encodeHead,
  encodeKeyframe,
  encodeShapePack,
  type Head,
  type Keyframe,
  type StopRecord,
  type TripRecord,
} from "@gerlines/live-frame";

export const TIME_BASE = 1_792_940_400;

export function stop(arrival: number, departure = arrival): StopRecord {
  return { arrival, departure, cancelled: false, realtime: false, s: null };
}

export function trip(key: number, overrides: Partial<TripRecord> = {}): TripRecord {
  return {
    key,
    shapeId: 7,
    category: "reg",
    realtime: false,
    cancelled: false,
    foreign: false,
    delay: null,
    line: "RE 1",
    trainNumber: 4711,
    firstStop: 0,
    stops: [stop(TIME_BASE), stop(TIME_BASE + 600)],
    ...overrides,
  };
}

export function keyframe(sequence: number, trips: TripRecord[], timetableVersion = 1): Keyframe {
  return {
    kind: "keyframe",
    sequence,
    timetableVersion,
    shapeEpoch: 3,
    timeBase: TIME_BASE + sequence,
    trips,
  };
}

export function delta(
  sequence: number,
  trips: TripRecord[],
  removed: number[] = [],
  timetableVersion = 1,
): Delta {
  return {
    kind: "delta",
    sequence,
    baseSequence: sequence - 1,
    timetableVersion,
    shapeEpoch: 3,
    timeBase: TIME_BASE + sequence,
    trips,
    removed,
  };
}

export function head(
  sequence: number,
  keyframeSequence: number,
  oldestSequence: number,
  timetableVersion = 1,
): Head {
  return {
    kind: "head",
    sequence,
    timetableVersion,
    timeBase: TIME_BASE + sequence,
    keyframeSequence,
    oldestSequence,
  };
}

export class ObjectStore {
  readonly requested: string[] = [];
  private readonly objects = new Map<string, Uint8Array>();

  putKeyframe(frame: Keyframe): void {
    this.objects.set(`k/${frame.sequence}.bin`, encodeKeyframe(frame));
  }

  putDelta(frame: Delta): void {
    this.objects.set(`d/${frame.sequence}.bin`, encodeDelta(frame));
  }

  putRaw(path: string, bytes: Uint8Array): void {
    this.objects.set(path, bytes);
  }

  drop(path: string): void {
    this.objects.delete(path);
  }

  read = async (path: string): Promise<Uint8Array | null> => {
    this.requested.push(path);
    return this.objects.get(path) ?? null;
  };
}

export { encodeHead };

export const SHAPE_Y = 6_000_000;
export const SHAPE_X0 = 1_000_000;

/**
 * A pack of one straight eastbound shape of `lengthM` metres with a stop every `lengthM / 4`
 * (flat mercator metres stand in for ground metres, which only matters for the arc length we pass
 * as M).
 */
export function straightPack(
  number: number,
  lengthM = 40_000,
  epoch = 3,
  hashOf: number = number,
  heights?: { readonly start: number; readonly slope: number },
  at: { readonly x: number; readonly y: number } = { x: SHAPE_X0, y: SHAPE_Y },
): Uint8Array {
  const vertices = 41;
  const step = lengthM / (vertices - 1);
  const x = Array.from({ length: vertices }, (_, i) => at.x + i * step);
  const y = Array.from({ length: vertices }, () => at.y);
  const m = Array.from({ length: vertices }, (_, i) => i * step);
  return encodeShapePack({
    kind: "shapePack",
    timetableVersion: 1,
    shapeEpoch: epoch,
    shapes: [
      {
        hash: hashOf.toString(16).padStart(64, "0"),
        number: epoch >= 1 ? number : null,
        x,
        y,
        z: heights ? m.map((metres) => heights.start + metres * heights.slope) : null,
        m,
        length: lengthM,
        stops: [0, lengthM / 4, lengthM / 2, lengthM],
        tunnels: [],
      },
    ],
  });
}
