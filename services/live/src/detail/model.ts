import type { LonLat } from "@gerlines/geo";
import type { AttributionHolder, TrainGeometry } from "@gerlines/schema";

/** One trip instance the detail is built for: a timetable run, an instance realtime knows, or both. */
export interface DetailRef {
  readonly tripInstanceId: string;
  readonly serviceDate: string;
  /** The timetable trip, null for a trip a source added. */
  readonly feedVersionId: number | null;
  readonly tripKey: string | null;
  readonly frameKey: number | null;
}

/** The timetable trip of an instance with its route, product and shape state. */
export interface StaticTripRow {
  readonly feedVersionId: number;
  readonly tripKey: string;
  readonly categoryCode: string;
  readonly isForeign: boolean;
  readonly line: string | null;
  readonly tripShortName: string | null;
  readonly headsign: string | null;
  readonly operatorId: string | null;
  readonly product: string | null;
  /** `shape_pattern.qa_status` of the pattern's linked shape; null when no shape is linked. */
  readonly shapeQaStatus: string | null;
}

/** One scheduled stop of the timetable trip, times in epoch milliseconds. */
export interface StaticStopRow {
  readonly index: number;
  readonly stopPlaceId: string;
  readonly scheduledArrival: number | null;
  readonly scheduledDeparture: number | null;
  readonly platform: string | null;
  /**
   * The train picks up or sets down passengers here. False for a pass-through and for an
   * operational halt (no pickup, no drop-off, a dwell such as a reversal): the engine may stand
   * there, the card does not list it.
   */
  readonly passenger: boolean;
}

/** `trip_instance` facts: what realtime knows about the run. */
export interface InstanceRow {
  readonly tripInstanceId: string;
  readonly serviceDate: string;
  readonly isAdded: boolean;
  readonly trainNumber: string | null;
  readonly categoryCode: string | null;
  readonly operatorId: string | null;
}

/** One stop of one source as of the detail's instant, times in epoch milliseconds. */
export interface StopEventRow {
  readonly sourceId: string;
  readonly index: number;
  readonly stopPlaceId: string;
  readonly scheduledArrival: number | null;
  readonly scheduledDeparture: number | null;
  readonly predictedArrival: number | null;
  readonly predictedDeparture: number | null;
  readonly arrivalDelaySeconds: number | null;
  readonly departureDelaySeconds: number | null;
  readonly predictionKind: "explicit" | "propagated" | null;
  readonly platformScheduled: string | null;
  readonly platformActual: string | null;
  readonly cancelled: boolean;
  readonly observedAt: number;
}

/** When a source first and last changed its prediction for the instance, epoch milliseconds. */
export interface SourceActivityRow {
  readonly sourceId: string;
  readonly firstSeen: number;
  readonly lastSeen: number;
}

export interface PlaceRow {
  readonly name: string;
  /** The name with its town where the timetable name lacks it, else null. */
  readonly displayName: string | null;
  /** The place's position, null where the stop place has none. */
  readonly location: LonLat | null;
  /** The place's DHID, which tells a district's stop numbers from tracks. */
  readonly dhid?: string | null;
}

export interface OperatorRow {
  readonly operatorId: string;
  readonly name: string;
  readonly brandName: string | null;
  readonly wikidataQid: string | null;
}

export interface SourceRow {
  readonly sourceId: string;
  readonly name: string;
  readonly attribution: string;
  readonly licence: string;
  readonly licenceUrl: string | null;
  readonly holders: readonly AttributionHolder[];
}

/** Values the live tick decided; when present they win over the builder's own reading. */
export interface TickDecision {
  readonly sourceId: string | null;
  readonly geometry: TrainGeometry;
  readonly delaySeconds: number | null;
  readonly cancelled: boolean;
  readonly lastPassedIndex: number | null;
  readonly nextIndex: number | null;
}

/** Everything one detail is built from; the builder reads nothing else. */
export interface DetailInput {
  readonly ref: DetailRef;
  /** The instant the detail describes, epoch milliseconds. */
  readonly asOf: number;
  readonly timetableVersion: string;
  readonly version: number;
  readonly trip: StaticTripRow | null;
  readonly staticStops: readonly StaticStopRow[];
  readonly instance: InstanceRow | null;
  readonly events: readonly StopEventRow[];
  readonly activity: readonly SourceActivityRow[];
  readonly places: ReadonlyMap<string, PlaceRow>;
  readonly operators: ReadonlyMap<string, OperatorRow>;
  readonly sources: ReadonlyMap<string, SourceRow>;
  /** Newest payload per source at or before `asOf`, epoch milliseconds. */
  readonly feedObservedAt: ReadonlyMap<string, number>;
  readonly tick: TickDecision | null;
}

export const TIMETABLE_SOURCE_ID = "delfi-gtfs";
