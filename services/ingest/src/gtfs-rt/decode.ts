import { WIRE_FIXED32, WIRE_LENGTH_DELIMITED, WIRE_VARINT, WireError, WireReader } from "./wire.ts";

/**
 * Bounds on what one feed may make the decoder allocate, about twice the largest real payloads
 * measured on 2026-10-27 (gtfs.de: 120,846 entities, an alert naming 92,914 trips, 2.46 million
 * nested messages in 29 MB; at most 80 stop time updates per trip and 2 translations anywhere).
 */
export interface DecodeLimits {
  readonly entities: number;
  readonly stopTimeUpdates: number;
  readonly translations: number;
  readonly informedEntities: number;
  readonly messages: number;
  readonly stringBytes: number;
}

export const DECODE_LIMITS: DecodeLimits = {
  entities: 250_000,
  stopTimeUpdates: 1_000,
  translations: 64,
  informedEntities: 250_000,
  messages: 6_000_000,
  stringBytes: 1_048_576,
};

function pushCapped<T>(list: T[], value: T, limit: number, what: string): void {
  if (list.length >= limit) throw new WireError(`${what}: more than ${limit}`);
  list.push(value);
}

export interface RtTripDescriptor {
  tripId?: string;
  routeId?: string;
  directionId?: number;
  startTime?: string;
  startDate?: string;
  scheduleRelationship?: number;
}

export interface RtVehicleDescriptor {
  id?: string;
  label?: string;
  licensePlate?: string;
}

export interface RtStopTimeEvent {
  delay?: number;
  time?: number;
  uncertainty?: number;
  scheduledTime?: number;
}

export interface RtStopTimeUpdate {
  stopSequence?: number;
  stopId?: string;
  arrival?: RtStopTimeEvent;
  departure?: RtStopTimeEvent;
  scheduleRelationship?: number;
  assignedStopId?: string;
}

export interface RtTripProperties {
  tripId?: string;
  startDate?: string;
  startTime?: string;
  shapeId?: string;
  tripHeadsign?: string;
  tripShortName?: string;
}

export interface RtTripUpdate {
  trip: RtTripDescriptor;
  vehicle?: RtVehicleDescriptor;
  stopTimeUpdates: RtStopTimeUpdate[];
  timestamp?: number;
  delay?: number;
  tripProperties?: RtTripProperties;
}

export interface RtPosition {
  latitude: number;
  longitude: number;
  bearing?: number;
  speed?: number;
}

export interface RtVehiclePosition {
  trip?: RtTripDescriptor;
  vehicle?: RtVehicleDescriptor;
  position?: RtPosition;
  currentStopSequence?: number;
  stopId?: string;
  currentStatus?: number;
  timestamp?: number;
}

export interface RtTranslation {
  text: string;
  language?: string;
}

export interface RtEntitySelector {
  agencyId?: string;
  routeId?: string;
  routeType?: number;
  trip?: RtTripDescriptor;
  stopId?: string;
}

export interface RtTimeRange {
  start?: number;
  end?: number;
}

export interface RtAlert {
  activePeriods: RtTimeRange[];
  informedEntities: RtEntitySelector[];
  cause?: number;
  effect?: number;
  url: RtTranslation[];
  headerText: RtTranslation[];
  descriptionText: RtTranslation[];
  severityLevel?: number;
}

export interface RtEntity {
  id: string;
  isDeleted: boolean;
  tripUpdate?: RtTripUpdate;
  vehicle?: RtVehiclePosition;
  alert?: RtAlert;
}

export interface RtFeedHeader {
  gtfsRealtimeVersion?: string;
  incrementality: "FULL_DATASET" | "DIFFERENTIAL";
  timestamp?: number;
  feedVersion?: string;
}

export interface RtFeed {
  header: RtFeedHeader;
  entities: RtEntity[];
}

interface FieldReader<T> {
  readonly wire: number;
  read(reader: WireReader, target: T): void;
}

type Fields<T> = Readonly<Record<number, FieldReader<T>>>;

/** Reads one message into `target`: known fields of the expected wire type, everything else skipped. */
function readMessage<T>(reader: WireReader, target: T, fields: Fields<T>): T {
  while (!reader.done) {
    const { field, wireType } = reader.tag();
    const handler = fields[field];
    if (handler && handler.wire === wireType) handler.read(reader, target);
    else reader.skip(wireType);
  }
  return target;
}

const text = <T>(assign: (target: T, value: string) => void): FieldReader<T> => ({
  wire: WIRE_LENGTH_DELIMITED,
  read: (reader, target) => assign(target, reader.text()),
});

const uint = <T>(assign: (target: T, value: number) => void): FieldReader<T> => ({
  wire: WIRE_VARINT,
  read: (reader, target) => assign(target, reader.uint()),
});

const int32 = <T>(assign: (target: T, value: number) => void): FieldReader<T> => ({
  wire: WIRE_VARINT,
  read: (reader, target) => assign(target, reader.int32()),
});

const int64 = <T>(assign: (target: T, value: number) => void): FieldReader<T> => ({
  wire: WIRE_VARINT,
  read: (reader, target) => assign(target, reader.int64()),
});

const float = <T>(assign: (target: T, value: number) => void): FieldReader<T> => ({
  wire: WIRE_FIXED32,
  read: (reader, target) => assign(target, reader.float()),
});

const message = <T, M>(
  create: () => M,
  fields: Fields<M>,
  assign: (target: T, value: M) => void,
): FieldReader<T> => ({
  wire: WIRE_LENGTH_DELIMITED,
  read: (reader, target) => assign(target, readMessage(reader.message(), create(), fields)),
});

const TRIP_DESCRIPTOR: Fields<RtTripDescriptor> = {
  1: text((t, v) => {
    t.tripId = v;
  }),
  2: text((t, v) => {
    t.startTime = v;
  }),
  3: text((t, v) => {
    t.startDate = v;
  }),
  4: int32((t, v) => {
    t.scheduleRelationship = v;
  }),
  5: text((t, v) => {
    t.routeId = v;
  }),
  6: uint((t, v) => {
    t.directionId = v;
  }),
};

const VEHICLE_DESCRIPTOR: Fields<RtVehicleDescriptor> = {
  1: text((t, v) => {
    t.id = v;
  }),
  2: text((t, v) => {
    t.label = v;
  }),
  3: text((t, v) => {
    t.licensePlate = v;
  }),
};

const STOP_TIME_EVENT: Fields<RtStopTimeEvent> = {
  1: int32((t, v) => {
    t.delay = v;
  }),
  2: int64((t, v) => {
    t.time = v;
  }),
  3: int32((t, v) => {
    t.uncertainty = v;
  }),
  4: int64((t, v) => {
    t.scheduledTime = v;
  }),
};

const STOP_TIME_PROPERTIES: Fields<RtStopTimeUpdate> = {
  1: text((t, v) => {
    t.assignedStopId = v;
  }),
};

const STOP_TIME_UPDATE: Fields<RtStopTimeUpdate> = {
  1: uint((t, v) => {
    t.stopSequence = v;
  }),
  2: message(
    () => ({}),
    STOP_TIME_EVENT,
    (t: RtStopTimeUpdate, v) => {
      t.arrival = v;
    },
  ),
  3: message(
    () => ({}),
    STOP_TIME_EVENT,
    (t: RtStopTimeUpdate, v) => {
      t.departure = v;
    },
  ),
  4: text((t, v) => {
    t.stopId = v;
  }),
  5: int32((t, v) => {
    t.scheduleRelationship = v;
  }),
  6: {
    wire: WIRE_LENGTH_DELIMITED,
    read: (reader, target) => {
      readMessage(reader.message(), target, STOP_TIME_PROPERTIES);
    },
  },
};

const TRIP_PROPERTIES: Fields<RtTripProperties> = {
  1: text((t, v) => {
    t.tripId = v;
  }),
  2: text((t, v) => {
    t.startDate = v;
  }),
  3: text((t, v) => {
    t.startTime = v;
  }),
  4: text((t, v) => {
    t.shapeId = v;
  }),
  5: text((t, v) => {
    t.tripHeadsign = v;
  }),
  6: text((t, v) => {
    t.tripShortName = v;
  }),
};

const TRIP_UPDATE: Fields<RtTripUpdate> = {
  1: message(
    () => ({}),
    TRIP_DESCRIPTOR,
    (t: RtTripUpdate, v) => {
      t.trip = v;
    },
  ),
  2: message(
    () => ({}),
    STOP_TIME_UPDATE,
    (t: RtTripUpdate, v) => {
      pushCapped(
        t.stopTimeUpdates,
        v,
        DECODE_LIMITS.stopTimeUpdates,
        "trip update has too many stop time updates",
      );
    },
  ),
  3: message(
    () => ({}),
    VEHICLE_DESCRIPTOR,
    (t: RtTripUpdate, v) => {
      t.vehicle = v;
    },
  ),
  4: uint((t, v) => {
    t.timestamp = v;
  }),
  5: int32((t, v) => {
    t.delay = v;
  }),
  6: message(
    () => ({}),
    TRIP_PROPERTIES,
    (t: RtTripUpdate, v) => {
      t.tripProperties = v;
    },
  ),
};

const POSITION: Fields<RtPosition> = {
  1: float((t, v) => {
    t.latitude = v;
  }),
  2: float((t, v) => {
    t.longitude = v;
  }),
  3: float((t, v) => {
    t.bearing = v;
  }),
  5: float((t, v) => {
    t.speed = v;
  }),
};

const VEHICLE_POSITION: Fields<RtVehiclePosition> = {
  1: message(
    () => ({}),
    TRIP_DESCRIPTOR,
    (t: RtVehiclePosition, v) => {
      t.trip = v;
    },
  ),
  2: message(
    () => ({ latitude: Number.NaN, longitude: Number.NaN }),
    POSITION,
    (t: RtVehiclePosition, v) => {
      t.position = v;
    },
  ),
  3: uint((t, v) => {
    t.currentStopSequence = v;
  }),
  4: int32((t, v) => {
    t.currentStatus = v;
  }),
  5: uint((t, v) => {
    t.timestamp = v;
  }),
  7: text((t, v) => {
    t.stopId = v;
  }),
  8: message(
    () => ({}),
    VEHICLE_DESCRIPTOR,
    (t: RtVehiclePosition, v) => {
      t.vehicle = v;
    },
  ),
};

const TRANSLATION: Fields<RtTranslation> = {
  1: text((t, v) => {
    t.text = v;
  }),
  2: text((t, v) => {
    t.language = v;
  }),
};

const TRANSLATED_STRING: Fields<RtTranslation[]> = {
  1: message(
    () => ({ text: "" }),
    TRANSLATION,
    (t: RtTranslation[], v) => {
      pushCapped(t, v, DECODE_LIMITS.translations, "text has too many translations");
    },
  ),
};

const translated = (assign: (target: RtAlert, value: RtTranslation[]) => void) =>
  message(() => [] as RtTranslation[], TRANSLATED_STRING, assign);

const TIME_RANGE: Fields<RtTimeRange> = {
  1: uint((t, v) => {
    t.start = v;
  }),
  2: uint((t, v) => {
    t.end = v;
  }),
};

const ENTITY_SELECTOR: Fields<RtEntitySelector> = {
  1: text((t, v) => {
    t.agencyId = v;
  }),
  2: text((t, v) => {
    t.routeId = v;
  }),
  3: int32((t, v) => {
    t.routeType = v;
  }),
  4: message(
    () => ({}),
    TRIP_DESCRIPTOR,
    (t: RtEntitySelector, v) => {
      t.trip = v;
    },
  ),
  5: text((t, v) => {
    t.stopId = v;
  }),
};

const ALERT: Fields<RtAlert> = {
  1: message(
    () => ({}),
    TIME_RANGE,
    (t: RtAlert, v) => {
      pushCapped(
        t.activePeriods,
        v,
        DECODE_LIMITS.informedEntities,
        "alert has too many active periods",
      );
    },
  ),
  5: message(
    () => ({}),
    ENTITY_SELECTOR,
    (t: RtAlert, v) => {
      pushCapped(
        t.informedEntities,
        v,
        DECODE_LIMITS.informedEntities,
        "alert has too many informed entities",
      );
    },
  ),
  6: int32((t, v) => {
    t.cause = v;
  }),
  7: int32((t, v) => {
    t.effect = v;
  }),
  8: translated((t, v) => {
    t.url = v;
  }),
  10: translated((t, v) => {
    t.headerText = v;
  }),
  11: translated((t, v) => {
    t.descriptionText = v;
  }),
  14: int32((t, v) => {
    t.severityLevel = v;
  }),
};

const ENTITY: Fields<RtEntity> = {
  1: text((t, v) => {
    t.id = v;
  }),
  2: uint((t, v) => {
    t.isDeleted = v !== 0;
  }),
  3: message(
    () => ({ trip: {}, stopTimeUpdates: [] }),
    TRIP_UPDATE,
    (t: RtEntity, v) => {
      t.tripUpdate = v;
    },
  ),
  4: message(
    () => ({}),
    VEHICLE_POSITION,
    (t: RtEntity, v) => {
      t.vehicle = v;
    },
  ),
  5: message(
    () => ({
      activePeriods: [],
      informedEntities: [],
      url: [],
      headerText: [],
      descriptionText: [],
    }),
    ALERT,
    (t: RtEntity, v) => {
      t.alert = v;
    },
  ),
};

const HEADER: Fields<RtFeedHeader> = {
  1: text((t, v) => {
    t.gtfsRealtimeVersion = v;
  }),
  2: uint((t, v) => {
    t.incrementality = v === 1 ? "DIFFERENTIAL" : "FULL_DATASET";
  }),
  3: uint((t, v) => {
    t.timestamp = v;
  }),
  4: text((t, v) => {
    t.feedVersion = v;
  }),
};

interface PartialFeed {
  header?: RtFeedHeader;
  entities: RtEntity[];
  readonly maxEntities: number;
}

const FEED: Fields<PartialFeed> = {
  1: message(
    () => ({ incrementality: "FULL_DATASET" as const }),
    HEADER,
    (t: PartialFeed, v) => {
      t.header = v;
    },
  ),
  2: message(
    () => ({ id: "", isDeleted: false }),
    ENTITY,
    (t: PartialFeed, v) => {
      if (t.entities.length >= t.maxEntities) {
        throw new WireError(`feed has more than ${t.maxEntities} entities`);
      }
      t.entities.push(v);
    },
  ),
};

export type DecodeResult = { ok: true; feed: RtFeed } | { ok: false; error: string };

/**
 * Decodes a GTFS-Realtime FeedMessage: trip updates, vehicle positions and alerts. A feed over
 * `limits` (entities, nested messages, string length) or over the per-list bounds of
 * `DECODE_LIMITS` is refused as an error, not decoded.
 */
export function decodeFeed(
  bytes: Uint8Array,
  limits: Pick<DecodeLimits, "entities" | "messages" | "stringBytes"> = DECODE_LIMITS,
): DecodeResult {
  let feed: PartialFeed;
  try {
    const budget = {
      messages: limits.messages,
      maxMessages: limits.messages,
      maxStringBytes: limits.stringBytes,
    };
    feed = readMessage(
      new WireReader(bytes, 0, bytes.length, budget),
      { entities: [], maxEntities: limits.entities },
      FEED,
    );
  } catch (error) {
    if (error instanceof WireError) return { ok: false, error: error.message };
    throw error;
  }
  if (!feed.header) return { ok: false, error: "feed has no header" };
  return { ok: true, feed: { header: feed.header, entities: feed.entities } };
}
