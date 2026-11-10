import type { DB } from "@gerlines/db";
import {
  type FleetRuleDbRow,
  fleetRuleOf,
  type ObservationDbRow,
  observedFormationOf,
  operatorNameOf,
  type SeriesFacts,
} from "@gerlines/schema/vehicle-resolver";
import { type Kysely, sql } from "kysely";
import { timed } from "../metrics.ts";
import type { FleetCatalogue, FleetSource, FleetWindow, InstanceFields } from "./identities.ts";

/** Each statement of a read stops after this long, so a read never holds a connection for good. */
export const VEHICLE_STATEMENT_TIMEOUT_MS = 10_000;

/**
 * The catalogue tables of the vehicle identity: fleet_rule (0086), vehicle_series,
 * formation_observation (0085), the named operators and the trip instances whose operator or
 * train number differ from their timetable trip. One read is one transaction on one connection,
 * or runs inside the caller's.
 */
export class DatabaseFleetSource implements FleetSource {
  private readonly db: Kysely<DB>;
  private readonly statementTimeoutMs: number;

  constructor(db: Kysely<DB>, statementTimeoutMs = VEHICLE_STATEMENT_TIMEOUT_MS) {
    this.db = db;
    this.statementTimeoutMs = statementTimeoutMs;
  }

  load(window: FleetWindow): Promise<FleetCatalogue> {
    return this.db.isTransaction
      ? this.read(this.db, window)
      : this.db.transaction().execute((trx) => this.read(trx, window));
  }

  private async read(trx: Kysely<DB>, window: FleetWindow): Promise<FleetCatalogue> {
    await sql`SELECT set_config('statement_timeout', ${String(this.statementTimeoutMs)}, true)`.execute(
      trx,
    );
    const rules = await timed("fleet_rules", () =>
      sql<FleetRuleDbRow>`
        SELECT rule_id, scope, operator_id, category_code, line_keys, series_ids, model_id,
               model_name, units, fleet_count, fleet_total, valid_from::text AS valid_from,
               valid_to::text AS valid_to, source_id
          FROM fleet_rule ORDER BY rule_id`.execute(trx),
    );
    const series = await timed("vehicle_series", () =>
      sql<{ series_id: string; name: string; br: string | null; unit_length_m: number | null }>`
        SELECT series_id, name, br, unit_length_m::float8 AS unit_length_m
          FROM vehicle_series`.execute(trx),
    );
    const observations = await timed("formation_observations", () =>
      sql<ObservationDbRow>`
        SELECT service_date::text AS service_date, train_number, operator_id, series_id, units, cars,
               length_m::float8 AS length_m, source_id, observed_at
          FROM formation_observation
         WHERE service_date BETWEEN ${window.from}::date AND ${window.to}::date`.execute(trx),
    );
    const operators = await timed("vehicle_operators", () =>
      sql<{ operator_id: string; name: string | null; brand_name: string | null }>`
        SELECT operator_id, name, brand_name FROM operator`.execute(trx),
    );
    const instances = await timed("vehicle_instances", () =>
      sql<{ trip_instance_id: string; operator_id: string | null; train_number: string | null }>`
        SELECT i.trip_instance_id::text AS trip_instance_id, i.operator_id, i.train_number
          FROM trip_instance i
          JOIN trip t ON t.feed_version_id = i.feed_version_id AND t.trip_key = i.trip_key
          JOIN route r ON r.feed_version_id = t.feed_version_id AND r.route_key = t.route_key
         WHERE i.service_date = ANY(${[...window.days]}::date[])
           AND ((i.operator_id IS NOT NULL AND i.operator_id IS DISTINCT FROM r.operator_id)
             OR (i.train_number IS NOT NULL AND i.train_number IS DISTINCT FROM t.short_name))`.execute(
        trx,
      ),
    );
    return {
      rules: rules.rows.map(fleetRuleOf),
      series: new Map<string, SeriesFacts>(
        series.rows.map((row) => [
          row.series_id,
          {
            seriesId: row.series_id,
            name: row.name,
            br: row.br,
            unitLengthMetres: row.unit_length_m,
          },
        ]),
      ),
      observations: observations.rows.map(observedFormationOf),
      namedOperators: new Set(
        operators.rows
          .filter((row) => operatorNameOf({ brandName: row.brand_name, name: row.name }) !== null)
          .map((row) => row.operator_id),
      ),
      instances: new Map<string, InstanceFields>(
        instances.rows.map((row) => [
          row.trip_instance_id,
          { operatorId: row.operator_id, trainNumber: row.train_number },
        ]),
      ),
    };
  }
}
