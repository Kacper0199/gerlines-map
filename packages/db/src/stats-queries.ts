import { type Kysely, type RawBuilder, sql } from "kysely";
import type { DB } from "./generated/database.ts";

/** The level-2 and level-3 rollups the statistics read; never the raw realtime tables. */
export type RollupSource =
  | "station_day"
  | "station_hour"
  | "train_day"
  | "line_day"
  | "land_category_day"
  | "land_category_hour";

export type RollupGroupColumn =
  | "day"
  | "category_code"
  | "operator_id"
  | "train_number"
  | "line_name"
  | "land_code"
  | "local_hour";

export interface RollupTotals {
  readonly n_stops: number;
  readonly n_cancelled: number;
  readonly n_additional: number;
  readonly n_no_data: number;
  readonly n_carried: number;
  readonly n_observed: number;
  readonly n_lt_6min: number;
  readonly n_lt_16min: number;
  readonly n_observed_arr: number;
  readonly n_lt_6min_arr: number;
  readonly n_lt_16min_arr: number;
  readonly n_observed_carried: number;
  readonly n_observed_propagated: number;
  readonly sum_delay_s: number;
  readonly max_delay_s: number | null;
  readonly n_platform_changed: number;
  /**
   * The stored histogram with its underflow and overflow cells, or null when nothing was observed
   * or the read left it out.
   */
  readonly delay_hist: readonly number[] | null;
  readonly n_runs: number | null;
  readonly n_dep_observed: number | null;
  readonly n_dep_lt_6min: number | null;
}

export type RollupKey = Partial<Record<RollupGroupColumn, string | number | null>>;
export type RollupRow = RollupTotals & { readonly key: RollupKey };

/** Equality filters on the rollup's dimensions; `land_code: "germany"` keeps the 16 Länder only. */
export interface RollupFilter {
  readonly from: string;
  readonly to: string;
  readonly categories?: readonly string[] | undefined;
  readonly stopPlaceId?: string | undefined;
  readonly operatorId?: string | undefined;
  readonly trainNumber?: string | undefined;
  readonly lineName?: string | undefined;
  readonly landCode?: string | "germany" | "foreign" | "unassigned" | undefined;
  /** Keep only the rows of the `limit` groups under `by` with the most stops (ties by key). */
  readonly top?: RollupTop | undefined;
}

export interface RollupTop {
  readonly by: readonly RollupGroupColumn[];
  readonly limit: number;
}

const HAS_RUNS: ReadonlySet<RollupSource> = new Set(["train_day", "line_day"]);
const HAS_DEPARTURES: ReadonlySet<RollupSource> = new Set(["station_day"]);
const HAS_HISTOGRAM: ReadonlySet<RollupSource> = new Set([
  "station_day",
  "station_hour",
  "train_day",
  "line_day",
  "land_category_day",
]);

function countColumn(name: string): RawBuilder<unknown> {
  return sql`coalesce(sum(${sql.ref(name)}), 0)::bigint AS ${sql.ref(name)}`;
}

const COUNTED = [
  "n_stops",
  "n_cancelled",
  "n_additional",
  "n_no_data",
  "n_carried",
  "n_observed",
  "n_lt_6min",
  "n_lt_16min",
  "n_observed_arr",
  "n_lt_6min_arr",
  "n_lt_16min_arr",
  "n_observed_carried",
  "n_observed_propagated",
  "sum_delay_s",
  "n_platform_changed",
] as const;

const DELAY_HIST_CELLS = 32;

function histogramSum(): RawBuilder<unknown> {
  const cells = Array.from(
    { length: DELAY_HIST_CELLS },
    (_, index) => sql`sum(delay_hist[${sql.lit(index + 1)}])::bigint`,
  );
  return sql`CASE WHEN count(delay_hist) > 0 THEN ARRAY[${sql.join(cells)}] END AS delay_hist`;
}

function measures(source: RollupSource, histogram: boolean): RawBuilder<unknown> {
  const parts = [
    ...COUNTED.map(countColumn),
    sql`max(max_delay_s) AS max_delay_s`,
    histogram && HAS_HISTOGRAM.has(source) ? histogramSum() : sql`NULL::bigint[] AS delay_hist`,
    HAS_RUNS.has(source)
      ? sql`coalesce(sum(n_runs), 0)::bigint AS n_runs`
      : sql`NULL::bigint AS n_runs`,
    HAS_DEPARTURES.has(source)
      ? sql`coalesce(sum(n_dep_observed), 0)::bigint AS n_dep_observed, coalesce(sum(n_dep_lt_6min), 0)::bigint AS n_dep_lt_6min`
      : sql`NULL::bigint AS n_dep_observed, NULL::bigint AS n_dep_lt_6min`,
  ];
  return sql.join(parts);
}

function busiestOrder(columns: readonly RollupGroupColumn[]): RawBuilder<unknown> {
  return sql.join([
    sql`sum(n_stops) DESC`,
    ...columns.map((column) => sql`${sql.ref(column)} NULLS LAST`),
  ]);
}

function topCondition(source: RollupSource, filter: RollupFilter, top: RollupTop) {
  const columns = sql.join(top.by.map((column) => sql.ref(column)));
  const matches = sql.join(
    top.by.map((column) => sql`t.${sql.ref(column)} IS NOT DISTINCT FROM r.${sql.ref(column)}`),
    sql` AND `,
  );
  return sql`EXISTS (SELECT 1 FROM (SELECT ${columns} FROM ${sql.table(source)} WHERE ${conditions(
    source,
    { ...filter, top: undefined },
  )} GROUP BY ${columns} ORDER BY ${busiestOrder(top.by)} LIMIT ${top.limit}) t WHERE ${matches})`;
}

function conditions(source: RollupSource, filter: RollupFilter): RawBuilder<unknown> {
  const parts: RawBuilder<unknown>[] = [
    sql`day BETWEEN ${filter.from}::date AND ${filter.to}::date`,
  ];
  if (filter.categories && filter.categories.length > 0) {
    parts.push(sql`category_code = ANY(${[...filter.categories]}::text[])`);
  }
  if (filter.stopPlaceId !== undefined)
    parts.push(sql`stop_place_id = ${filter.stopPlaceId}::uuid`);
  if (filter.operatorId !== undefined) parts.push(sql`operator_id = ${filter.operatorId}`);
  if (filter.trainNumber !== undefined) parts.push(sql`train_number = ${filter.trainNumber}`);
  if (filter.lineName !== undefined) parts.push(sql`line_name = ${filter.lineName}`);
  if (filter.landCode === "germany") {
    parts.push(sql`land_code IS NOT NULL AND land_code <> 'foreign'`);
  } else if (filter.landCode === "unassigned") {
    parts.push(sql`land_code IS NULL`);
  } else if (filter.landCode !== undefined) {
    parts.push(sql`land_code = ${filter.landCode}`);
  }
  if (filter.top !== undefined) parts.push(topCondition(source, filter, filter.top));
  return sql.join(parts, sql` AND `);
}

function keyExpression(column: RollupGroupColumn): RawBuilder<unknown> {
  return column === "day"
    ? sql`to_char(day, 'YYYY-MM-DD') AS day`
    : sql`${sql.ref(column)} AS ${sql.ref(column)}`;
}

const asNumber = (value: unknown): number => (value === null ? 0 : Number(value));
const asNullableNumber = (value: unknown): number | null => (value === null ? null : Number(value));

function toRow(raw: Record<string, unknown>, groupBy: readonly RollupGroupColumn[]): RollupRow {
  const key: Record<string, string | number | null> = {};
  for (const column of groupBy) {
    const value = raw[column];
    key[column] =
      column === "local_hour" && value !== null ? Number(value) : (value as string | null);
  }
  const hist = raw.delay_hist as readonly (string | number)[] | null;
  return {
    key,
    n_stops: asNumber(raw.n_stops),
    n_cancelled: asNumber(raw.n_cancelled),
    n_additional: asNumber(raw.n_additional),
    n_no_data: asNumber(raw.n_no_data),
    n_carried: asNumber(raw.n_carried),
    n_observed: asNumber(raw.n_observed),
    n_lt_6min: asNumber(raw.n_lt_6min),
    n_lt_16min: asNumber(raw.n_lt_16min),
    n_observed_arr: asNumber(raw.n_observed_arr),
    n_lt_6min_arr: asNumber(raw.n_lt_6min_arr),
    n_lt_16min_arr: asNumber(raw.n_lt_16min_arr),
    n_observed_carried: asNumber(raw.n_observed_carried),
    n_observed_propagated: asNumber(raw.n_observed_propagated),
    sum_delay_s: asNumber(raw.sum_delay_s),
    max_delay_s: asNullableNumber(raw.max_delay_s),
    n_platform_changed: asNumber(raw.n_platform_changed),
    delay_hist: hist === null ? null : hist.map(Number),
    n_runs: asNullableNumber(raw.n_runs),
    n_dep_observed: asNullableNumber(raw.n_dep_observed),
    n_dep_lt_6min: asNullableNumber(raw.n_dep_lt_6min),
  };
}

export interface RollupReadOptions {
  /** Sum the delay histogram too; day and hour breakdowns never need it. */
  readonly histogram?: boolean;
  /**
   * With one grouping: return at most this many groups, the most stops first, ties by key (the
   * order of `top` in the filter).
   */
  readonly limit?: number;
}

/**
 * Sums one rollup over service days `from` to `to` (inclusive) and the filter, grouped by the given
 * dimensions (none: one row, all zero when nothing matches). Identifiers come from fixed unions;
 * every value is a bound parameter.
 */
export async function readRollup(
  db: Kysely<DB>,
  source: RollupSource,
  filter: RollupFilter,
  groupBy: readonly RollupGroupColumn[] = [],
  options: RollupReadOptions = {},
): Promise<RollupRow[]> {
  const [rows] = await readRollupSets(db, source, filter, [groupBy], options);
  return rows ?? [];
}

/**
 * One scan of a rollup summed for several groupings at once (GROUPING SETS): the result holds one
 * list of rows per grouping, in the order given. An empty grouping gives one row, all zero when
 * nothing matches. With several groupings the rows are filtered in a materialised CTE first: with
 * several grouping sets TimescaleDB 2.31 excludes no chunk and pushes no filter into compressed
 * rollup chunks; one grouping set keeps the plain scan.
 */
export async function readRollupSets(
  db: Kysely<DB>,
  source: RollupSource,
  filter: RollupFilter,
  groupings: readonly (readonly RollupGroupColumn[])[],
  { histogram = true, limit }: RollupReadOptions = {},
): Promise<RollupRow[][]> {
  if (limit !== undefined && (groupings.length !== 1 || (groupings[0]?.length ?? 0) === 0)) {
    throw new Error("a rollup limit needs exactly one non-empty grouping");
  }
  const columns = [...new Set(groupings.flat())];
  const keys = columns.map(keyExpression);
  const grouped = columns.length > 0;
  const select = sql.join([
    ...keys,
    ...(grouped
      ? [sql`GROUPING(${sql.join(columns.map((column) => sql.ref(column)))}) AS grouping_mask`]
      : []),
    measures(source, histogram),
  ]);
  const sets = sql.join(
    groupings.map((set) => sql`(${sql.join(set.map((column) => sql.ref(column)))})`),
  );
  const order =
    limit === undefined
      ? sql.join(columns.map((column) => sql`${sql.ref(column)} NULLS LAST`))
      : sql`${busiestOrder(columns)} LIMIT ${limit}`;
  const grouping = grouped ? sql` GROUP BY GROUPING SETS (${sets}) ORDER BY ${order}` : sql``;
  const filtered = sql`${sql.table(source)} AS r WHERE ${conditions(source, filter)}`;
  const result = await (groupings.length > 1
    ? sql<Record<string, unknown>>`
        WITH r AS MATERIALIZED (SELECT * FROM ${filtered}) SELECT ${select} FROM r${grouping}`
    : sql<Record<string, unknown>>`SELECT ${select} FROM ${filtered}${grouping}`
  ).execute(db);
  const maskOf = (set: readonly RollupGroupColumn[]) =>
    columns.reduce(
      (mask, column, index) =>
        set.includes(column) ? mask : mask | (1 << (columns.length - 1 - index)),
      0,
    );
  return groupings.map((set) => {
    const mask = maskOf(set);
    return result.rows
      .filter((raw) => !grouped || Number(raw.grouping_mask) === mask)
      .map((raw) => toRow(raw, set));
  });
}

export interface StationIdentity {
  readonly id: string;
  readonly name: string;
  readonly landCode: string | null;
}

export async function readStation(
  db: Kysely<DB>,
  stopPlaceId: string,
): Promise<StationIdentity | null> {
  const result = await sql<{ id: string; name: string; land_code: string | null }>`
    SELECT s.stop_place_id AS id, coalesce(d.name, s.name) AS name, l.land_code
      FROM stop_place s
      LEFT JOIN stop_place_display_name d ON d.stop_place_id = s.stop_place_id
      LEFT JOIN stop_place_land l ON l.stop_place_id = s.stop_place_id
     WHERE s.stop_place_id = ${stopPlaceId}::uuid`.execute(db);
  const row = result.rows[0];
  return row ? { id: row.id, name: row.name, landCode: row.land_code } : null;
}

export async function readLandNames(db: Kysely<DB>): Promise<Map<string, string>> {
  const rows = await db.selectFrom("land").select(["land_code", "name_de"]).execute();
  return new Map(rows.map((row) => [row.land_code, row.name_de]));
}

export async function readOperatorNames(
  db: Kysely<DB>,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .selectFrom("operator")
    .select(["operator_id", "name"])
    .where("operator_id", "in", [...ids])
    .execute();
  return new Map(rows.map((row) => [row.operator_id, row.name]));
}

const POLICIES = [
  "stat_stop",
  "stat_segment",
  "station_day",
  "station_hour",
  "train_day",
  "line_day",
  "segment_day",
  "land_category_day",
  "land_category_hour",
];

/**
 * The oldest last successful refresh among every rollup policy, levels 1 to 3: each rollup holds
 * data at least up to this instant. Null when a policy is missing, paused or never succeeded, or
 * the catalog cannot be read. Refreshes by hand are not in the job statistics and do not count.
 */
export async function readRollupRefreshedAt(db: Kysely<DB>): Promise<Date | null> {
  try {
    const result = await sql<{ refreshed_at: Date | null; policies: string }>`
      SELECT CASE WHEN bool_and(j.scheduled AND coalesce(isfinite(s.last_successful_finish), false))
                  THEN min(s.last_successful_finish) END AS refreshed_at,
             count(DISTINCT j.hypertable_name) AS policies
        FROM timescaledb_information.jobs j
        LEFT JOIN timescaledb_information.job_stats s USING (job_id)
       WHERE j.proc_name = 'policy_refresh_continuous_aggregate'
         AND j.hypertable_name = ANY(${POLICIES}::text[])`.execute(db);
    const row = result.rows[0];
    if (!row || Number(row.policies) !== POLICIES.length) return null;
    return row.refreshed_at instanceof Date ? row.refreshed_at : null;
  } catch {
    return null;
  }
}
