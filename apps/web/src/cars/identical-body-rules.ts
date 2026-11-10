export interface BodyRow {
  readonly series_id: string;
  readonly related_series_id: string;
  readonly verdict: "accepted" | "rejected";
}

export interface SeriesRow {
  readonly series_id: string;
  readonly name: string;
}

/** The series whose forge model a train of another series is drawn with, and its catalogue name. */
export interface BodyRelation {
  readonly relatedSeriesId: string;
  readonly relatedName: string;
}

export type BodyTable = Readonly<Record<string, BodyRelation>>;

/** The accepted rows of catalog/identical-bodies.yaml keyed by the series that has no model of its own. */
export function bodyTable(rows: readonly BodyRow[], series: readonly SeriesRow[]): BodyTable {
  const names = new Map(series.map((row) => [row.series_id, row.name]));
  const table: Record<string, BodyRelation> = Object.create(null);
  for (const row of rows) {
    if (row.verdict !== "accepted") continue;
    if (!names.has(row.series_id)) {
      throw new Error(`${row.series_id}: series is not in the catalogue`);
    }
    const relatedName = names.get(row.related_series_id);
    if (relatedName === undefined) {
      throw new Error(
        `${row.series_id}: related series ${row.related_series_id} is not in the catalogue`,
      );
    }
    if (Object.hasOwn(table, row.series_id)) {
      throw new Error(`${row.series_id}: appears in two accepted rows`);
    }
    table[row.series_id] = { relatedSeriesId: row.related_series_id, relatedName };
  }
  return { ...table };
}

/** The relation of a series, never one inherited from Object.prototype. */
export function bodyOf(table: BodyTable, seriesId: string): BodyRelation | undefined {
  return Object.hasOwn(table, seriesId) ? table[seriesId] : undefined;
}

/** The related series of the table that none of the forge's `modelledSeries` covers. */
export function missingRelatedModels(table: BodyTable, modelledSeries: Iterable<string>): string[] {
  const modelled = new Set(modelledSeries);
  return Object.values(table)
    .map((relation) => relation.relatedSeriesId)
    .filter((id) => !modelled.has(id));
}
