import type {
  Journey,
  JourneyLeg,
  LegRun,
  ReliabilityMissingReason,
  TrainReliability,
  TransitLeg,
  WalkLeg,
} from "@gerlines/schema/journeys";
import { reliabilityKeyOf } from "./journeys-client.ts";

const LETTER = /\p{L}/u;
const MINUTE_MS = 60_000;

/** DELFI pads trip numbers with zeros (001028); people read them without (1028). */
export function displayNumber(number: string): string {
  return number.replace(/^0+(?=\d)/, "");
}

export interface LegNameCopy {
  trainNumber(number: string): string;
  line(line: string): string;
}

export interface LegName {
  readonly title: string;
  readonly detail: string | null;
}

/**
 * A line written with its product (RE4, S1, FLX10) is the title, with the train number under it;
 * a bare line number (an ICE line such as 42) never stands alone: the title is Train 1028 with
 * Line 42 under it (DESIGN.md train card rules).
 */
export function legName(
  leg: Pick<TransitLeg, "line" | "tripNumber">,
  copy: LegNameCopy,
  fallback: string,
): LegName {
  const number = leg.tripNumber ? displayNumber(leg.tripNumber) : null;
  if (leg.line && LETTER.test(leg.line)) {
    return { title: leg.line, detail: number ? copy.trainNumber(number) : null };
  }
  if (number) {
    return { title: copy.trainNumber(number), detail: leg.line ? copy.line(leg.line) : null };
  }
  return leg.line
    ? { title: copy.line(leg.line), detail: null }
    : { title: fallback, detail: null };
}

export function durationParts(seconds: number): { hours: number; minutes: number } {
  const total = Math.round(seconds / 60);
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}

/** Whole minutes late (negative when early); null without a realtime time or when on the minute. */
export function delayMinutes(time: string | null, scheduled: string | null): number | null {
  if (!(time && scheduled)) return null;
  const minutes = Math.round((Date.parse(time) - Date.parse(scheduled)) / MINUTE_MS);
  return minutes === 0 ? null : minutes;
}

/**
 * The run of a leg's train while it runs: from its planned first departure to its planned
 * last arrival plus the leg's arrival delay, so the leg can open the live train card; else null.
 */
export function liveRunOf(leg: TransitLeg, nowMs: number): LegRun | null {
  const run = leg.run ?? null;
  if (run === null || leg.cancelled) return null;
  const late = Math.max(0, Date.parse(leg.arrival) - Date.parse(leg.scheduledArrival));
  const runs = nowMs >= Date.parse(run.departure) && nowMs <= Date.parse(run.arrival) + late;
  return runs ? run : null;
}

export function transitLegs(journey: Journey): TransitLeg[] {
  return journey.legs.filter((leg): leg is TransitLeg => leg.kind === "transit");
}

export type ReliabilityEntry = TrainReliability | { readonly status: "loading" };

/** A train with fewer recorded runs gets no share: one good or bad day must not read as a record. */
export const RELIABILITY_MIN_RUNS = 5;

export type JourneyReliability =
  | { readonly kind: "loading" }
  | {
      readonly kind: "known";
      readonly share: number;
      readonly runs: number;
      /** The first service day with an observed arrival of that train. */
      readonly firstDay: string | null;
      /** The leg with the lowest share, when the journey has more than one train. */
      readonly weakest: TransitLeg | null;
      readonly missing: number;
      /** Trains with some history but fewer runs than the minimum. */
      readonly unrated: number;
    }
  | {
      readonly kind: "thin";
      readonly runs: number;
      /** The train with the fewest runs, when the journey has more than one train. */
      readonly leg: TransitLeg | null;
      readonly missing: number;
    }
  | { readonly kind: "missing"; readonly reason: ReliabilityMissingReason };

type KnownEntry = Extract<TrainReliability, { status: "known" }>;

/**
 * The hint for one journey: the lowest punctuality among its trains with at least
 * RELIABILITY_MIN_RUNS recorded runs, so a journey is as reliable as its weakest train, with how
 * many trains have no or too little history; the run count alone when no train has enough runs;
 * missing with the first leg's reason when no train has any.
 */
export function journeyReliability(
  journey: Journey,
  entries: ReadonlyMap<string, ReliabilityEntry>,
): JourneyReliability {
  const legs = transitLegs(journey);
  const looked = legs.map((leg) => {
    const key = reliabilityKeyOf(leg);
    const entry: ReliabilityEntry | undefined = key === null ? undefined : entries.get(key);
    return { leg, entry: key === null ? null : (entry ?? { status: "loading" as const }) };
  });
  if (looked.some(({ entry }) => entry?.status === "loading")) return { kind: "loading" };
  const known = looked.flatMap(({ leg, entry }) =>
    entry?.status === "known" ? [{ leg, entry: entry as KnownEntry }] : [],
  );
  if (known.length === 0) {
    const first = looked[0]?.entry;
    return {
      kind: "missing",
      reason: first?.status === "missing" ? first.reason : "no_number",
    };
  }
  const missing = legs.length - known.length;
  const rated = known.filter(({ entry }) => entry.runs >= RELIABILITY_MIN_RUNS);
  if (rated.length === 0) {
    const thinnest = known.reduce((low, next) => (next.entry.runs < low.entry.runs ? next : low));
    return {
      kind: "thin",
      runs: thinnest.entry.runs,
      leg: legs.length > 1 ? thinnest.leg : null,
      missing,
    };
  }
  const weakest = rated.reduce((low, next) =>
    next.entry.punctual6 < low.entry.punctual6 ? next : low,
  );
  return {
    kind: "known",
    share: weakest.entry.punctual6,
    runs: weakest.entry.runs,
    firstDay: weakest.entry.firstDay,
    weakest: legs.length > 1 ? weakest.leg : null,
    missing,
    unrated: known.length - rated.length,
  };
}

export type DetailItem =
  | {
      readonly kind: "transit";
      readonly leg: TransitLeg;
      readonly from: boolean;
      readonly to: boolean;
    }
  | { readonly kind: "walk"; readonly leg: WalkLeg }
  | {
      readonly kind: "change";
      readonly arrive: TransitLeg;
      readonly depart: TransitLeg;
      readonly walk: WalkLeg | null;
    };

function transitBefore(legs: readonly JourneyLeg[], index: number): TransitLeg | null {
  const before = legs[index - 1];
  if (before?.kind === "transit") return before;
  const earlier = legs[index - 2];
  return before?.kind === "walk" && earlier?.kind === "transit" ? earlier : null;
}

/**
 * The rows of the shown journey: each train with its ends, and between two trains one change row
 * that holds the arrival, the next departure and any walk, so a station never appears twice.
 */
export function detailItems(legs: readonly JourneyLeg[]): DetailItem[] {
  const items: DetailItem[] = [];
  legs.forEach((leg, index) => {
    if (leg.kind === "walk") {
      const joins = legs[index - 1]?.kind === "transit" && legs[index + 1]?.kind === "transit";
      if (!joins) items.push({ kind: "walk", leg });
      return;
    }
    const before = transitBefore(legs, index);
    if (before) {
      const between = legs[index - 1];
      items.push({
        kind: "change",
        arrive: before,
        depart: leg,
        walk: between?.kind === "walk" ? between : null,
      });
    }
    const after = legs.slice(index + 1).find((next) => next.kind === "transit");
    const nextIndex = after ? legs.indexOf(after) : -1;
    items.push({
      kind: "transit",
      leg,
      from: before === null,
      to: nextIndex === -1 || transitBefore(legs, nextIndex) !== leg,
    });
  });
  return items;
}

/** Earlier pages before, later pages after, each journey once, in departure order. */
export function mergeJourneys(current: readonly Journey[], page: readonly Journey[]): Journey[] {
  const byId = new Map(current.map((journey) => [journey.id, journey]));
  for (const journey of page) byId.set(journey.id, journey);
  return [...byId.values()].sort(
    (a, b) =>
      Date.parse(a.departure) - Date.parse(b.departure) ||
      Date.parse(a.arrival) - Date.parse(b.arrival),
  );
}

/** [west, south, east, north] over every stop and route line point of the journey. */
export function journeyBounds(
  journey: Journey,
  linePoints: (leg: TransitLeg) => readonly (readonly [number, number])[],
): [number, number, number, number] {
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  const add = (lon: number, lat: number) => {
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  };
  for (const leg of journey.legs) {
    add(leg.from.lon, leg.from.lat);
    add(leg.to.lon, leg.to.lat);
    if (leg.kind === "transit") for (const [lon, lat] of linePoints(leg)) add(lon, lat);
  }
  return [west, south, east, north];
}
