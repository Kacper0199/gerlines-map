import {
  CATEGORIES,
  type Category,
  DELAY_UNKNOWN,
  MAX_U8,
  MAX_U16,
  MAX_U32,
  NO_STRING,
  SECTION,
  STOP_FLAG,
  TRIP_FLAG,
  VEHICLE_MINOR,
} from "./constants.ts";
import {
  type Container,
  type ContainerLayout,
  type FrameHeader,
  optionalSection,
  readContainer,
  type SectionInput,
  section,
  writeContainer,
} from "./container.ts";
import { centimetres, requireInteger } from "./encode-util.ts";
import { corrupt } from "./errors.ts";
import type { Delta, Keyframe, StopRecord, TripRecord } from "./model.ts";
import {
  readShapeTable,
  type ShapeId,
  ShapeIdWriter,
  type ShapeTable,
  shapeIdAt,
  shapeKey,
} from "./shape-ids.ts";
import { strictUtf8Decoder, utf8Encoder } from "./text.ts";

const MIN_I32 = -0x80000000;
const MAX_I32 = 0x7fffffff;
const MIN_PLAN_STOPS = 2;
const UNKNOWN_TIME = STOP_FLAG.arrivalUnknown | STOP_FLAG.departureUnknown;

/** Trip table columns (FORMAT.md 3.1) plus offsets computed while decoding. */
export interface TripColumns {
  readonly count: number;
  readonly key: Uint32Array;
  readonly shape: Uint16Array;
  readonly category: Uint8Array;
  readonly flags: Uint8Array;
  readonly delay: Int16Array;
  readonly firstStop: Uint16Array;
  readonly stopCount: Uint16Array;
  readonly start: Int32Array;
  readonly line: Uint16Array;
  readonly trainNumber: Uint32Array;
  /** count + 1 entries: the trip's first row in the stop table; the last entry is the stop count. */
  readonly stopOffset: Uint32Array;
  /** The trip's first row in `stops.arc`, -1 for trips without explicit arc positions. */
  readonly arcOffset: Int32Array;
}

/**
 * The trips' vehicles (FORMAT.md 3.1.1), one row per trip: series and operator are rows in the
 * string table (NO_STRING none), units 0 when unknown.
 */
export interface VehicleColumns {
  readonly series: Uint16Array;
  readonly operator: Uint16Array;
  readonly units: Uint8Array;
}

export interface StopColumns {
  readonly count: number;
  readonly run: Uint16Array;
  readonly dwell: Uint16Array;
  readonly flags: Uint8Array;
  readonly arc: Uint32Array;
}

/**
 * A decoded keyframe or delta as typed columns. Columns may be views of the input buffer: treat
 * them as read-only and keep the buffer unchanged while the view is in use.
 */
export interface FrameView {
  readonly header: FrameHeader;
  readonly trips: TripColumns;
  readonly stops: StopColumns;
  readonly shapes: ShapeTable;
  readonly strings: readonly string[];
  /** The trips' vehicles of a 1.3 frame, null when the frame carries none. */
  readonly vehicle: VehicleColumns | null;
  /** Keys removed by a delta, ascending; empty for a keyframe. */
  readonly removed: Uint32Array;
}

const FRAME_SECTIONS = [
  SECTION.tripKey,
  SECTION.tripShape,
  SECTION.tripCategory,
  SECTION.tripFlags,
  SECTION.tripDelay,
  SECTION.tripFirstStop,
  SECTION.tripStopCount,
  SECTION.tripStart,
  SECTION.tripLine,
  SECTION.tripTrainNumber,
  SECTION.tripSeries,
  SECTION.tripOperator,
  SECTION.tripUnits,
  SECTION.stopRun,
  SECTION.stopDwell,
  SECTION.stopFlags,
  SECTION.stopArc,
  SECTION.shapeId,
  SECTION.shapeNumber,
  SECTION.stringOffsets,
  SECTION.stringBytes,
];
const KEYFRAME_KNOWN: ReadonlySet<number> = new Set(FRAME_SECTIONS);
const DELTA_KNOWN: ReadonlySet<number> = new Set([...FRAME_SECTIONS, SECTION.removed]);

class Interner<T> {
  readonly rows = new Map<string, number>();
  readonly values: T[] = [];

  row(key: string, value: () => T, limit: number, name: string): number {
    const existing = this.rows.get(key);
    if (existing !== undefined) return existing;
    if (this.values.length >= limit) throw new RangeError(`more than ${limit} ${name}`);
    this.rows.set(key, this.values.length);
    this.values.push(value());
    return this.values.length - 1;
  }
}

interface TripBuffers {
  key: Uint32Array;
  shape: Uint16Array;
  category: Uint8Array;
  flags: Uint8Array;
  delay: Int16Array;
  firstStop: Uint16Array;
  stopCount: Uint16Array;
  start: Int32Array;
  line: Uint16Array;
  trainNumber: Uint32Array;
  vehicle: { series: Uint16Array; operator: Uint16Array; units: Uint8Array } | null;
  run: Uint16Array;
  dwell: Uint16Array;
  stopFlags: Uint8Array;
  arc: number[];
  shapes: ShapeIdWriter;
  strings: Interner<string>;
}

function categoryCode(category: Category): number {
  const code = CATEGORIES.indexOf(category);
  if (code < 0) throw new RangeError(`unknown category ${String(category)}`);
  return code;
}

function tripFlags(trip: TripRecord, explicit: boolean): number {
  return (
    (trip.realtime ? TRIP_FLAG.realtime : 0) |
    (trip.cancelled ? TRIP_FLAG.cancelled : 0) |
    (trip.foreign ? TRIP_FLAG.foreign : 0) |
    (explicit ? TRIP_FLAG.explicitArc : 0)
  );
}

function hasExplicitArcs(trip: TripRecord): boolean {
  const given = trip.stops.filter((stop) => stop.s !== null).length;
  if (given !== 0 && given !== trip.stops.length) {
    throw new RangeError(`trip ${trip.key}: give s for every stop or for none`);
  }
  return given > 0;
}

function stopTimes(stop: StopRecord, name: string): { arrival: number; departure: number } {
  const arrival = stop.arrival ?? stop.departure;
  const departure = stop.departure ?? stop.arrival;
  if (arrival === null || departure === null) {
    throw new RangeError(`${name} has neither arrival nor departure`);
  }
  return {
    arrival: requireInteger(arrival, 0, MAX_U32, `${name} arrival`),
    departure: requireInteger(departure, 0, MAX_U32, `${name} departure`),
  };
}

function stopFlags(stop: StopRecord): number {
  return (
    (stop.arrival === null ? STOP_FLAG.arrivalUnknown : 0) |
    (stop.departure === null ? STOP_FLAG.departureUnknown : 0) |
    (stop.cancelled ? STOP_FLAG.cancelled : 0) |
    (stop.realtime ? STOP_FLAG.realtime : 0)
  );
}

function writeStops(
  trip: TripRecord,
  explicit: boolean,
  row: number,
  timeBase: number,
  out: TripBuffers,
): number {
  let previousDeparture = 0;
  let previousArc = 0;
  trip.stops.forEach((stop, j) => {
    const name = `trip ${trip.key} stop ${j}`;
    const { arrival, departure } = stopTimes(stop, name);
    if (j === 0) {
      out.run[row] = 0;
    } else {
      out.run[row + j] = requireInteger(arrival - previousDeparture, 0, MAX_U16, `${name} run`);
    }
    out.dwell[row + j] = requireInteger(departure - arrival, 0, MAX_U16, `${name} dwell`);
    out.stopFlags[row + j] = stopFlags(stop);
    previousDeparture = departure;
    if (explicit) {
      const arc = centimetres(stop.s as number, `${name} s`);
      if (arc < previousArc) throw new RangeError(`${name} s decreases`);
      out.arc.push(arc);
      previousArc = arc;
    }
  });
  const first = stopTimes(trip.stops[0] as StopRecord, `trip ${trip.key} stop 0`);
  return requireInteger(first.arrival - timeBase, MIN_I32, MAX_I32, `trip ${trip.key} start`);
}

function stringRow(text: string | null | undefined, out: TripBuffers, name: string): number {
  if (text === null || text === undefined) return NO_STRING;
  return out.strings.row(text, () => text, NO_STRING, name);
}

function namesVehicle(trip: TripRecord): boolean {
  return trip.series !== undefined || trip.operator !== undefined || trip.units !== undefined;
}

function writeVehicle(trip: TripRecord, i: number, out: TripBuffers): void {
  const vehicle = out.vehicle;
  if (!vehicle) return;
  vehicle.series[i] = stringRow(trip.series, out, "strings");
  vehicle.operator[i] = stringRow(trip.operator, out, "strings");
  vehicle.units[i] =
    trip.units === null || trip.units === undefined
      ? 0
      : requireInteger(trip.units, 1, MAX_U8, `trip ${trip.key} units`);
}

function writeTrip(trip: TripRecord, i: number, row: number, timeBase: number, out: TripBuffers) {
  const explicit = hasExplicitArcs(trip);
  out.key[i] = trip.key;
  out.shape[i] = out.shapes.row(trip.shapeId, `trip ${trip.key} shapeId`);
  out.category[i] = categoryCode(trip.category);
  out.flags[i] = tripFlags(trip, explicit);
  out.delay[i] =
    trip.delay === null
      ? DELAY_UNKNOWN
      : requireInteger(trip.delay, DELAY_UNKNOWN + 1, 0x7fff, `trip ${trip.key} delay`);
  out.firstStop[i] = requireInteger(trip.firstStop, 0, MAX_U16, `trip ${trip.key} firstStop`);
  out.stopCount[i] = requireInteger(
    trip.stops.length,
    MIN_PLAN_STOPS,
    MAX_U16,
    `trip ${trip.key} stops`,
  );
  out.line[i] = stringRow(trip.line, out, "line names");
  writeVehicle(trip, i, out);
  out.trainNumber[i] =
    trip.trainNumber === null
      ? 0
      : requireInteger(trip.trainNumber, 1, MAX_U32, `trip ${trip.key} trainNumber`);
  out.start[i] = writeStops(trip, explicit, row, timeBase, out);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function rowOrder(a: TripRecord, b: TripRecord): number {
  if (a.line !== b.line) {
    if (a.line === null) return 1;
    if (b.line === null) return -1;
    return compareText(a.line, b.line);
  }
  return compareText(shapeKey(a.shapeId), shapeKey(b.shapeId)) || a.key - b.key;
}

/** Rows grouped by line, then shape, then key: neighbouring plans repeat, which compresses well. */
function orderedTrips(trips: readonly TripRecord[]): TripRecord[] {
  const keys = new Set<number>();
  for (const trip of trips) {
    requireInteger(trip.key, 0, MAX_U32, "trip key");
    if (keys.has(trip.key)) throw new RangeError(`trip key ${trip.key} repeated`);
    keys.add(trip.key);
  }
  return [...trips].sort(rowOrder);
}

function stringSections(strings: readonly string[]): SectionInput[] {
  const encoder = utf8Encoder();
  const encoded = strings.map((text) => encoder.encode(text));
  const offsets = new Uint32Array(strings.length + 1);
  encoded.forEach((bytes, i) => {
    offsets[i + 1] = (offsets[i] as number) + bytes.length;
  });
  const bytes = new Uint8Array(offsets[strings.length] as number);
  encoded.forEach((text, i) => {
    bytes.set(text, offsets[i] as number);
  });
  return [
    { id: SECTION.stringOffsets, data: offsets },
    { id: SECTION.stringBytes, data: bytes },
  ];
}

interface FrameSections {
  readonly sections: SectionInput[];
  readonly layout: ContainerLayout;
}

function tripSections(
  trips: readonly TripRecord[],
  timeBase: number,
  shapeEpoch: number,
): FrameSections {
  const sorted = orderedTrips(trips);
  const stopTotal = sorted.reduce((sum, trip) => sum + trip.stops.length, 0);
  const n = sorted.length;
  const out: TripBuffers = {
    key: new Uint32Array(n),
    shape: new Uint16Array(n),
    category: new Uint8Array(n),
    flags: new Uint8Array(n),
    delay: new Int16Array(n),
    firstStop: new Uint16Array(n),
    stopCount: new Uint16Array(n),
    start: new Int32Array(n),
    line: new Uint16Array(n),
    trainNumber: new Uint32Array(n),
    vehicle: sorted.some(namesVehicle)
      ? { series: new Uint16Array(n), operator: new Uint16Array(n), units: new Uint8Array(n) }
      : null,
    run: new Uint16Array(stopTotal),
    dwell: new Uint16Array(stopTotal),
    stopFlags: new Uint8Array(stopTotal),
    arc: [],
    shapes: new ShapeIdWriter(shapeEpoch),
    strings: new Interner<string>(),
  };
  let row = 0;
  sorted.forEach((trip, i) => {
    writeTrip(trip, i, row, timeBase, out);
    row += trip.stops.length;
  });
  const vehicle = out.vehicle;
  const sections: SectionInput[] = [
    { id: SECTION.tripKey, data: out.key },
    { id: SECTION.tripShape, data: out.shape },
    { id: SECTION.tripCategory, data: out.category },
    { id: SECTION.tripFlags, data: out.flags },
    { id: SECTION.tripDelay, data: out.delay },
    { id: SECTION.tripFirstStop, data: out.firstStop },
    { id: SECTION.tripStopCount, data: out.stopCount },
    { id: SECTION.tripStart, data: out.start },
    { id: SECTION.tripLine, data: out.line },
    { id: SECTION.tripTrainNumber, data: out.trainNumber },
    { id: SECTION.stopRun, data: out.run },
    { id: SECTION.stopDwell, data: out.dwell },
    { id: SECTION.stopFlags, data: out.stopFlags },
    { id: SECTION.stopArc, data: Uint32Array.from(out.arc) },
    ...out.shapes.sections(),
    ...stringSections(out.strings.values),
  ];
  if (!vehicle) return { sections, layout: {} };
  sections.push(
    { id: SECTION.tripSeries, data: vehicle.series },
    { id: SECTION.tripOperator, data: vehicle.operator },
    { id: SECTION.tripUnits, data: vehicle.units },
  );
  return { sections, layout: { versionMinor: VEHICLE_MINOR } };
}

export function encodeKeyframe(frame: Keyframe): Uint8Array<ArrayBuffer> {
  requireInteger(frame.sequence, 1, MAX_U32, "keyframe sequence");
  const { sections, layout } = tripSections(frame.trips, frame.timeBase, frame.shapeEpoch);
  return writeContainer("keyframe", { ...frame, baseSequence: 0 }, sections, layout);
}

export function encodeDelta(frame: Delta): Uint8Array<ArrayBuffer> {
  requireInteger(frame.sequence, 2, MAX_U32, "delta sequence");
  if (frame.baseSequence !== frame.sequence - 1) {
    throw new RangeError(`baseSequence ${frame.baseSequence} must be ${frame.sequence - 1}`);
  }
  const removed = [...frame.removed].sort((a, b) => a - b);
  const keys = new Set(frame.trips.map((trip) => trip.key));
  removed.forEach((key, i) => {
    requireInteger(key, 0, MAX_U32, "removed key");
    if (i > 0 && removed[i - 1] === key) throw new RangeError(`removed key ${key} repeated`);
    if (keys.has(key)) throw new RangeError(`key ${key} both updated and removed`);
  });
  const { sections, layout } = tripSections(frame.trips, frame.timeBase, frame.shapeEpoch);
  return writeContainer(
    "delta",
    frame,
    [...sections, { id: SECTION.removed, data: Uint32Array.from(removed) }],
    layout,
  );
}

function sameLength(count: number, columns: readonly ArrayLike<number>[], table: string): void {
  if (columns.some((column) => column.length !== count))
    corrupt(`${table} columns differ in length`);
}

function readStrings(container: Container): string[] {
  const offsets = section(container, SECTION.stringOffsets, "u32");
  const bytes = section(container, SECTION.stringBytes, "u8");
  if (offsets.length === 0 || offsets[0] !== 0 || offsets.at(-1) !== bytes.length) {
    corrupt("string offsets do not span the string bytes");
  }
  const decoder = strictUtf8Decoder();
  const strings: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i + 1 < offsets.length; i++) {
    const from = offsets[i] as number;
    const to = offsets[i + 1] as number;
    if (to < from) corrupt("string offsets decrease");
    let text: string;
    try {
      text = decoder.decode(bytes.subarray(from, to));
    } catch {
      corrupt(`string ${i} is not UTF-8`);
    }
    if (seen.has(text)) corrupt(`string ${i} repeated`);
    seen.add(text);
    strings.push(text);
  }
  return strings;
}

function readTripColumns(container: Container) {
  const key = section(container, SECTION.tripKey, "u32");
  const columns = {
    key,
    shape: section(container, SECTION.tripShape, "u16"),
    category: section(container, SECTION.tripCategory, "u8"),
    flags: section(container, SECTION.tripFlags, "u8"),
    delay: section(container, SECTION.tripDelay, "i16"),
    firstStop: section(container, SECTION.tripFirstStop, "u16"),
    stopCount: section(container, SECTION.tripStopCount, "u16"),
    start: section(container, SECTION.tripStart, "i32"),
    line: section(container, SECTION.tripLine, "u16"),
    trainNumber: section(container, SECTION.tripTrainNumber, "u32"),
  };
  sameLength(key.length, Object.values(columns), "trip");
  return columns;
}

function readStopColumns(container: Container) {
  const run = section(container, SECTION.stopRun, "u16");
  const dwell = section(container, SECTION.stopDwell, "u16");
  const flags = section(container, SECTION.stopFlags, "u8");
  sameLength(run.length, [dwell, flags], "stop");
  return { count: run.length, run, dwell, flags, arc: section(container, SECTION.stopArc, "u32") };
}

function checkTripRow(
  trips: ReturnType<typeof readTripColumns>,
  i: number,
  shapeCount: number,
  stringCount: number,
): void {
  if ((trips.shape[i] as number) >= shapeCount) corrupt(`trip ${i} shape row out of range`);
  const line = trips.line[i] as number;
  if (line !== NO_STRING && line >= stringCount) corrupt(`trip ${i} line row out of range`);
  if ((trips.stopCount[i] as number) < MIN_PLAN_STOPS)
    corrupt(`trip ${i} has fewer than two stops`);
}

function checkStopFlags(stops: StopColumns, from: number, to: number, trip: number): void {
  for (let row = from; row < to; row++) {
    const unknown = (stops.flags[row] as number) & UNKNOWN_TIME;
    if (unknown === UNKNOWN_TIME) corrupt(`trip ${trip} stop ${row - from} has both times unknown`);
    if (unknown !== 0 && stops.dwell[row] !== 0) {
      corrupt(`trip ${trip} stop ${row - from} has an unknown time and a dwell`);
    }
  }
}

function checkArcs(arc: Uint32Array, from: number, count: number, trip: number): void {
  for (let j = from + 1; j < from + count; j++) {
    if ((arc[j] as number) < (arc[j - 1] as number)) corrupt(`trip ${trip} arc positions decrease`);
  }
}

function tripOffsets(
  trips: ReturnType<typeof readTripColumns>,
  stops: StopColumns,
  shapeCount: number,
  stringCount: number,
): { stopOffset: Uint32Array; arcOffset: Int32Array } {
  const count = trips.key.length;
  const stopOffset = new Uint32Array(count + 1);
  const arcOffset = new Int32Array(count);
  let arcRow = 0;
  for (let i = 0; i < count; i++) {
    checkTripRow(trips, i, shapeCount, stringCount);
    const stopCount = trips.stopCount[i] as number;
    const first = stopOffset[i] as number;
    stopOffset[i + 1] = first + stopCount;
    if ((stopOffset[i + 1] as number) > stops.count) corrupt("stop table shorter than trips need");
    if (stops.run[first] !== 0) corrupt(`trip ${i} first stop has a run time`);
    checkStopFlags(stops, first, first + stopCount, i);
    if ((trips.flags[i] as number) & TRIP_FLAG.explicitArc) {
      if (arcRow + stopCount > stops.arc.length) corrupt("arc column shorter than trips need");
      checkArcs(stops.arc, arcRow, stopCount, i);
      arcOffset[i] = arcRow;
      arcRow += stopCount;
    } else {
      arcOffset[i] = -1;
    }
  }
  if (stopOffset[count] !== stops.count) corrupt("stop table longer than trips need");
  if (new Set(trips.key).size !== count) corrupt("trip key repeated");
  if (arcRow !== stops.arc.length) corrupt("arc column longer than trips need");
  return { stopOffset, arcOffset };
}

/** The three vehicle columns of FORMAT.md 3.1.1: all or none, one row per trip, rows in range. */
function readVehicle(
  container: Container,
  count: number,
  stringCount: number,
): VehicleColumns | null {
  const series = optionalSection(container, SECTION.tripSeries, "u16");
  const operator = optionalSection(container, SECTION.tripOperator, "u16");
  const units = optionalSection(container, SECTION.tripUnits, "u8");
  if (!series && !operator && !units) return null;
  if (!series || !operator || !units) corrupt("vehicle columns incomplete");
  sameLength(count, [series, operator, units], "vehicle");
  for (let i = 0; i < count; i++) {
    for (const row of [series[i] as number, operator[i] as number]) {
      if (row !== NO_STRING && row >= stringCount) corrupt(`trip ${i} vehicle string out of range`);
    }
  }
  return { series, operator, units };
}

function readRemoved(container: Container, keys: Uint32Array): Uint32Array {
  const removed = section(container, SECTION.removed, "u32");
  const updated = new Set(keys);
  for (let i = 0; i < removed.length; i++) {
    const key = removed[i] as number;
    if (i > 0 && key <= (removed[i - 1] as number)) corrupt("removed keys not ascending");
    if (updated.has(key)) corrupt(`key ${key} both updated and removed`);
  }
  return removed;
}

function readFrame(container: Container): FrameView {
  const strings = readStrings(container);
  const shapes = readShapeTable(container);
  const columns = readTripColumns(container);
  const stops = readStopColumns(container);
  const offsets = tripOffsets(columns, stops, shapes.count, strings.length);
  const vehicle = readVehicle(container, columns.key.length, strings.length);
  const removed =
    container.header.kind === "delta" ? readRemoved(container, columns.key) : new Uint32Array(0);
  return {
    header: container.header,
    trips: { count: columns.key.length, ...columns, ...offsets },
    stops,
    shapes,
    strings,
    vehicle,
    removed,
  };
}

/** Decodes and validates a keyframe; throws FrameDecodeError. */
export function decodeKeyframe(input: ArrayBufferLike | ArrayBufferView): FrameView {
  const container = readContainer(input, "keyframe", KEYFRAME_KNOWN);
  if (container.header.sequence < 1) corrupt("keyframe sequence 0");
  return readFrame(container);
}

/** Decodes and validates a delta; throws FrameDecodeError. */
export function decodeDelta(input: ArrayBufferLike | ArrayBufferView): FrameView {
  const container = readContainer(input, "delta", DELTA_KNOWN);
  const { sequence, baseSequence } = container.header;
  if (sequence < 2 || baseSequence !== sequence - 1) {
    corrupt(`delta ${sequence} on base ${baseSequence}: the base must be sequence - 1`);
  }
  return readFrame(container);
}

export function shapeIdOf(view: FrameView, trip: number): ShapeId {
  return shapeIdAt(view.shapes, view.trips.shape[trip] as number);
}

export function categoryOf(view: FrameView, trip: number): Category {
  return CATEGORIES[view.trips.category[trip] as number] ?? "unknown";
}

/**
 * Writes the absolute arrival and departure (Unix seconds) of each plan stop of a trip into the
 * given arrays (unknown times hold the other time of the stop) and returns the stop count.
 */
export function tripTimes(
  view: FrameView,
  trip: number,
  arrival: Float64Array,
  departure: Float64Array,
): number {
  const first = view.trips.stopOffset[trip] as number;
  const count = view.trips.stopCount[trip] as number;
  let time = view.header.timeBase + (view.trips.start[trip] as number);
  for (let j = 0; j < count; j++) {
    time += view.stops.run[first + j] as number;
    arrival[j] = time;
    time += view.stops.dwell[first + j] as number;
    departure[j] = time;
  }
  return count;
}

/**
 * Writes the arc position in metres of each plan stop of a trip into `out` and returns the stop
 * count: the trip's explicit positions (flag bit 3), else stops `firstStop` to
 * `firstStop + stopCount - 1` of `shapeStops`, the stop list of the trip's shape pack. Throws
 * FrameDecodeError `corrupt` when the trip names stops its shape does not have (FORMAT.md 3.1).
 */
export function tripStopArcs(
  view: FrameView,
  trip: number,
  shapeStops: ArrayLike<number>,
  out: Float64Array,
): number {
  const count = view.trips.stopCount[trip] as number;
  if (out.length < count) throw new RangeError(`out holds ${out.length} of ${count} stops`);
  const arcRow = view.trips.arcOffset[trip] as number;
  if (arcRow >= 0) {
    for (let j = 0; j < count; j++) out[j] = (view.stops.arc[arcRow + j] as number) / 100;
    return count;
  }
  const first = view.trips.firstStop[trip] as number;
  if (first + count > shapeStops.length) {
    corrupt(
      `trip ${view.trips.key[trip]} needs stops ${first} to ${first + count - 1} of ${shapeStops.length}`,
    );
  }
  for (let j = 0; j < count; j++) out[j] = shapeStops[first + j] as number;
  return count;
}

function stringAt(view: FrameView, row: number): string | null {
  return row === NO_STRING ? null : (view.strings[row] as string);
}

/** The trip's vehicle of a 1.3 frame; an empty object for a frame without vehicle columns. */
function vehicleOf(
  view: FrameView,
  trip: number,
): Pick<TripRecord, "series" | "operator" | "units"> {
  const vehicle = view.vehicle;
  if (!vehicle) return {};
  const units = vehicle.units[trip] as number;
  return {
    series: stringAt(view, vehicle.series[trip] as number),
    operator: stringAt(view, vehicle.operator[trip] as number),
    units: units === 0 ? null : units,
  };
}

export function readTrip(view: FrameView, trip: number): TripRecord {
  const { trips, stops } = view;
  const count = trips.stopCount[trip] as number;
  const arrival = new Float64Array(count);
  const departure = new Float64Array(count);
  tripTimes(view, trip, arrival, departure);
  const first = trips.stopOffset[trip] as number;
  const arcRow = trips.arcOffset[trip] as number;
  const flags = trips.flags[trip] as number;
  const delay = trips.delay[trip] as number;
  const line = trips.line[trip] as number;
  const trainNumber = trips.trainNumber[trip] as number;
  return {
    key: trips.key[trip] as number,
    shapeId: shapeIdOf(view, trip),
    category: categoryOf(view, trip),
    realtime: (flags & TRIP_FLAG.realtime) !== 0,
    cancelled: (flags & TRIP_FLAG.cancelled) !== 0,
    foreign: (flags & TRIP_FLAG.foreign) !== 0,
    delay: delay === DELAY_UNKNOWN ? null : delay,
    line: line === NO_STRING ? null : (view.strings[line] as string),
    trainNumber: trainNumber === 0 ? null : trainNumber,
    firstStop: trips.firstStop[trip] as number,
    stops: Array.from({ length: count }, (_, j) => {
      const stopFlags = stops.flags[first + j] as number;
      return {
        arrival: stopFlags & STOP_FLAG.arrivalUnknown ? null : (arrival[j] as number),
        departure: stopFlags & STOP_FLAG.departureUnknown ? null : (departure[j] as number),
        cancelled: (stopFlags & STOP_FLAG.cancelled) !== 0,
        realtime: (stopFlags & STOP_FLAG.realtime) !== 0,
        s: arcRow < 0 ? null : (stops.arc[arcRow + j] as number) / 100,
      };
    }),
    ...vehicleOf(view, trip),
  };
}

/** The frame as plain objects, trips in ascending key order. */
export function frameToObject(view: FrameView): Keyframe | Delta {
  const trips = Array.from({ length: view.trips.count }, (_, i) => readTrip(view, i)).sort(
    (a, b) => a.key - b.key,
  );
  const { sequence, baseSequence, timetableVersion, timeBase, shapeEpoch } = view.header;
  if (view.header.kind === "delta") {
    return {
      kind: "delta",
      sequence,
      baseSequence,
      timetableVersion,
      shapeEpoch,
      timeBase,
      trips,
      removed: Array.from(view.removed),
    };
  }
  return { kind: "keyframe", sequence, timetableVersion, shapeEpoch, timeBase, trips };
}
