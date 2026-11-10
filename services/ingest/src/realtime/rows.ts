export interface TripInstanceRow {
  readonly tripInstanceId: string;
  readonly serviceDate: string;
  readonly feedVersionId: number | null;
  readonly tripKey: string | null;
  readonly operatorId: string | null;
  readonly trainNumber: string | null;
  readonly categoryCode: string | null;
  readonly originStopPlaceId: string;
  readonly originDeparture: number;
  readonly isAdded: boolean;
  readonly sourceId: string;
  readonly observedAt: number;
  readonly rawObjectId: string;
}

export interface StopEventRow {
  readonly serviceDate: string;
  readonly tripInstanceId: string;
  readonly stopIndex: number;
  readonly sourceId: string;
  readonly stopPlaceId: string;
  readonly scheduledArrival: number | null;
  readonly scheduledDeparture: number | null;
  readonly predictedArrival: number | null;
  readonly predictedDeparture: number | null;
  readonly arrivalDelay: number | null;
  readonly departureDelay: number | null;
  readonly predictionKind: "explicit" | "propagated" | null;
  readonly finalArrival: number | null;
  readonly finalDeparture: number | null;
  readonly finalQuality: "live" | "carried" | null;
  readonly platformScheduled: string | null;
  readonly platformActual: string | null;
  readonly cancelled: boolean;
  readonly additional: boolean;
  readonly observedAt: number;
  readonly rawObjectId: string;
}

export interface ForecastRow {
  readonly tripInstanceId: string;
  readonly stopIndex: number;
  readonly sourceId: string;
  readonly observedAt: number;
  readonly serviceDate: string;
  readonly predictedArrival: number | null;
  readonly predictedDeparture: number | null;
  readonly arrivalDelay: number | null;
  readonly departureDelay: number | null;
  readonly cancelled: boolean;
  readonly explicit: boolean;
  readonly rawObjectId: string;
}

export interface SegmentRow {
  readonly serviceDate: string;
  readonly tripInstanceId: string;
  readonly fromIndex: number;
  readonly sourceId: string;
  readonly toIndex: number;
  readonly fromStopPlaceId: string;
  readonly toStopPlaceId: string;
  readonly depDelayFrom: number;
  readonly arrDelayTo: number;
  readonly runSched: number;
  readonly runAct: number;
  readonly dwellDelay: number | null;
  readonly observedAt: number;
  readonly rawObjectId: string;
}

export type OutboxEventType = "TripDelayChanged" | "TripCancelled" | "PlatformChanged";

export interface EventRow {
  readonly eventId: string;
  readonly occurredAt: number;
  readonly eventType: OutboxEventType;
  readonly sourceId: string;
  readonly tripInstanceId: string;
  readonly stopIndex: number | null;
  readonly payload: Readonly<Record<string, string | number | null>>;
  readonly rawObjectId: string;
}

export interface BacklogRow {
  readonly sourceId: string;
  readonly entityKey: string;
  readonly serviceDate: string;
  readonly reason: string;
  readonly detail: Readonly<Record<string, string | number | null>>;
  readonly firstObservedAt: number;
  readonly firstRawObjectId: string;
  readonly lastSeenHour: number;
}

/** One version of an alert's message; which trips and places it names lives in `AlertScopeRow`. */
export interface AlertMessageRow {
  readonly sourceId: string;
  readonly alertKey: string;
  readonly contentHash: string;
  readonly cause: number | null;
  readonly effect: number | null;
  readonly severity: number | null;
  readonly activePeriods: unknown;
  readonly header: unknown;
  readonly description: unknown;
  readonly url: unknown;
  readonly selectorCount: number;
  readonly firstObservedAt: number;
  readonly firstRawObjectId: string;
  readonly lastSeenHour: number;
}

/** A trip instance or stop place an alert message named, from the first time to the last hour. */
export interface AlertScopeRow {
  readonly sourceId: string;
  readonly alertKey: string;
  readonly contentHash: string;
  readonly tripInstanceId: string | null;
  readonly stopPlaceId: string | null;
  readonly firstObservedAt: number;
  readonly firstRawObjectId: string;
  readonly lastSeenHour: number;
}

/** When a source named a trip instance first and last. */
export interface InstanceSeenRow {
  readonly tripInstanceId: string;
  readonly sourceId: string;
  readonly observedAt: number;
  readonly rawObjectId: string;
}

/** Everything one payload changes, written in one transaction with its processing log row. */
export interface RowBatch {
  readonly instances: TripInstanceRow[];
  readonly instanceSeen: InstanceSeenRow[];
  readonly stopEvents: StopEventRow[];
  readonly forecasts: ForecastRow[];
  readonly segments: SegmentRow[];
  readonly events: EventRow[];
  readonly backlog: BacklogRow[];
  readonly alertMessages: AlertMessageRow[];
  readonly alertScopes: AlertScopeRow[];
}

export function emptyBatch(): RowBatch {
  return {
    instances: [],
    instanceSeen: [],
    stopEvents: [],
    forecasts: [],
    segments: [],
    events: [],
    backlog: [],
    alertMessages: [],
    alertScopes: [],
  };
}

export function rowCount(batch: RowBatch): number {
  return Object.values(batch).reduce((sum, rows: unknown[]) => sum + rows.length, 0);
}
