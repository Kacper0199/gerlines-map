import type { CatalogInput, LiveryInput } from "./catalog.ts";
import { DB_QID, dbOperators } from "./logo.ts";

/**
 * Which train a palette row is for: the livery's operator and, for the companies under it,
 * a group; the series of the models that name the livery and of its series_ids; optionally the
 * lines it runs on and the days it is valid on. The web matches a train by the operator and series
 * of its frame row and picks the row, so a series model can be painted per operator.
 */
export interface LiveryRule {
  readonly livery: string;
  readonly row: number;
  readonly operator: string;
  readonly group?: string;
  readonly series: readonly string[];
  readonly lines?: readonly string[];
  readonly validFrom?: string;
  readonly validTo?: string;
}

export interface LiveryRules {
  readonly rules: readonly LiveryRule[];
  readonly groups: Readonly<Record<string, readonly string[]>>;
}

const DB_GROUP = "db";

function isoDay(value: string | Date | null | undefined): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

const sorted = (items: Iterable<string>): string[] =>
  [...new Set(items)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** Operator ids whose Wikidata item sits under the item of `operatorId`, followed through the rows. */
function companiesUnder(operatorId: string, catalog: CatalogInput): string[] {
  const operators = catalog.operators ?? [];
  const root = operators.find((o) => o.operator_id === operatorId)?.wikidata_qid;
  if (!root) return [];
  const members = new Set([root]);
  for (let grown = true; grown; ) {
    grown = false;
    for (const operator of operators) {
      const qid = operator.wikidata_qid;
      if (!qid || members.has(qid)) continue;
      if (operator.parents?.some((p) => p.wikidata_qid && members.has(p.wikidata_qid))) {
        members.add(qid);
        grown = true;
      }
    }
  }
  return operators
    .filter((o) => o.wikidata_qid && members.has(o.wikidata_qid) && o.operator_id !== operatorId)
    .map((o) => o.operator_id);
}

/**
 * A company directly under Deutsche Bahn that has companies of its own under it (DB Regio AG, DB
 * Fernverkehr AG): the one whose design the companies below it wear. A regional subsidiary such as
 * DB Regio Baden-Wuerttemberg or a company without companies under it is not a root.
 */
function isDbRoot(operatorId: string, catalog: CatalogInput): boolean {
  const operator = (catalog.operators ?? []).find((o) => o.operator_id === operatorId);
  const underDb =
    operator?.wikidata_qid === DB_QID || operator?.parents?.some((p) => p.wikidata_qid === DB_QID);
  return Boolean(underDb) && companiesUnder(operatorId, catalog).length > 0;
}

/**
 * Per livery id the group its operator opens, so the companies below it wear the livery too: the
 * DB group for a livery of a DB root company, the operator's own companies for any other operator
 * that has some; none for every other livery, which matches its own operator only (a Land livery of
 * a regional subsidiary such as bwegt must not reach the other DB networks).
 */
export function operatorGroups(catalog: CatalogInput): ReadonlyMap<string, string> {
  const db = dbOperators(catalog.operators ?? []);
  const groups = new Map<string, string>();
  for (const livery of catalog.liveries) {
    const operator = livery.operator_id;
    if (!operator) continue;
    if (db.has(operator) && isDbRoot(operator, catalog)) groups.set(livery.livery_id, DB_GROUP);
    else if (companiesUnder(operator, catalog).length > 0) groups.set(livery.livery_id, operator);
  }
  return groups;
}

function membersOf(group: string, operator: string, catalog: CatalogInput): string[] {
  const members =
    group === DB_GROUP
      ? [...dbOperators(catalog.operators ?? [])]
      : companiesUnder(operator, catalog);
  return sorted([operator, ...members]);
}

function seriesOf(livery: LiveryInput, catalog: CatalogInput): string[] {
  const named = catalog.vehicles
    .filter((v) => v.livery_id === livery.livery_id && v.series_id)
    .map((v) => v.series_id as string);
  return sorted([...(livery.series_ids ?? []), ...named]);
}

function ruleOf(
  livery: LiveryInput,
  row: number,
  group: string | undefined,
  series: readonly string[],
): LiveryRule {
  const lines = sorted(livery.lines ?? []);
  const validFrom = isoDay(livery.valid_from);
  const validTo = isoDay(livery.valid_to);
  return {
    livery: livery.livery_id,
    row,
    operator: livery.operator_id as string,
    ...(group ? { group } : {}),
    series,
    ...(lines.length ? { lines } : {}),
    ...(validFrom ? { validFrom } : {}),
    ...(validTo ? { validTo } : {}),
  };
}

const FOREVER = "9999-12-31";

/** The rank a rule has for a train of `operator`, the same as the web's: own line rule 2, own plain 1, group plain 0. */
function rankOf(rule: LiveryRule, groups: LiveryRules["groups"], operator: string): number {
  if (rule.operator === operator) return rule.lines ? 2 : 1;
  const inGroup = rule.group ? (groups[rule.group]?.includes(operator) ?? false) : false;
  return inGroup && !rule.lines ? 0 : -1;
}

function sharesDay(a: LiveryRule, b: LiveryRule): boolean {
  const starts = (a.validFrom ?? "") > (b.validFrom ?? "") ? a.validFrom : b.validFrom;
  const ends = (a.validTo ?? FOREVER) < (b.validTo ?? FOREVER) ? a.validTo : b.validTo;
  return !starts || !ends || starts <= ends;
}

function sharesLine(a: LiveryRule, b: LiveryRule): boolean {
  if (!(a.lines || b.lines)) return true;
  return Boolean(a.lines?.some((line) => b.lines?.includes(line)));
}

/**
 * Pairs of rules that can tie for one operator: they name the same series, rank the same for an
 * operator (its own plain rules, its own rules of one line, the plain rules of the one group it is
 * in) and share a day, so the web could not tell which row to draw. Empty for a sound
 * catalogue.
 */
export function liveryTies(rules: readonly LiveryRule[], groups: LiveryRules["groups"]): string[] {
  const ties: string[] = [];
  rules.forEach((a, index) => {
    for (const b of rules.slice(index + 1)) {
      const series = a.series.find((id) => b.series.includes(id));
      if (!series || !sharesDay(a, b) || !sharesLine(a, b)) continue;
      const operators = new Set([
        a.operator,
        b.operator,
        ...(groups[a.group ?? ""] ?? []),
        ...(groups[b.group ?? ""] ?? []),
      ]);
      const operator = [...operators].find((id) => {
        const rank = rankOf(a, groups, id);
        return rank >= 0 && rank === rankOf(b, groups, id);
      });
      if (operator)
        ties.push(`${a.livery} and ${b.livery} tie for ${operator} on series ${series}`);
    }
  });
  return ties;
}

/** The group a livery opens: one of its own when it names `also_operator_ids`, else its operator's company tree. */
function groupOfLivery(
  livery: LiveryInput,
  groupOf: ReadonlyMap<string, string>,
): string | undefined {
  const groupFromTree = groupOf.get(livery.livery_id);
  if (!livery.also_operator_ids?.length) return groupFromTree;
  if (groupFromTree) {
    throw new Error(
      `${livery.livery_id}: also_operator_ids on a livery whose operator already opens a group`,
    );
  }
  return livery.livery_id;
}

function membersOfLivery(livery: LiveryInput, group: string, catalog: CatalogInput): string[] {
  const operator = livery.operator_id as string;
  return livery.also_operator_ids?.length
    ? [operator, ...livery.also_operator_ids]
    : membersOf(group, operator, catalog);
}

/**
 * The livery rules of the palette: one per livery that names an operator and at least one series
 * (through series_ids or the models that use it), in the order of the palette rows, with the
 * members of every group once. A livery with neither stays a plain row. A livery that names
 * `also_operator_ids` is worn by those operators as well: it gets a group of its own, its operator
 * first and then the named ones.
 */
export function liveryRules(
  catalog: CatalogInput,
  rows: readonly { readonly id: string }[],
): LiveryRules {
  const groupOf = operatorGroups(catalog);
  const rules: LiveryRule[] = [];
  const groups = new Map<string, readonly string[]>();
  for (const livery of [...catalog.liveries].sort((a, b) => (a.livery_id < b.livery_id ? -1 : 1))) {
    const row = rows.findIndex((r) => r.id === livery.livery_id);
    const series = seriesOf(livery, catalog);
    if (!livery.operator_id || row < 0 || series.length === 0) continue;
    const group = groupOfLivery(livery, groupOf);
    if (group && !groups.has(group)) groups.set(group, membersOfLivery(livery, group, catalog));
    rules.push(ruleOf(livery, row, group, series));
  }
  const ordered = Object.fromEntries([...groups].sort(([a], [b]) => (a < b ? -1 : 1)));
  const ties = liveryTies(rules, ordered);
  if (ties.length > 0) throw new Error(`ambiguous liveries: ${ties.join("; ")}`);
  return { rules, groups: ordered };
}
