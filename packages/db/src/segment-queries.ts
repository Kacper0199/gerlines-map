import { type Kysely, type RawBuilder, sql } from "kysely";
import type { DB } from "./generated/database.ts";

/** The runs of one train number whose legs a segment profile reads from `stat_segment`. */
export interface SegmentFilter {
  readonly trainNumber: string;
  readonly from: string;
  readonly to: string;
  readonly categories?: readonly string[] | undefined;
  readonly operatorId?: string | undefined;
  /** Most legs returned: the route first, then the other legs of the number by runs. */
  readonly limit: number;
}

/** Sums over the legs of one from and to stop place pair, with the stored histogram cells. */
export interface SegmentLegTotals {
  readonly n_runs: number;
  readonly n_legs: number;
  readonly sum_gain_s: number;
  readonly gain_hist: readonly number[] | null;
  readonly n_speed: number;
  readonly sum_distance_m: number | null;
  readonly sum_run_act_s: number | null;
  readonly speed_hist: readonly number[] | null;
}

export interface SegmentRow {
  readonly from_stop_place_id: string;
  readonly to_stop_place_id: string;
  readonly from_name: string | null;
  readonly to_name: string | null;
  /** Stop index of the leg in the run whose stop sequence is the most frequent; null off that route. */
  readonly route_index: number | null;
  readonly train: SegmentLegTotals;
  /** Every train on the pair from `segment_day`, all categories; null when the rollup has no row. */
  readonly all: SegmentLegTotals | null;
}

/** A category and operator of the number with its runs among the runs the filter chose. */
export interface SegmentGroup {
  readonly category_code: string | null;
  readonly operator_id: string | null;
  readonly operator_name: string | null;
  readonly runs: number;
}

export interface TrainSegments {
  /** The number's category and operator groups by runs; the first is the one profiled. */
  readonly groups: SegmentGroup[];
  /** Distinct runs of the profiled group in the period, and those with the route's stop sequence. */
  readonly runs: number;
  readonly patternRuns: number;
  /** Distinct leg pairs of the number before the limit. */
  readonly pairs: number;
  readonly rows: SegmentRow[];
}

const SPEED_LEG = sql`l.distance_m IS NOT NULL AND l.run_act_s > 0 AND l.run_sched_s > 0`;

/** Stored cells of the 21 gain bins and the 31 speed bins, with their underflow and overflow cells. */
const GAIN_CELLS = 23;
const SPEED_CELLS = 33;

/** A histogram column summed cell by cell, null when no row had one (cheaper than `stat_hist_sum`). */
function cellSum(column: string, cells: number): RawBuilder<unknown> {
  const sums = Array.from(
    { length: cells },
    (_, index) => sql`sum(${sql.ref(column)}[${sql.lit(index + 1)}])::bigint`,
  );
  return sql`CASE WHEN count(${sql.ref(column)}) > 0 THEN ARRAY[${sql.join(sums)}] END`;
}

function legConditions(filter: SegmentFilter): RawBuilder<unknown> {
  const parts: RawBuilder<unknown>[] = [
    sql`s.train_number = ${filter.trainNumber}`,
    sql`s.day BETWEEN ${filter.from}::date AND ${filter.to}::date`,
  ];
  if (filter.categories && filter.categories.length > 0) {
    parts.push(sql`s.category_code = ANY(${[...filter.categories]}::text[])`);
  }
  if (filter.operatorId !== undefined) parts.push(sql`s.operator_id = ${filter.operatorId}`);
  return sql.join(parts, sql` AND `);
}

const asNumber = (value: unknown): number => (value === null ? 0 : Number(value));
const asNullableNumber = (value: unknown): number | null => (value === null ? null : Number(value));
const asCells = (value: unknown): number[] | null =>
  value === null ? null : (value as readonly (string | number)[]).map(Number);

function totalsOf(raw: Record<string, unknown>, prefix: string): SegmentLegTotals {
  return {
    n_runs: asNumber(raw[`${prefix}n_runs`]),
    n_legs: asNumber(raw[`${prefix}n_legs`]),
    sum_gain_s: asNumber(raw[`${prefix}sum_gain_s`]),
    gain_hist: asCells(raw[`${prefix}gain_hist`]),
    n_speed: asNumber(raw[`${prefix}n_speed`]),
    sum_distance_m: asNullableNumber(raw[`${prefix}sum_distance_m`]),
    sum_run_act_s: asNullableNumber(raw[`${prefix}sum_run_act_s`]),
    speed_hist: asCells(raw[`${prefix}speed_hist`]),
  };
}

/**
 * One statement over the level-1 and level-2 leg rollups: the number's legs in the period from
 * `stat_segment`, kept for its category and operator group with the most runs (ties by category,
 * then operator), that group's most frequent stop sequence (runs with the same ordered legs; ties by the
 * sequence's hash), the legs of one run of that sequence in stop order, then the number's other legs
 * by runs, each summed for the number and joined to `segment_day` for every train on the pair.
 * Every value is a bound parameter. The number's origins are read first and passed as an array, so
 * TimescaleDB skips the compressed `segment_day` batches without them (a join key alone is not
 * pushed into compressed chunks).
 */
export async function readTrainSegments(
  db: Kysely<DB>,
  filter: SegmentFilter,
): Promise<TrainSegments> {
  const origins = await sql<{ from_id: string }>`
    SELECT DISTINCT s.from_stop_place_id AS from_id FROM stat_segment s WHERE ${legConditions(filter)}`.execute(
    db,
  );
  const fromIds = origins.rows.map((row) => row.from_id);
  const result = await sql<Record<string, unknown>>`
    WITH found AS MATERIALIZED (
      SELECT s.trip_instance_id, s.category_code, s.operator_id, s.from_index,
             s.from_stop_place_id AS from_id, s.to_stop_place_id AS to_id, s.delay_gain_s, s.distance_m,
             s.run_act_s, s.run_sched_s
        FROM stat_segment s
       WHERE ${legConditions(filter)}
    ),
    groups AS (
      SELECT category_code, operator_id, count(DISTINCT trip_instance_id) AS n_runs
        FROM found GROUP BY category_code, operator_id
    ),
    shown AS (
      SELECT category_code, operator_id FROM groups
       ORDER BY n_runs DESC, category_code NULLS LAST, operator_id NULLS LAST LIMIT 1
    ),
    legs AS MATERIALIZED (
      SELECT f.* FROM found f
        JOIN shown g ON f.category_code IS NOT DISTINCT FROM g.category_code
                    AND f.operator_id IS NOT DISTINCT FROM g.operator_id
    ),
    runs AS (
      SELECT trip_instance_id,
             md5(string_agg(from_id::text || to_id::text, ',' ORDER BY from_index)) AS pattern
        FROM legs GROUP BY trip_instance_id
    ),
    chosen AS (
      SELECT pattern, count(*) AS pattern_runs, min(trip_instance_id::text)::uuid AS sample
        FROM runs GROUP BY pattern ORDER BY count(*) DESC, pattern LIMIT 1
    ),
    route AS (
      SELECT l.from_id, l.to_id, min(l.from_index) AS route_index
        FROM legs l JOIN chosen c ON l.trip_instance_id = c.sample
       GROUP BY l.from_id, l.to_id
    ),
    pairs AS (
      SELECT l.from_id, l.to_id,
             count(DISTINCT l.trip_instance_id) AS n_runs,
             count(*) AS n_legs,
             sum(l.delay_gain_s)::bigint AS sum_gain_s,
             histogram(stat_gain_bin(l.delay_gain_s)::double precision, 0, 21, 21)::bigint[] AS gain_hist,
             count(*) FILTER (WHERE ${SPEED_LEG}) AS n_speed,
             sum(l.distance_m) FILTER (WHERE ${SPEED_LEG}) AS sum_distance_m,
             (sum(l.run_act_s) FILTER (WHERE ${SPEED_LEG}))::bigint AS sum_run_act_s,
             (histogram(stat_speed_bin(l.distance_m / l.run_act_s * 3.6)::double precision, 0, 31, 31)
               FILTER (WHERE ${SPEED_LEG}))::bigint[] AS speed_hist,
             avg(l.from_index) AS mean_index
        FROM legs l GROUP BY l.from_id, l.to_id
    ),
    kept AS (
      SELECT p.*, r.route_index
        FROM pairs p LEFT JOIN route r USING (from_id, to_id)
       ORDER BY r.route_index NULLS LAST, p.n_runs DESC, p.mean_index, p.from_id, p.to_id
       LIMIT ${filter.limit}
    ),
    everyone AS (
      SELECT d.from_stop_place_id AS from_id, d.to_stop_place_id AS to_id,
             sum(d.n_runs)::bigint AS n_runs, sum(d.n_legs)::bigint AS n_legs,
             sum(d.sum_gain_s)::bigint AS sum_gain_s,
             ${cellSum("d.gain_hist", GAIN_CELLS)} AS gain_hist,
             sum(d.n_speed)::bigint AS n_speed, sum(d.sum_distance_m) AS sum_distance_m,
             sum(d.sum_speed_run_act_s)::bigint AS sum_run_act_s,
             ${cellSum("d.speed_hist", SPEED_CELLS)} AS speed_hist
        FROM segment_day d
        JOIN kept k ON d.from_stop_place_id = k.from_id AND d.to_stop_place_id = k.to_id
       WHERE d.day BETWEEN ${filter.from}::date AND ${filter.to}::date
         AND d.from_stop_place_id = ANY(${fromIds}::uuid[])
       GROUP BY d.from_stop_place_id, d.to_stop_place_id
    )
    SELECT k.from_id, k.to_id, k.route_index, k.n_runs, k.n_legs, k.sum_gain_s, k.gain_hist,
           k.n_speed, k.sum_distance_m, k.sum_run_act_s, k.speed_hist,
           e.from_id IS NOT NULL AS all_present,
           e.n_runs AS all_n_runs, e.n_legs AS all_n_legs, e.sum_gain_s AS all_sum_gain_s,
           e.gain_hist AS all_gain_hist, e.n_speed AS all_n_speed,
           e.sum_distance_m AS all_sum_distance_m, e.sum_run_act_s AS all_sum_run_act_s,
           e.speed_hist AS all_speed_hist,
           coalesce(fd.name, fs.name) AS from_name, coalesce(td.name, ts.name) AS to_name,
           (SELECT count(*) FROM runs) AS total_runs,
           (SELECT pattern_runs FROM chosen) AS pattern_runs,
           (SELECT count(*) FROM pairs) AS total_pairs,
           (SELECT json_agg(json_build_object('category_code', g.category_code, 'operator_id', g.operator_id,
                                              'operator_name', o.name, 'runs', g.n_runs)
                            ORDER BY g.n_runs DESC, g.category_code NULLS LAST, g.operator_id NULLS LAST)
              FROM groups g LEFT JOIN operator o ON o.operator_id = g.operator_id) AS groups
      FROM kept k
      LEFT JOIN everyone e USING (from_id, to_id)
      LEFT JOIN stop_place fs ON fs.stop_place_id = k.from_id
      LEFT JOIN stop_place_display_name fd ON fd.stop_place_id = k.from_id
      LEFT JOIN stop_place ts ON ts.stop_place_id = k.to_id
      LEFT JOIN stop_place_display_name td ON td.stop_place_id = k.to_id
     ORDER BY k.route_index NULLS LAST, k.n_runs DESC, k.mean_index, k.from_id, k.to_id`.execute(
    db,
  );
  const first = result.rows[0];
  return {
    groups: ((first?.groups as SegmentGroup[] | null | undefined) ?? []).map((group) => ({
      category_code: group.category_code,
      operator_id: group.operator_id,
      operator_name: group.operator_name,
      runs: Number(group.runs),
    })),
    runs: first ? asNumber(first.total_runs) : 0,
    patternRuns: first ? asNumber(first.pattern_runs) : 0,
    pairs: first ? asNumber(first.total_pairs) : 0,
    rows: result.rows.map((raw) => ({
      from_stop_place_id: String(raw.from_id),
      to_stop_place_id: String(raw.to_id),
      from_name: (raw.from_name as string | null) ?? null,
      to_name: (raw.to_name as string | null) ?? null,
      route_index: asNullableNumber(raw.route_index),
      train: totalsOf(raw, ""),
      all: raw.all_present === true ? totalsOf(raw, "all_") : null,
    })),
  };
}
