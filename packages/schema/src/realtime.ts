/**
 * Canonical realtime events: what an adapter reads from one source payload, before matching to the
 * static timetable. Times are epoch seconds (GTFS-RT convention), `observedAt` is epoch milliseconds
 * of the payload, dates are ISO `YYYY-MM-DD`. Missing values are `null`, never invented.
 */

export type TripRelationship =
  | "scheduled"
  | "added"
  | "unscheduled"
  | "cancelled"
  | "replacement"
  | "duplicated"
  | "deleted"
  | "new";

export type StopRelationship = "scheduled" | "skipped" | "no_data" | "unscheduled";

/** How a source names a stop: its own id, or a code we can resolve without its static feed. */
export type StopRef =
  | { readonly kind: "source"; readonly id: string }
  | { readonly kind: "uic"; readonly code: number };

export interface TimeObservation {
  readonly delaySeconds: number | null;
  readonly time: number | null;
  readonly uncertaintySeconds: number | null;
}

/** A message a source attaches to a trip or stop (delay cause, quality note, disruption), times epoch seconds. */
export interface SourceMessage {
  readonly id: string;
  readonly kind: string | null;
  readonly code: number | null;
  readonly category: string | null;
  readonly priority: number | null;
  readonly timestamp: number | null;
  readonly validFrom: number | null;
  readonly validTo: number | null;
}

export interface StopTimeObservation {
  readonly stopSequence: number | null;
  readonly stop: StopRef | null;
  readonly arrival: TimeObservation | null;
  readonly departure: TimeObservation | null;
  readonly relationship: StopRelationship;
  readonly assignedStop: StopRef | null;
  /** Planned times (epoch seconds) a station-based source names next to its changes, for matching. */
  readonly scheduled?: { readonly arrival: number | null; readonly departure: number | null };
  /** Platforms as `normalizePlatform` reads them: the planned one and the changed one, null when unchanged. */
  readonly platform?: { readonly scheduled: string | null; readonly actual: string | null };
  readonly messages?: readonly SourceMessage[];
}

export interface TripObservation {
  readonly kind: "trip";
  readonly source: string;
  readonly entityId: string;
  readonly observedAt: number;
  readonly feedTimestamp: number | null;
  readonly updateTimestamp: number | null;
  readonly sourceTripId: string | null;
  readonly routeId: string | null;
  readonly directionId: number | null;
  readonly startDate: string | null;
  readonly startTime: string | null;
  readonly trainNumber: string | null;
  /** The source's own category label (IRIS `ICE`, `RE`), and whether it files the train as long distance. */
  readonly categoryLabel?: string | null;
  readonly longDistance?: boolean | null;
  readonly relationship: TripRelationship;
  readonly vehicleId: string | null;
  readonly vehicleLabel: string | null;
  readonly delaySeconds: number | null;
  readonly stops: readonly StopTimeObservation[];
  /** Stops a station-based source names with planned times only (no realtime): matched on, never folded. */
  readonly plannedStops?: readonly StopTimeObservation[];
  readonly messages?: readonly SourceMessage[];
}

export interface VehicleObservation {
  readonly kind: "vehicle";
  readonly source: string;
  readonly entityId: string;
  readonly observedAt: number;
  readonly sourceTripId: string | null;
  readonly startDate: string | null;
  readonly trainNumber: string | null;
  readonly vehicleId: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly bearing: number | null;
  readonly speedMetresPerSecond: number | null;
  readonly positionTimestamp: number | null;
}

export interface LocalizedText {
  readonly text: string;
  readonly language: string | null;
}

export interface AlertSelector {
  readonly agencyId: string | null;
  readonly routeId: string | null;
  readonly routeType: number | null;
  readonly sourceTripId: string | null;
  readonly startDate: string | null;
  readonly stop: StopRef | null;
}

export interface AlertObservation {
  readonly kind: "alert";
  readonly source: string;
  readonly entityId: string;
  readonly observedAt: number;
  readonly cause: number | null;
  readonly effect: number | null;
  readonly severity: number | null;
  readonly activePeriods: readonly { readonly start: number | null; readonly end: number | null }[];
  readonly selectors: readonly AlertSelector[];
  readonly header: readonly LocalizedText[];
  readonly description: readonly LocalizedText[];
  readonly url: readonly LocalizedText[];
}

export type RealtimeEvent = TripObservation | VehicleObservation | AlertObservation;

/** A source payload the adapter could not read at all; it is reported, never dropped silently. */
export interface AdapterFailure {
  readonly source: string;
  readonly observedAt: number;
  readonly error: string;
}

export type AdapterResult =
  | {
      readonly ok: true;
      readonly feedVersion: string | null;
      /** The feed header's timestamp (epoch seconds): when the producer made this snapshot. */
      readonly feedTimestamp: number | null;
      readonly events: RealtimeEvent[];
    }
  | { readonly ok: false; readonly failure: AdapterFailure };
