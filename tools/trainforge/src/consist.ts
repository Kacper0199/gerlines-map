import { type BogieSpec, bogieKey } from "./spec.ts";

export interface ConsistCar {
  readonly length: number;
  readonly bogies: readonly [BogieSpec, BogieSpec];
  readonly reversed: boolean;
}

export interface ConsistPivot {
  readonly offset: number;
  readonly kind: BogieSpec["kind"];
  /** Bogie file key: a Jacobs pivot takes the Jacobs wheelbase, preferring a sourced one. */
  readonly bogie: string;
}

/**
 * The unit measured backwards from its front, as `@gerlines/geo` Consist expects: bogie pivots in
 * increasing offset (a Jacobs bogie once), and per car its front and rear pivot and where its centre
 * lies between them.
 */
export interface ConsistLayout {
  readonly length: number;
  readonly bogieOffsets: readonly number[];
  readonly pivots: readonly ConsistPivot[];
  readonly cars: readonly {
    readonly frontOffset: number;
    readonly front: number;
    readonly rear: number;
    readonly centreFraction: number;
  }[];
}

const round = (value: number) => Math.round(value * 1e6) / 1e6;

export function consistLayout(cars: readonly ConsistCar[]): ConsistLayout {
  const offsets: number[] = [];
  const bogiesAt: BogieSpec[][] = [];
  const indexOf = (offset: number, bogie: BogieSpec) => {
    const key = round(offset);
    const found = offsets.indexOf(key);
    if (found >= 0) {
      bogiesAt[found]?.push(bogie);
      return found;
    }
    offsets.push(key);
    bogiesAt.push([bogie]);
    return offsets.length - 1;
  };
  let cursor = 0;
  const placed = cars.map((car) => {
    const xs = car.bogies
      .map((b) => ({ x: car.reversed ? -b.x : b.x, bogie: b }))
      .sort((a, b) => b.x - a.x);
    const [first, second] = xs as [(typeof xs)[number], (typeof xs)[number]];
    const centre = cursor + car.length / 2;
    const result = {
      frontOffset: round(cursor),
      front: indexOf(centre - first.x, first.bogie),
      rear: indexOf(centre - second.x, second.bogie),
      centre,
    };
    cursor += car.length;
    return result;
  });
  const order = offsets.map((o, i) => [o, i] as const).sort((a, b) => a[0] - b[0]);
  const remap = new Map(order.map(([, i], rank) => [i, rank]));
  const sorted = order.map(([o]) => o);
  return {
    length: round(cursor),
    bogieOffsets: sorted,
    pivots: order.map(([offset, i]) => {
      const candidates = bogiesAt[i] as BogieSpec[];
      const chosen = candidates.find((b) => !b.estimated) ?? (candidates[0] as BogieSpec);
      return { offset, kind: chosen.kind, bogie: bogieKey(chosen) };
    }),
    cars: placed.map((p) => {
      const front = remap.get(p.front) as number;
      const rear = remap.get(p.rear) as number;
      const f = sorted[front] as number;
      const r = sorted[rear] as number;
      return {
        frontOffset: p.frontOffset,
        front,
        rear,
        centreFraction: round((p.centre - f) / (r - f)),
      };
    }),
  };
}
