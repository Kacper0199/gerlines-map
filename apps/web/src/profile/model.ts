import type { StatsTrainSegments } from "@gerlines/schema/stats";
import { CURTAIN_CAP_MINUTES, curtainMinutes, type GainClass, gainClass } from "./scale.ts";

export type Quantile = "median" | "p80";

export type MissingReason = "no_runs" | "too_few_runs" | "no_gains" | "not_in_profile";

export interface KnownFigures {
  readonly status: "known";
  readonly runs: number;
  readonly medianGainS: number;
  readonly p80GainS: number;
}

export interface MissingFigures {
  readonly status: "missing";
  readonly runs: number;
  readonly reason: MissingReason;
}

export type Figures = KnownFigures | MissingFigures;

/** One leg between two consecutive stops of the train, with the profile figures the API holds for that pair of places. */
export interface ProfileLeg {
  readonly index: number;
  readonly from: string;
  readonly to: string;
  /** Position of the stop on the drawn route as a fractional vertex index, null while the route is not placed. */
  readonly fromVertex: number | null;
  readonly toVertex: number | null;
  readonly train: Figures;
  readonly all: Figures;
}

/** What the map draws of the profile: the legs with their figures and the quantile the colour and the curtain follow. */
export interface ProfileOverlay {
  readonly legs: readonly ProfileLeg[];
  readonly quantile: Quantile;
}

/** The leg under the pointer, in pixels of the map container. */
export interface ProfileHover {
  readonly leg: number;
  readonly x: number;
  readonly y: number;
}

export interface StopRef {
  readonly stopPlaceId: string;
  readonly name: string;
  /** Every scheduled and predicted arrival and departure of the stop in Unix seconds, each once. */
  readonly times?: readonly number[];
  readonly cancelled?: boolean;
}

export interface BuiltProfile {
  readonly legs: readonly ProfileLeg[];
  /** Whether every stop has a position on the drawn route. */
  readonly placed: boolean;
  /**
   * Legs the answer holds under the same two station names but other station ids. They stay without figures, since
   * a name is not an identity; the card says how many there are.
   */
  readonly sameNameOtherIds: number;
}

type ApiFigures = StatsTrainSegments["segments"][number]["train"];

function figuresOf(api: ApiFigures): Figures {
  return api.status === "known"
    ? {
        status: "known",
        runs: api.runs,
        medianGainS: api.medianGainS,
        p80GainS: api.p80GainS,
      }
    : { status: "missing", runs: api.runs, reason: api.reason };
}

const NOT_IN_PROFILE: MissingFigures = { status: "missing", runs: 0, reason: "not_in_profile" };

function indexOf(answer: StatsTrainSegments) {
  const byPair = new Map<string, StatsTrainSegments["segments"][number]>();
  const byNames = new Set<string>();
  for (const segment of answer.segments) {
    const key = `${segment.from.id}|${segment.to.id}`;
    if (!byPair.has(key)) byPair.set(key, segment);
    byNames.add(`${segment.from.name}|${segment.to.name}`);
  }
  return { byPair, byNames };
}

/**
 * The legs of the train's stop list matched to the answer by the ids of the two stop places. A pair the
 * answer does not hold stays a leg without figures: the profile never fills a gap with a neighbour.
 */
export function buildProfileLegs(
  stops: readonly StopRef[],
  answer: StatsTrainSegments,
  stopVertices: Float32Array | undefined,
): BuiltProfile {
  const { byPair, byNames } = indexOf(answer);
  const placed = stopVertices !== undefined && stopVertices.length === stops.length;
  const legs: ProfileLeg[] = [];
  let sameNameOtherIds = 0;
  for (let index = 0; index + 1 < stops.length; index++) {
    const from = stops[index] as StopRef;
    const to = stops[index + 1] as StopRef;
    const segment = byPair.get(`${from.stopPlaceId}|${to.stopPlaceId}`);
    if (!segment && byNames.has(`${from.name}|${to.name}`)) sameNameOtherIds++;
    legs.push({
      index,
      from: from.name,
      to: to.name,
      fromVertex: placed ? (stopVertices[index] as number) : null,
      toVertex: placed ? (stopVertices[index + 1] as number) : null,
      train: segment ? figuresOf(segment.train) : NOT_IN_PROFILE,
      all: segment ? figuresOf(segment.all) : NOT_IN_PROFILE,
    });
  }
  return { legs, placed, sameNameOtherIds };
}

export type LegMeasure =
  | {
      readonly status: "known";
      readonly trainS: number;
      readonly allS: number;
      readonly differenceMinutes: number;
      readonly gain: GainClass;
      readonly curtainMinutes: number;
    }
  | {
      readonly status: "missing";
      readonly side: "train" | "all";
      readonly reason: MissingReason;
      readonly runs: number;
    };

const quantileOf = (figures: KnownFigures, quantile: Quantile) =>
  quantile === "median" ? figures.medianGainS : figures.p80GainS;

/** The colour class and curtain height of a leg by the chosen quantile; missing when either side has no figures. */
export function legMeasure(leg: ProfileLeg, quantile: Quantile): LegMeasure {
  if (leg.train.status === "missing") {
    return { status: "missing", side: "train", reason: leg.train.reason, runs: leg.train.runs };
  }
  if (leg.all.status === "missing") {
    return { status: "missing", side: "all", reason: leg.all.reason, runs: leg.all.runs };
  }
  const trainS = quantileOf(leg.train, quantile);
  const allS = quantileOf(leg.all, quantile);
  const differenceMinutes = (trainS - allS) / 60;
  return {
    status: "known",
    trainS,
    allS,
    differenceMinutes,
    gain: gainClass(differenceMinutes),
    curtainMinutes: Math.min(CURTAIN_CAP_MINUTES, curtainMinutes(trainS)),
  };
}
