import type { DB } from "@gerlines/db";
import type { AttributionHolder } from "@gerlines/schema";
import { addDays, serviceInstant } from "@gerlines/schema/service-day";
import { type Kysely, sql } from "kysely";
import type {
  DetailRef,
  InstanceRow,
  OperatorRow,
  PlaceRow,
  SourceActivityRow,
  SourceRow,
  StaticStopRow,
  StaticTripRow,
  StopEventRow,
} from "./model.ts";

/**
 * How stop rows are read: `current` takes the folded state in `stop_event` (the live service at the
 * wall clock); `history` rebuilds the state as of the instant from `stop_event_forecast` and the
 * `PlatformChanged` events (replays and fixtures).
 */
export type ReadMode = "current" | "history";

/** The rows of one instance, before the tick's values and the version are added. */
export interface LoadedInstance {
  readonly ref: DetailRef;
  readonly trip: StaticTripRow | null;
  readonly staticStops: readonly StaticStopRow[];
  readonly instance: InstanceRow | null;
  readonly events: readonly StopEventRow[];
  readonly activity: readonly SourceActivityRow[];
}

export interface LoadedDetails {
  readonly instances: readonly LoadedInstance[];
  readonly places: ReadonlyMap<string, PlaceRow>;
  readonly operators: ReadonlyMap<string, OperatorRow>;
  readonly sources: ReadonlyMap<string, SourceRow>;
  readonly feedObservedAt: ReadonlyMap<string, number>;
}

/** Days of `stop_event_forecast` a history read looks back; older predictions are no state. */
const HISTORY_DAYS = 3;

type Timestamp = Date | string | null;

function ms(value: Timestamp): number | null {
  if (value === null) return null;
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function msOrZero(value: Timestamp): number {
  return ms(value) ?? 0;
}

function dateText(value: string): string {
  return value.slice(0, 10);
}

function tripKey(feedVersionId: number, key: string): string {
  return `${feedVersionId}\u001f${key}`;
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const list = groups.get(id) ?? [];
    list.push(row);
    groups.set(id, list);
  }
  return groups;
}

interface TripQueryRow {
  feed_version_id: number;
  trip_key: string;
  category_code: string;
  is_foreign: boolean;
  line: string | null;
  short_name: string | null;
  headsign: string | null;
  operator_id: string | null;
  product: string | null;
  qa_status: string | null;
}

interface StopQueryRow {
  feed_version_id: number;
  trip_key: string;
  stop_index: number;
  stop_place_id: string;
  arrival_s: number | null;
  departure_s: number | null;
  platform_code: string | null;
  pickup_type: number;
  drop_off_type: number;
}

interface EventQueryRow {
  trip_instance_id: string;
  source_id: string;
  stop_index: number;
  stop_place_id: string;
  scheduled_arrival: Timestamp;
  scheduled_departure: Timestamp;
  predicted_arrival: Timestamp;
  predicted_departure: Timestamp;
  arrival_delay_s: number | null;
  departure_delay_s: number | null;
  prediction_kind: string | null;
  platform_scheduled: string | null;
  platform_actual: string | null;
  cancelled: boolean;
  observed_at: Timestamp;
}

/** Batched, read-only queries for the details of many instances at once. */
export class DetailRepository {
  private sourceCache: { at: number; rows: Map<string, SourceRow> } | null = null;
  private readonly db: Kysely<DB>;
  private readonly sourceCacheMs: number;

  constructor(db: Kysely<DB>, sourceCacheMs = 60_000) {
    this.db = db;
    this.sourceCacheMs = sourceCacheMs;
  }

  /** With `activity: false` (every ref carries the tick's source), the source activity is not read. */
  async load(
    refs: readonly DetailRef[],
    asOf: number,
    mode: ReadMode,
    options: { readonly activity?: boolean } = {},
  ): Promise<LoadedDetails> {
    const ids = refs.map((ref) => ref.tripInstanceId);
    const dates = [
      ...new Set(refs.flatMap((ref) => [ref.serviceDate, addDays(ref.serviceDate, -1)])),
    ];
    const staticRefs = refs.filter(
      (ref): ref is DetailRef & { feedVersionId: number; tripKey: string } =>
        ref.feedVersionId !== null && ref.tripKey !== null,
    );
    const [trips, stops, instances, events, activity, sources, feeds] = await Promise.all([
      this.trips(staticRefs),
      this.staticStops(staticRefs),
      this.instances(ids),
      mode === "current" ? this.currentEvents(ids, dates) : this.historyEvents(ids, dates, asOf),
      options.activity === false ? Promise.resolve([]) : this.activity(ids, asOf),
      this.sources(asOf),
      this.feeds(asOf),
    ]);
    const tripsByKey = new Map(
      trips.map((row) => [tripKey(row.feed_version_id, row.trip_key), row]),
    );
    const stopsByTrip = groupBy(stops, (row) => tripKey(row.feed_version_id, row.trip_key));
    const instanceById = new Map(instances.map((row) => [row.tripInstanceId, row]));
    const eventsById = groupBy(events, (row) => row.trip_instance_id);
    const activityById = groupBy(activity, (row) => row.trip_instance_id);

    const loaded = refs.map((ref): LoadedInstance => {
      const key =
        ref.feedVersionId !== null && ref.tripKey !== null
          ? tripKey(ref.feedVersionId, ref.tripKey)
          : null;
      const trip = key ? tripsByKey.get(key) : undefined;
      return {
        ref,
        trip: trip ? toTrip(trip) : null,
        staticStops: key
          ? (stopsByTrip.get(key) ?? []).map((row) => toStaticStop(row, ref.serviceDate))
          : [],
        instance: instanceById.get(ref.tripInstanceId) ?? null,
        events: (eventsById.get(ref.tripInstanceId) ?? []).map(toEvent),
        activity: (activityById.get(ref.tripInstanceId) ?? []).map((row) => ({
          sourceId: row.source_id,
          firstSeen: msOrZero(row.first_seen),
          lastSeen: msOrZero(row.last_seen),
        })),
      };
    });
    const placeIds = new Set<string>();
    const operatorIds = new Set<string>();
    for (const instance of loaded) {
      for (const stop of instance.staticStops) placeIds.add(stop.stopPlaceId);
      for (const event of instance.events) placeIds.add(event.stopPlaceId);
      const operator = instance.instance?.operatorId ?? instance.trip?.operatorId;
      if (operator) operatorIds.add(operator);
    }
    const [places, operators] = await Promise.all([
      this.places([...placeIds]),
      this.operators([...operatorIds]),
    ]);
    return { instances: loaded, places, operators, sources, feedObservedAt: feeds };
  }

  private async trips(
    refs: readonly { feedVersionId: number; tripKey: string }[],
  ): Promise<TripQueryRow[]> {
    if (refs.length === 0) return [];
    const result = await sql<TripQueryRow>`
      SELECT t.feed_version_id, t.trip_key, t.category_code, t.is_foreign, r.short_name AS line,
             t.short_name, t.headsign, r.operator_id, tp.product, sp.qa_status
        FROM unnest(${refs.map((ref) => ref.feedVersionId)}::int[], ${refs.map((ref) => ref.tripKey)}::text[])
             AS wanted (feed_version_id, trip_key)
        JOIN trip t USING (feed_version_id, trip_key)
        JOIN route r USING (feed_version_id, route_key)
        LEFT JOIN trip_product tp USING (feed_version_id, trip_key)
        LEFT JOIN trip_pattern_shape ps
          ON ps.feed_version_id = t.feed_version_id AND ps.trip_pattern_id = t.trip_pattern_id
        LEFT JOIN shape_pattern sp ON sp.shape_hash = ps.shape_hash`.execute(this.db);
    return result.rows;
  }

  private async staticStops(
    refs: readonly { feedVersionId: number; tripKey: string }[],
  ): Promise<StopQueryRow[]> {
    if (refs.length === 0) return [];
    const result = await sql<StopQueryRow>`
      SELECT st.feed_version_id, st.trip_key, st.stop_index, pt.stop_place_id, st.arrival_s,
             st.departure_s, pt.platform_code, st.pickup_type, st.drop_off_type
        FROM unnest(${refs.map((ref) => ref.feedVersionId)}::int[], ${refs.map((ref) => ref.tripKey)}::text[])
             AS wanted (feed_version_id, trip_key)
        JOIN trip t USING (feed_version_id, trip_key)
        JOIN stop_time st USING (feed_version_id, trip_key)
        JOIN trip_pattern_stop tps
          ON tps.feed_version_id = t.feed_version_id AND tps.trip_pattern_id = t.trip_pattern_id
         AND tps.stop_index = st.stop_index
        JOIN stop_point pt ON pt.stop_point_id = tps.stop_point_id
       ORDER BY st.feed_version_id, st.trip_key, st.stop_index`.execute(this.db);
    return result.rows;
  }

  private async instances(ids: readonly string[]): Promise<InstanceRow[]> {
    if (ids.length === 0) return [];
    const result = await sql<{
      trip_instance_id: string;
      service_date: string;
      is_added: boolean;
      train_number: string | null;
      category_code: string | null;
      operator_id: string | null;
    }>`
      SELECT trip_instance_id, service_date::text AS service_date, is_added, train_number,
             category_code, operator_id
        FROM trip_instance WHERE trip_instance_id = ANY(${ids}::uuid[])`.execute(this.db);
    return result.rows.map((row) => ({
      tripInstanceId: row.trip_instance_id,
      serviceDate: dateText(row.service_date),
      isAdded: row.is_added,
      trainNumber: row.train_number,
      categoryCode: row.category_code,
      operatorId: row.operator_id,
    }));
  }

  private async currentEvents(
    ids: readonly string[],
    dates: readonly string[],
  ): Promise<EventQueryRow[]> {
    if (ids.length === 0) return [];
    const result = await sql<EventQueryRow>`
      SELECT trip_instance_id, source_id, stop_index, stop_place_id, scheduled_arrival,
             scheduled_departure, predicted_arrival, predicted_departure, arrival_delay_s,
             departure_delay_s, prediction_kind, platform_scheduled, platform_actual, cancelled,
             observed_at
        FROM stop_event
       WHERE service_date = ANY(${dates}::date[]) AND trip_instance_id = ANY(${ids}::uuid[])`.execute(
      this.db,
    );
    return result.rows;
  }

  private async historyEvents(
    ids: readonly string[],
    dates: readonly string[],
    asOf: number,
  ): Promise<EventQueryRow[]> {
    if (ids.length === 0) return [];
    const at = new Date(asOf);
    const from = new Date(asOf - HISTORY_DAYS * 86_400_000);
    const result = await sql<EventQueryRow>`
      WITH latest AS (
        SELECT DISTINCT ON (trip_instance_id, stop_index, source_id)
               trip_instance_id, stop_index, source_id, predicted_arrival, predicted_departure,
               arrival_delay_s, departure_delay_s, cancelled, explicit, observed_at
          FROM stop_event_forecast
         WHERE trip_instance_id = ANY(${ids}::uuid[]) AND observed_at <= ${at} AND observed_at > ${from}
         ORDER BY trip_instance_id, stop_index, source_id, observed_at DESC
      )
      SELECT f.trip_instance_id, f.source_id, f.stop_index, se.stop_place_id, se.scheduled_arrival,
             se.scheduled_departure, f.predicted_arrival, f.predicted_departure, f.arrival_delay_s,
             f.departure_delay_s,
             CASE WHEN f.predicted_arrival IS NULL AND f.predicted_departure IS NULL THEN NULL
                  WHEN f.explicit THEN 'explicit' ELSE 'propagated' END AS prediction_kind,
             se.platform_scheduled,
             CASE WHEN se.observed_at <= ${at} THEN se.platform_actual ELSE
             (SELECT e.payload ->> 'actual' FROM event e
               WHERE e.trip_instance_id = f.trip_instance_id AND e.stop_index = f.stop_index
                 AND e.source_id = f.source_id AND e.event_type = 'PlatformChanged'
                 AND e.occurred_at <= ${at} AND e.occurred_at > ${from}
               ORDER BY e.occurred_at DESC LIMIT 1) END AS platform_actual,
             f.cancelled, f.observed_at
        FROM latest f
        JOIN stop_event se
          ON se.service_date = ANY(${dates}::date[]) AND se.trip_instance_id = f.trip_instance_id
         AND se.stop_index = f.stop_index AND se.source_id = f.source_id`.execute(this.db);
    return result.rows;
  }

  private async activity(
    ids: readonly string[],
    asOf: number,
  ): Promise<
    { trip_instance_id: string; source_id: string; first_seen: Timestamp; last_seen: Timestamp }[]
  > {
    if (ids.length === 0) return [];
    const result = await sql<{
      trip_instance_id: string;
      source_id: string;
      first_seen: Timestamp;
      last_seen: Timestamp;
    }>`
      SELECT trip_instance_id, source_id, min(observed_at) AS first_seen, max(observed_at) AS last_seen
        FROM stop_event_forecast
       WHERE trip_instance_id = ANY(${ids}::uuid[]) AND observed_at <= ${new Date(asOf)}
         AND observed_at > ${new Date(asOf - HISTORY_DAYS * 86_400_000)}
       GROUP BY trip_instance_id, source_id`.execute(this.db);
    return result.rows;
  }

  private async places(ids: readonly string[]): Promise<Map<string, PlaceRow>> {
    if (ids.length === 0) return new Map();
    const result = await sql<{
      stop_place_id: string;
      name: string;
      display_name: string | null;
      dhid: string | null;
      lon: number | null;
      lat: number | null;
    }>`
      SELECT p.stop_place_id, p.name, d.name AS display_name, p.dhid, ST_X(p.geom) AS lon,
             ST_Y(p.geom) AS lat
        FROM stop_place p LEFT JOIN stop_place_display_name d USING (stop_place_id)
       WHERE p.stop_place_id = ANY(${ids}::uuid[])`.execute(this.db);
    return new Map(
      result.rows.map((row) => [
        row.stop_place_id,
        {
          name: row.name,
          displayName: row.display_name,
          dhid: row.dhid,
          location: row.lon === null || row.lat === null ? null : { lon: row.lon, lat: row.lat },
        },
      ]),
    );
  }

  private async operators(ids: readonly string[]): Promise<Map<string, OperatorRow>> {
    if (ids.length === 0) return new Map();
    const result = await sql<{
      operator_id: string;
      name: string;
      brand_name: string | null;
      wikidata_qid: string | null;
    }>`
      SELECT operator_id, name, brand_name, wikidata_qid FROM operator
       WHERE operator_id = ANY(${ids}::text[])`.execute(this.db);
    return new Map(
      result.rows.map((row) => [
        row.operator_id,
        {
          operatorId: row.operator_id,
          name: row.name,
          brandName: row.brand_name,
          wikidataQid: row.wikidata_qid,
        },
      ]),
    );
  }

  private async sources(now: number): Promise<Map<string, SourceRow>> {
    if (
      this.sourceCache &&
      now - this.sourceCache.at < this.sourceCacheMs &&
      now >= this.sourceCache.at
    ) {
      return this.sourceCache.rows;
    }
    const [sources, holders] = await Promise.all([
      sql<{
        source_id: string;
        name: string;
        attribution: string;
        licence: string;
        licence_url: string | null;
      }>`SELECT source_id, name, attribution, licence, licence_url FROM source`.execute(this.db),
      sql<{ source_id: string; name: string; role: AttributionHolder["role"]; url: string | null }>`
        SELECT source_id, name, role, url FROM source_holder ORDER BY source_id, position`.execute(
        this.db,
      ),
    ]);
    const bySource = groupBy(holders.rows, (row) => row.source_id);
    const rows = new Map(
      sources.rows.map((row) => [
        row.source_id,
        {
          sourceId: row.source_id,
          name: row.name,
          attribution: row.attribution,
          licence: row.licence,
          licenceUrl: row.licence_url,
          holders: (bySource.get(row.source_id) ?? []).map(({ name, role, url }) => ({
            name,
            role,
            url,
          })),
        },
      ]),
    );
    this.sourceCache = { at: now, rows };
    return rows;
  }

  async feeds(asOf: number): Promise<Map<string, number>> {
    const result = await sql<{ source_id: string; observed_at: Timestamp }>`
      SELECT s.source_id,
             (SELECT max(p.observed_at) FROM rt_payload p
               WHERE p.source_id = s.source_id AND p.observed_at <= ${new Date(asOf)}) AS observed_at
        FROM source s`.execute(this.db);
    const map = new Map<string, number>();
    for (const row of result.rows) {
      const value = ms(row.observed_at);
      if (value !== null) map.set(row.source_id, value);
    }
    return map;
  }
}

function toTrip(row: TripQueryRow): StaticTripRow {
  return {
    feedVersionId: row.feed_version_id,
    tripKey: row.trip_key,
    categoryCode: row.category_code,
    isForeign: row.is_foreign,
    line: row.line,
    tripShortName: row.short_name,
    headsign: row.headsign,
    operatorId: row.operator_id,
    product: row.product,
    shapeQaStatus: row.qa_status,
  };
}

const NO_SERVICE = 1;

function toStaticStop(row: StopQueryRow, serviceDate: string): StaticStopRow {
  return {
    index: row.stop_index,
    stopPlaceId: row.stop_place_id,
    scheduledArrival: row.arrival_s === null ? null : serviceInstant(serviceDate, row.arrival_s),
    scheduledDeparture:
      row.departure_s === null ? null : serviceInstant(serviceDate, row.departure_s),
    platform: row.platform_code,
    passenger: row.pickup_type !== NO_SERVICE || row.drop_off_type !== NO_SERVICE,
  };
}

function toEvent(row: EventQueryRow): StopEventRow {
  return {
    sourceId: row.source_id,
    index: row.stop_index,
    stopPlaceId: row.stop_place_id,
    scheduledArrival: ms(row.scheduled_arrival),
    scheduledDeparture: ms(row.scheduled_departure),
    predictedArrival: ms(row.predicted_arrival),
    predictedDeparture: ms(row.predicted_departure),
    arrivalDelaySeconds: row.arrival_delay_s,
    departureDelaySeconds: row.departure_delay_s,
    predictionKind:
      row.prediction_kind === "explicit" || row.prediction_kind === "propagated"
        ? row.prediction_kind
        : null,
    platformScheduled: row.platform_scheduled,
    platformActual: row.platform_actual,
    cancelled: row.cancelled,
    observedAt: msOrZero(row.observed_at),
  };
}
