import type { CatalogInput, OperatorInput, VehicleInput } from "./catalog.ts";
import type { CarSpec } from "./spec.ts";

/** Deutsche Bahn AG on Wikidata: the DB logo belongs to it and to the companies under it. */
export const DB_QID = "Q9322";

/**
 * Operator ids of the DB group: operators.yaml rows whose Wikidata item is Deutsche Bahn or has a
 * parent organisation in the group, followed through the catalogue's own rows (DB Regio NRW, DB
 * Regio, Deutsche Bahn).
 */
export function dbOperators(operators: readonly OperatorInput[]): ReadonlySet<string> {
  const group = new Set([DB_QID]);
  for (let grown = true; grown; ) {
    grown = false;
    for (const operator of operators) {
      const qid = operator.wikidata_qid;
      if (!qid || group.has(qid)) continue;
      if (operator.parents?.some((p) => p.wikidata_qid && group.has(p.wikidata_qid))) {
        group.add(qid);
        grown = true;
      }
    }
  }
  return new Set(
    operators.filter((o) => o.wikidata_qid && group.has(o.wikidata_qid)).map((o) => o.operator_id),
  );
}

/**
 * A model keeps the DB logo plates of its fronts when its own livery names an operator of the DB
 * group, or when a livery of a DB operator names its series: a DB train of that series
 * is painted in that row and shows the plate, while the neutral row and every other operator's row
 * hide the plate's cells (palette `logoRows`). Any other model draws no plate.
 */
export function drawsDbLogo(model: VehicleInput, catalog: CatalogInput): boolean {
  const group = dbOperators(catalog.operators ?? []);
  const isDb = (operator: string | null | undefined) =>
    Boolean(operator) && group.has(operator as string);
  const own = catalog.liveries.find((l) => l.livery_id === model.livery_id)?.operator_id;
  if (isDb(own)) return true;
  const series = model.series_id;
  return (
    Boolean(series) &&
    catalog.liveries.some((l) => isDb(l.operator_id) && l.series_ids?.includes(series as string))
  );
}

/** The car without the `logo` decals of its front. */
export function withoutLogo(spec: CarSpec): CarSpec {
  const front = spec.front;
  if (!front?.decals?.some((d) => d.logo)) return spec;
  return { ...spec, front: { ...front, decals: front.decals.filter((d) => !d.logo) } };
}
