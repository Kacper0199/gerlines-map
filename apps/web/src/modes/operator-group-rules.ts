import { COLOURED_GROUPS, type ColouredGroup } from "./operator-group-list.ts";

export interface OperatorRow {
  readonly operator_id: string;
  readonly feed_name: string;
  readonly wikidata_qid?: string;
  readonly parents?: readonly { readonly name: string; readonly wikidata_qid?: string }[];
}

/**
 * Parent organisations the catalogue lists under several items that are one company group (Wikidata
 * ownership, P749 or P127): the DB Regio items belong to Deutsche Bahn; the Transdev items, Transdev
 * Regio Ost and Bayerische Oberlandbahn to Transdev; BeNEX is the former name of Netinera Deutschland,
 * and Regentalbahn and Die Länderbahn are Netinera companies.
 */
export const PARENT_ALIASES: Readonly<Record<string, string>> = {
  Q18853: "Q9322",
  Q1152076: "Q9322",
  Q897024: "Q104185516",
  Q442637: "Q104185516",
  Q1382191: "Q104185516",
  Q259805: "Q104185516",
  Q473581: "Q558401",
  Q882263: "Q558401",
  Q315339: "Q558401",
};

const DB_QID = "Q9322";
const DB_FEED_NAME = /^DB[ -]/;

/**
 * The key of the group an operator belongs to: the first parent organisation the catalogue lists, as
 * its Wikidata item. An operator without a parent is its own group, except one whose feed name starts
 * with DB (DB RegioNetz and DB Zug rows whose item lacks the parent), which belongs to Deutsche Bahn.
 */
export function groupKeyOf(row: OperatorRow): string {
  const parent = row.parents?.[0];
  if (parent) {
    const qid = parent.wikidata_qid;
    return qid ? (PARENT_ALIASES[qid] ?? qid) : `name:${parent.name}`;
  }
  if (DB_FEED_NAME.test(row.feed_name)) return DB_QID;
  return row.wikidata_qid ?? `operator:${row.operator_id}`;
}

export function operatorGroupOfRow(row: OperatorRow): ColouredGroup | "other" {
  const key = groupKeyOf(row);
  return COLOURED_GROUPS.find((group) => group.qid === key)?.id ?? "other";
}

export function groupTable(
  rows: readonly OperatorRow[],
): Readonly<Record<string, ColouredGroup | "other">> {
  const entries = rows
    .map((row) => [row.operator_id, operatorGroupOfRow(row)] as const)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return Object.fromEntries(entries);
}
