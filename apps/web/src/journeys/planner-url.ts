import {
  JOURNEY_OPERATOR_TERM_MAX,
  JOURNEY_OPERATOR_TERM_MIN,
  JOURNEY_OPERATOR_TERMS_MAX,
} from "@gerlines/schema/constants";
import { isBerlinLocal } from "./berlin-time.ts";

export const PLANNER_CATEGORIES = ["hsr", "ld", "night", "rfast", "reg", "sbahn"] as const;
export type PlannerCategory = (typeof PLANNER_CATEGORIES)[number];

export const PLANNER_PARAMS = {
  open: "plan",
  from: "jfrom",
  to: "jto",
  time: "jtime",
  arriveBy: "jarr",
  categories: "jcat",
  operator: "jop",
  selected: "jsel",
} as const;

/** The planner a link holds: the stations by stop place id, the Berlin wall clock time, the filters, the shown journey. */
export interface PlannerUrl {
  readonly open: boolean;
  readonly from: string | null;
  readonly to: string | null;
  readonly time: string | null;
  readonly arriveBy: boolean;
  readonly categories: readonly PlannerCategory[] | null;
  readonly operator: string | null;
  readonly selected: string | null;
}

export const CLOSED_PLANNER: PlannerUrl = {
  open: false,
  from: null,
  to: null,
  time: null,
  arriveBy: false,
  categories: null,
  operator: null,
  selected: null,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const JOURNEY_ID = /^[0-9a-f]{16}$/;
const OPERATOR_TERM = new RegExp(
  `^[\\p{L}\\p{N}][\\p{L}\\p{N} .&-]{${JOURNEY_OPERATOR_TERM_MIN - 1},${JOURNEY_OPERATOR_TERM_MAX - 1}}$`,
  "u",
);

/** A comma list of operator names, read as the journeys API reads its `operators` parameter. */
function operatorOf(value: string | undefined): string | null {
  const text = value?.trim() ?? "";
  if (text === "") return null;
  const terms = text.split(",").map((term) => term.trim());
  return terms.length <= JOURNEY_OPERATOR_TERMS_MAX &&
    terms.every((term) => OPERATOR_TERM.test(term))
    ? text
    : null;
}
const CATEGORY_SET: ReadonlySet<string> = new Set(PLANNER_CATEGORIES);

function uuidOf(value: string | null): string | null {
  const lower = value?.trim().toLowerCase() ?? null;
  return lower !== null && UUID.test(lower) ? lower : null;
}

function categoriesOf(value: string | null): PlannerCategory[] | null {
  if (value === null) return null;
  const listed = PLANNER_CATEGORIES.filter((category) =>
    value.split(",").some((part) => part.trim() === category),
  );
  const unknown = value.split(",").some((part) => !CATEGORY_SET.has(part.trim()));
  return listed.length === 0 || unknown || listed.length === PLANNER_CATEGORIES.length
    ? null
    : listed;
}

/**
 * Reads the planner from an address. Without `plan=1` the planner is closed, and the other
 * parameters are a search another panel set aside, back when the planner opens.
 */
export function parsePlannerUrl(search: string): PlannerUrl {
  const params = new URLSearchParams(search);
  const time = params.get(PLANNER_PARAMS.time);
  const operator = operatorOf(params.get(PLANNER_PARAMS.operator) ?? undefined);
  const selected = params.get(PLANNER_PARAMS.selected);
  return {
    open: params.get(PLANNER_PARAMS.open) === "1",
    from: uuidOf(params.get(PLANNER_PARAMS.from)),
    to: uuidOf(params.get(PLANNER_PARAMS.to)),
    time: time !== null && isBerlinLocal(time) ? time : null,
    arriveBy: params.get(PLANNER_PARAMS.arriveBy) === "1",
    categories: categoriesOf(params.get(PLANNER_PARAMS.categories)),
    operator,
    selected: selected !== null && JOURNEY_ID.test(selected) ? selected : null,
  };
}

function plannerEntries(planner: PlannerUrl): [string, string | null][] {
  return [
    [PLANNER_PARAMS.open, planner.open ? "1" : null],
    [PLANNER_PARAMS.from, planner.from],
    [PLANNER_PARAMS.to, planner.to],
    [PLANNER_PARAMS.time, planner.time],
    [PLANNER_PARAMS.arriveBy, planner.arriveBy ? "1" : null],
    [PLANNER_PARAMS.categories, planner.categories?.join(",") ?? null],
    [PLANNER_PARAMS.operator, planner.operator],
    [PLANNER_PARAMS.selected, planner.selected],
  ];
}

/** The address search with the planner written in; every other parameter stays as it was. */
export function writePlannerUrl(search: string, planner: PlannerUrl): string {
  const params = new URLSearchParams(search);
  for (const name of Object.values(PLANNER_PARAMS)) params.delete(name);
  for (const [name, value] of plannerEntries(planner)) {
    if (value) params.set(name, value);
  }
  const query = params.toString().replaceAll("%2C", ",").replaceAll("%3A", ":");
  return query === "" ? "" : `?${query}`;
}

/** Whether two planner states ask for the same search, open or set aside; the shown journey does not count. */
export function sameSearch(a: PlannerUrl, b: PlannerUrl): boolean {
  return (
    a.open === b.open &&
    a.from === b.from &&
    a.to === b.to &&
    a.time === b.time &&
    a.arriveBy === b.arriveBy &&
    (a.categories ?? []).join() === (b.categories ?? []).join() &&
    a.operator === b.operator
  );
}
