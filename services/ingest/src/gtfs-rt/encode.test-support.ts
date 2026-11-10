/** Hand-built protocol buffer bytes for decoder, adapter and processor tests. */

export function varint(value: number | bigint): number[] {
  const bytes: number[] = [];
  let rest = BigInt.asUintN(64, BigInt(value));
  while (rest >= 0x80n) {
    bytes.push(Number(rest & 0x7fn) | 0x80);
    rest >>= 7n;
  }
  bytes.push(Number(rest));
  return bytes;
}

const key = (field: number, wire: number) => varint(field * 8 + wire);

export const bytesField = (field: number, payload: readonly number[]): number[] => [
  ...key(field, 2),
  ...varint(payload.length),
  ...payload,
];

export const textField = (field: number, value: string): number[] =>
  bytesField(field, [...Buffer.from(value)]);

export const intField = (field: number, value: number | bigint): number[] => [
  ...key(field, 0),
  ...varint(value),
];

export interface StopUpdateSpec {
  readonly sequence: number;
  readonly stopId: string;
  readonly delay?: number;
  readonly time?: number | bigint;
}

export interface TripUpdateSpec {
  readonly entityId: string;
  readonly tripId: string;
  readonly startDate: string;
  readonly routeId: string;
  readonly stops: readonly StopUpdateSpec[];
  readonly delay?: number;
}

function stopTimeEvent(stop: StopUpdateSpec): number[] {
  return [
    ...(stop.delay === undefined ? [] : intField(1, stop.delay)),
    ...(stop.time === undefined ? [] : intField(2, stop.time)),
  ];
}

/** A FeedMessage with one trip update per spec and a header naming `feedVersion`. */
export function tripUpdateFeed(
  feedVersion: string | null,
  trips: readonly TripUpdateSpec[],
): Uint8Array {
  const entities = trips.map((spec) => {
    const trip = [
      ...textField(1, spec.tripId),
      ...textField(3, spec.startDate),
      ...textField(5, spec.routeId),
    ];
    const stops = spec.stops.map((stop) => {
      const event = stopTimeEvent(stop);
      return bytesField(2, [
        ...intField(1, stop.sequence),
        ...bytesField(2, event),
        ...bytesField(3, event),
        ...textField(4, stop.stopId),
      ]);
    });
    const update = [
      ...bytesField(1, trip),
      ...stops.flat(),
      ...(spec.delay === undefined ? [] : intField(5, spec.delay)),
    ];
    return bytesField(2, [...textField(1, spec.entityId), ...bytesField(3, update)]);
  });
  const header = [
    ...textField(1, "2.0"),
    ...intField(3, 1_800_000_000),
    ...(feedVersion === null ? [] : textField(4, feedVersion)),
  ];
  return Uint8Array.from([...bytesField(1, header), ...entities.flat()]);
}
