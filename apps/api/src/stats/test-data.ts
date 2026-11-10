import type {
  RollupFilter,
  RollupGroupColumn,
  RollupReadOptions,
  RollupRow,
  RollupSource,
  RollupTotals,
  SegmentFilter,
  StationIdentity,
  TrainSegments,
} from "@gerlines/db";
import { STATS_DELAY_BINS } from "@gerlines/schema/stats";
import type { StatsReader } from "./service.ts";
import { EMPTY_TOTALS } from "./summary.ts";

export const STATION_A = "4eda9b92-2ddf-5610-b59b-ed665a8b2610";

export function totals(
  values: Partial<RollupTotals>,
  bins: Record<number, number> = {},
): RollupTotals {
  return {
    ...EMPTY_TOTALS,
    ...values,
    delay_hist: [0, ...STATS_DELAY_BINS.map((_, bin) => bins[bin] ?? 0), 0],
  };
}

export interface RecordedCall {
  readonly source: RollupSource;
  readonly filter: RollupFilter;
  readonly groupBy: readonly RollupGroupColumn[];
  readonly histogram: boolean;
  readonly limit: number | undefined;
}

/** A reader that answers from golden rollup rows keyed by source and grouping, and records the calls. */
export class GoldenReader implements StatsReader {
  readonly calls: RecordedCall[] = [];
  readonly segmentCalls: SegmentFilter[] = [];
  private readonly rows: Record<string, RollupRow[]>;
  failWith: Error | null = null;
  segments: TrainSegments = { runs: 0, patternRuns: 0, pairs: 0, groups: [], rows: [] };

  constructor(rows: Record<string, RollupRow[]>) {
    this.rows = rows;
  }

  async rollup(
    source: RollupSource,
    filter: RollupFilter,
    groupings: readonly (readonly RollupGroupColumn[])[],
    { histogram = true, limit }: RollupReadOptions = {},
  ): Promise<RollupRow[][]> {
    if (this.failWith) throw this.failWith;
    const scope = typeof filter.landCode === "string" ? `:${filter.landCode}` : "";
    const rowsOf = (groupBy: readonly RollupGroupColumn[]) =>
      this.rows[`${source}${scope}/${groupBy.join(",")}`] ?? [];
    const busiest = (rows: readonly RollupRow[], count: number | undefined) =>
      count === undefined
        ? [...rows]
        : [...rows].sort((left, right) => right.n_stops - left.n_stops).slice(0, count);
    const top = filter.top;
    const keyOf = (row: RollupRow) =>
      top?.by.map((column) => String(row.key[column])).join("\u0000");
    const kept = top && new Set(busiest(rowsOf(top.by), top.limit).map(keyOf));
    return groupings.map((groupBy) => {
      this.calls.push({ source, filter, groupBy, histogram, limit });
      const rows = kept ? rowsOf(groupBy).filter((row) => kept.has(keyOf(row))) : rowsOf(groupBy);
      return busiest(rows, limit);
    });
  }

  async trainSegments(filter: SegmentFilter): Promise<TrainSegments> {
    if (this.failWith) throw this.failWith;
    this.segmentCalls.push(filter);
    return this.segments;
  }

  async station(id: string): Promise<StationIdentity | null> {
    return id === STATION_A ? { id, name: "Köln Hbf", landCode: "DE-NW" } : null;
  }

  async landNames(): Promise<Map<string, string>> {
    return new Map([
      ["DE-BY", "Bayern"],
      ["DE-NW", "Nordrhein-Westfalen"],
    ]);
  }

  async operatorNames(ids: readonly string[]): Promise<Map<string, string>> {
    return new Map(
      ids.filter((id) => id === "db-fernverkehr-ag").map((id) => [id, "DB Fernverkehr AG"]),
    );
  }

  async refreshedAt(): Promise<Date | null> {
    return new Date("2026-11-07T14:05:00Z");
  }
}
