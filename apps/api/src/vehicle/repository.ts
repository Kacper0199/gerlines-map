import type { DB } from "@gerlines/db";
import { type FormationObservation, MAJORITY_WINDOW_DAYS } from "@gerlines/schema";
import { addDays } from "@gerlines/schema/service-day";
import {
  type ExactFormation,
  exactOf,
  type FleetRuleDbRow,
  type FleetRuleRow,
  type FormationQuery,
  fleetRuleOf,
  type Majority,
  majorityOf,
  type ObservationDbRow,
  type ObservedFormation,
  observedFormationOf,
  type SeriesFacts,
} from "@gerlines/schema/vehicle-resolver";
import { type Kysely, sql } from "kysely";

export interface CatalogueSeries extends SeriesFacts {
  readonly br: string | null;
}

/** A catalogue source with the display name the train card shows for it. */
export interface CatalogueSource {
  readonly sourceId: string;
  readonly name: string;
}

/** What the identity service reads and writes; the database store below, fakes in tests. */
export interface IdentityStore {
  rules(): Promise<readonly FleetRuleRow[]>;
  series(): Promise<readonly CatalogueSeries[]>;
  sources(): Promise<readonly CatalogueSource[]>;
  /** Observations of another operator are left out when the operator is known. */
  exact(
    serviceDate: string,
    trainNumber: string,
    operatorId: string | null,
  ): Promise<ExactFormation | null>;
  majority(
    serviceDate: string,
    trainNumber: string,
    operatorId: string | null,
  ): Promise<Majority | null>;
  evaOf(stopPlaceId: string): Promise<number | null>;
  save(observation: FormationObservation): Promise<void>;
}

export class DatabaseIdentityStore implements IdentityStore {
  private readonly db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.db = db;
  }

  async rules(): Promise<readonly FleetRuleRow[]> {
    const { rows } = await sql<FleetRuleDbRow>`
      SELECT rule_id, scope, operator_id, category_code, line_keys, series_ids, model_id, model_name,
             units, fleet_count, fleet_total, valid_from::text AS valid_from,
             valid_to::text AS valid_to, source_id
        FROM fleet_rule ORDER BY rule_id`.execute(this.db);
    return rows.map(fleetRuleOf);
  }

  async series(): Promise<readonly CatalogueSeries[]> {
    const { rows } = await sql<{
      series_id: string;
      name: string;
      br: string | null;
      unit_length_m: number | null;
    }>`SELECT series_id, name, br, unit_length_m::float8 AS unit_length_m FROM vehicle_series`.execute(
      this.db,
    );
    return rows.map((row) => ({
      seriesId: row.series_id,
      name: row.name,
      br: row.br,
      unitLengthMetres: row.unit_length_m,
    }));
  }

  async sources(): Promise<readonly CatalogueSource[]> {
    const { rows } = await sql<{ source_id: string; name: string }>`
      SELECT source_id, name FROM source ORDER BY source_id`.execute(this.db);
    return rows.map((row) => ({ sourceId: row.source_id, name: row.name }));
  }

  async exact(
    serviceDate: string,
    trainNumber: string,
    operatorId: string | null,
  ): Promise<ExactFormation | null> {
    const query = { serviceDate, trainNumber, operatorId };
    return exactOf(await this.observations(query, serviceDate, serviceDate), query);
  }

  async majority(
    serviceDate: string,
    trainNumber: string,
    operatorId: string | null,
  ): Promise<Majority | null> {
    const query = { serviceDate, trainNumber, operatorId };
    const from = addDays(serviceDate, -MAJORITY_WINDOW_DAYS);
    return majorityOf(await this.observations(query, from, addDays(serviceDate, -1)), query);
  }

  /** Observations of the train between two service days, both included. */
  private async observations(
    query: FormationQuery,
    from: string,
    to: string,
  ): Promise<ObservedFormation[]> {
    const { rows } = await sql<ObservationDbRow>`
      SELECT service_date::text AS service_date, train_number, operator_id, series_id, units, cars,
             length_m::float8 AS length_m, source_id, observed_at
        FROM formation_observation
       WHERE train_number = ${query.trainNumber}
         AND (${query.operatorId}::text IS NULL OR operator_id = ${query.operatorId}::text)
         AND service_date BETWEEN ${from}::date AND ${to}::date`.execute(this.db);
    return rows.map(observedFormationOf);
  }

  async evaOf(stopPlaceId: string): Promise<number | null> {
    const { rows } = await sql<{ eva: number | null }>`
      SELECT eva FROM stop_place WHERE stop_place_id = ${stopPlaceId}::uuid`.execute(this.db);
    return rows[0]?.eva ?? null;
  }

  async save(o: FormationObservation): Promise<void> {
    await sql`
      INSERT INTO formation_observation (source_id, service_date, train_number, operator_id,
        category_code, line, series_id, units, cars, length_m, unit_names, sequence_status, raw_sha256)
      VALUES (${o.sourceId}, ${o.serviceDate}::date, ${o.trainNumber}, ${o.operatorId},
        ${o.categoryCode}, ${o.line}, ${o.seriesId}, ${o.units}, ${o.cars}, ${o.lengthMetres},
        ${o.unitNames}::text[], ${o.sequenceStatus}, ${o.rawSha256})
      ON CONFLICT (source_id, service_date, train_number) DO UPDATE SET
        series_id = excluded.series_id, units = excluded.units, cars = excluded.cars,
        length_m = excluded.length_m, unit_names = excluded.unit_names,
        sequence_status = excluded.sequence_status, raw_sha256 = excluded.raw_sha256,
        observed_at = now()`.execute(this.db);
  }
}
