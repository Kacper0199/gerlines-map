import {
  type DB,
  type RollupFilter,
  type RollupGroupColumn,
  type RollupReadOptions,
  type RollupRow,
  type RollupSource,
  readLandNames,
  readOperatorNames,
  readRollupRefreshedAt,
  readRollupSets,
  readStation,
  readTrainSegments,
  type SegmentFilter,
  type StationIdentity,
  type TrainSegments,
} from "@gerlines/db";
import { TRAIN_CATEGORIES, type TrainCategory } from "@gerlines/schema";
import {
  STATS_LAG_NOTE,
  STATS_LAND_CODES,
  STATS_MAX_LAG_MINUTES,
  STATS_MAX_SEGMENTS,
  STATS_SEGMENT_MIN_RUNS,
  STATS_SEGMENT_NOTE,
  type StatsFreshness,
  type StatsLand,
  type StatsLandCode,
  type StatsLine,
  type StatsNetwork,
  type StatsOperator,
  type StatsRunGroup,
  type StatsStation,
  type StatsTrain,
  type StatsTrainSegments,
} from "@gerlines/schema/stats";
import type { Kysely } from "kysely";
import { GAIN_BINS, segmentOf } from "./segments.ts";
import {
  daySummary,
  delayHistogram,
  EMPTY_TOTALS,
  hourSummary,
  ratio,
  summarize,
} from "./summary.ts";

export type Groupings = readonly (readonly RollupGroupColumn[])[];

export interface StatsReader {
  /** One scan of `source` summed per grouping, one list of rows per grouping in the order given. */
  rollup(
    source: RollupSource,
    filter: RollupFilter,
    groupings: Groupings,
    options?: RollupReadOptions,
  ): Promise<RollupRow[][]>;
  /** The legs of one train number from the leg rollups, in one statement (`readTrainSegments`). */
  trainSegments(filter: SegmentFilter): Promise<TrainSegments>;
  station(id: string): Promise<StationIdentity | null>;
  landNames(): Promise<Map<string, string>>;
  operatorNames(ids: readonly string[]): Promise<Map<string, string>>;
  refreshedAt(): Promise<Date | null>;
}

export class DatabaseStatsReader implements StatsReader {
  private readonly db: Kysely<DB>;
  constructor(db: Kysely<DB>) {
    this.db = db;
  }
  rollup(
    source: RollupSource,
    filter: RollupFilter,
    groupings: Groupings,
    options?: RollupReadOptions,
  ) {
    return readRollupSets(this.db, source, filter, groupings, options);
  }
  trainSegments(filter: SegmentFilter) {
    return readTrainSegments(this.db, filter);
  }
  station(id: string) {
    return readStation(this.db, id);
  }
  landNames() {
    return readLandNames(this.db);
  }
  operatorNames(ids: readonly string[]) {
    return readOperatorNames(this.db, ids);
  }
  refreshedAt() {
    return readRollupRefreshedAt(this.db);
  }
}

export interface StatsRange {
  readonly from: string;
  readonly to: string;
  readonly categories?: readonly TrainCategory[] | undefined;
}

export function daysIn(from: string, to: string): number {
  return (
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
  );
}

const CATEGORY_SET: ReadonlySet<string> = new Set(TRAIN_CATEGORIES);

function categoryOf(value: string | number | null | undefined): TrainCategory | null {
  return typeof value === "string" && CATEGORY_SET.has(value) ? (value as TrainCategory) : null;
}

function text(value: string | number | null | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

const NO_HISTOGRAM: RollupReadOptions = { histogram: false };

/** A train number or line name rarely has more than a few groups; the busiest are kept. */
export const STATS_MAX_RUN_GROUPS = 20;

const single = (rows: readonly RollupRow[]) => rows[0] ?? { ...EMPTY_TOTALS, key: {} };

function filterOf(range: StatsRange): RollupFilter {
  return { from: range.from, to: range.to, categories: range.categories };
}

function byCategory(rows: readonly RollupRow[]) {
  return rows.map((row) => ({
    category: categoryOf(row.key.category_code),
    summary: summarize(row),
  }));
}

function byDay(rows: readonly RollupRow[]) {
  return rows.map((row) => daySummary(String(row.key.day), row));
}

function byHour(rows: readonly RollupRow[]) {
  return rows
    .filter((row) => typeof row.key.local_hour === "number")
    .map((row) => hourSummary(row.key.local_hour as number, row));
}

/** Statistics read from the WP-2.7 rollups only, shaped into the `@gerlines/schema/stats` contract. */
export class StatsService {
  private readonly reader: StatsReader;
  private readonly now: () => number;
  constructor(reader: StatsReader, now: () => number = Date.now) {
    this.reader = reader;
    this.now = now;
  }

  private async envelope(range: StatsRange) {
    const refreshed = await this.reader.refreshedAt();
    const freshness: StatsFreshness = {
      refreshedAt: refreshed ? refreshed.toISOString() : null,
      maxLagMinutes: STATS_MAX_LAG_MINUTES,
      note: STATS_LAG_NOTE,
    };
    return {
      period: { from: range.from, to: range.to, days: daysIn(range.from, range.to) },
      freshness,
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  private async operators(rows: readonly RollupRow[]): Promise<Map<string, string>> {
    const ids = [
      ...new Set(rows.map((row) => text(row.key.operator_id)).filter((id) => id !== null)),
    ];
    return this.reader.operatorNames(ids);
  }

  async network(range: StatsRange): Promise<StatsNetwork> {
    const filter = filterOf(range);
    const germany: RollupFilter = { ...filter, landCode: "germany" };
    const [
      envelope,
      [total = [], categories = []],
      [lands = []],
      [days = []],
      [hours = []],
      names,
    ] = await Promise.all([
      this.envelope(range),
      this.reader.rollup("land_category_day", germany, [[], ["category_code"]]),
      this.reader.rollup("land_category_day", filter, [["land_code"]]),
      this.reader.rollup("land_category_day", germany, [["day"]], NO_HISTOGRAM),
      this.reader.rollup("land_category_hour", germany, [["local_hour"]], NO_HISTOGRAM),
      this.reader.landNames(),
    ]);
    const totals = single(total);
    const known: ReadonlySet<string> = new Set(STATS_LAND_CODES);
    const stopsOf = (code: string | null) =>
      lands.find((row) => (row.key.land_code ?? null) === code)?.n_stops ?? 0;
    return {
      kind: "network",
      ...envelope,
      categories: range.categories ? [...range.categories] : null,
      summary: summarize(totals),
      byCategory: byCategory(categories),
      byDay: byDay(days),
      byHour: byHour(hours),
      delayHistogram: delayHistogram(totals.delay_hist),
      byLand: lands
        .filter((row) => known.has(String(row.key.land_code)))
        .map((row) => {
          const code = row.key.land_code as StatsLandCode;
          return { landCode: code, name: names.get(code) ?? code, summary: summarize(row) };
        }),
      outsideGermany: { foreignStops: stopsOf("foreign"), unassignedStops: stopsOf(null) },
    };
  }

  async station(id: string, range: StatsRange): Promise<StatsStation | null> {
    const station = await this.reader.station(id);
    if (!station) return null;
    const filter: RollupFilter = { ...filterOf(range), stopPlaceId: id };
    const [envelope, [total = [], categories = [], operatorRows = []], [days = []], [hours = []]] =
      await Promise.all([
        this.envelope(range),
        this.reader.rollup("station_day", filter, [[], ["category_code"], ["operator_id"]]),
        this.reader.rollup("station_day", filter, [["day"]], NO_HISTOGRAM),
        this.reader.rollup("station_hour", filter, [["local_hour"]], NO_HISTOGRAM),
      ]);
    const names = await this.operators(operatorRows);
    const totals = single(total);
    return {
      kind: "station",
      ...envelope,
      categories: range.categories ? [...range.categories] : null,
      station,
      summary: summarize(totals),
      byCategory: byCategory(categories),
      byDay: byDay(days),
      byHour: byHour(hours),
      delayHistogram: delayHistogram(totals.delay_hist),
      departures: {
        observed: totals.n_dep_observed ?? 0,
        punctual6: ratio(totals.n_dep_lt_6min ?? 0, totals.n_dep_observed ?? 0),
      },
      byOperator: operatorRows.map((row) => ({
        operator: operatorOf(row, names),
        summary: summarize(row),
      })),
    };
  }

  async land(code: StatsLandCode, range: StatsRange): Promise<StatsLand> {
    const filter: RollupFilter = { ...filterOf(range), landCode: code };
    const [envelope, [total = [], categories = []], [days = []], [hours = []], names] =
      await Promise.all([
        this.envelope(range),
        this.reader.rollup("land_category_day", filter, [[], ["category_code"]]),
        this.reader.rollup("land_category_day", filter, [["day"]], NO_HISTOGRAM),
        this.reader.rollup("land_category_hour", filter, [["local_hour"]], NO_HISTOGRAM),
        this.reader.landNames(),
      ]);
    const totals = single(total);
    return {
      kind: "land",
      ...envelope,
      categories: range.categories ? [...range.categories] : null,
      land: { code, name: names.get(code) ?? code },
      summary: summarize(totals),
      byCategory: byCategory(categories),
      byDay: byDay(days),
      byHour: byHour(hours),
      delayHistogram: delayHistogram(totals.delay_hist),
    };
  }

  private async runGroups(
    source: "train_day" | "line_day",
    filter: RollupFilter,
    dimensions: readonly RollupGroupColumn[],
  ): Promise<StatsRunGroup[]> {
    const top = { by: dimensions, limit: STATS_MAX_RUN_GROUPS };
    const [[groups = []], [days = []]] = await Promise.all([
      this.reader.rollup(source, filter, [dimensions], { limit: STATS_MAX_RUN_GROUPS }),
      this.reader.rollup(source, { ...filter, top }, [[...dimensions, "day"]], NO_HISTOGRAM),
    ]);
    const names = await this.operators(groups);
    const keyOf = (row: RollupRow) =>
      dimensions.map((column) => String(row.key[column])).join("\u0000");
    const daysByGroup = new Map<string, RollupRow[]>();
    for (const row of days) {
      const list = daysByGroup.get(keyOf(row)) ?? [];
      list.push(row);
      daysByGroup.set(keyOf(row), list);
    }
    return groups.map((row) => ({
      operator: operatorOf(row, names),
      category: categoryOf(row.key.category_code),
      line: text(row.key.line_name),
      runs: row.n_runs ?? 0,
      summary: summarize(row),
      byDay: (daysByGroup.get(keyOf(row)) ?? []).map((day) => ({
        ...daySummary(String(day.key.day), day),
        runs: day.n_runs ?? 0,
      })),
      delayHistogram: delayHistogram(row.delay_hist),
    }));
  }

  async train(number: string, operatorId: string | null, range: StatsRange): Promise<StatsTrain> {
    const filter: RollupFilter = {
      ...filterOf(range),
      trainNumber: number,
      ...(operatorId ? { operatorId } : {}),
    };
    const [envelope, groups] = await Promise.all([
      this.envelope(range),
      this.runGroups("train_day", filter, ["operator_id", "category_code", "line_name"]),
    ]);
    return { kind: "train", ...envelope, number, operatorId, groups };
  }

  /**
   * The segment profile of a train number (R-09) from `stat_segment` and `segment_day`: its most
   * frequent stop sequence in the period, then its other legs, against every train on each leg.
   */
  async trainSegments(
    number: string,
    operatorId: string | null,
    range: StatsRange,
  ): Promise<StatsTrainSegments> {
    const filter: SegmentFilter = {
      trainNumber: number,
      from: range.from,
      to: range.to,
      ...(range.categories ? { categories: range.categories } : {}),
      ...(operatorId ? { operatorId } : {}),
      limit: STATS_MAX_SEGMENTS,
    };
    const [envelope, found] = await Promise.all([
      this.envelope(range),
      this.reader.trainSegments(filter),
    ]);
    return {
      kind: "trainSegments",
      ...envelope,
      number,
      operatorId,
      categories: range.categories ? [...range.categories] : null,
      groups: found.groups.map((group, index) => ({
        category: categoryOf(group.category_code),
        operator:
          group.operator_id === null ? null : { id: group.operator_id, name: group.operator_name },
        runs: group.runs,
        shown: index === 0,
      })),
      route: { runs: found.runs, patternRuns: found.patternRuns },
      minRuns: STATS_SEGMENT_MIN_RUNS,
      note: STATS_SEGMENT_NOTE,
      gainBins: GAIN_BINS,
      segments: found.rows.map(segmentOf),
      truncated: found.pairs > found.rows.length,
    };
  }

  async line(line: string, operatorId: string | null, range: StatsRange): Promise<StatsLine> {
    const filter: RollupFilter = {
      ...filterOf(range),
      lineName: line,
      ...(operatorId ? { operatorId } : {}),
    };
    const [envelope, groups] = await Promise.all([
      this.envelope(range),
      this.runGroups("line_day", filter, ["operator_id", "category_code", "line_name"]),
    ]);
    return { kind: "line", ...envelope, line, operatorId, groups };
  }
}

function operatorOf(row: RollupRow, names: ReadonlyMap<string, string>): StatsOperator | null {
  const id = text(row.key.operator_id);
  return id === null ? null : { id, name: names.get(id) ?? null };
}
