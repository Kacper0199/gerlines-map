import { IDENTICAL_BODY_TABLE } from "./identical-bodies.generated.ts";
import { type BodyRelation, type BodyTable, bodyOf } from "./identical-body-rules.ts";

export type { BodyRelation, BodyTable };
export { IDENTICAL_BODY_TABLE };

export function relatedBody(
  seriesId: string | null | undefined,
  table: BodyTable = IDENTICAL_BODY_TABLE,
): BodyRelation | undefined {
  return seriesId ? bodyOf(table, seriesId) : undefined;
}
