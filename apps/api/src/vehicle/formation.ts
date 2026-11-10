import { createHash } from "node:crypto";
import { z } from "zod";

/** The part of a bahn.de vehicle-sequence answer the identity reads; other fields pass unchecked. */
export const VehicleSequenceAnswer = z.looseObject({
  sequenceStatus: z.string().optional(),
  groups: z.array(
    z.looseObject({
      name: z.string(),
      transport: z.looseObject({ category: z.string().optional() }).optional(),
      vehicles: z.array(
        z.looseObject({
          vehicleID: z.string(),
          type: z.looseObject({ category: z.string().optional() }).optional(),
          platformPosition: z.looseObject({ start: z.number(), end: z.number() }).optional(),
        }),
      ),
    }),
  ),
});

export type VehicleSequenceAnswer = z.infer<typeof VehicleSequenceAnswer>;

export interface FormationReading {
  readonly seriesId: string;
  readonly units: number;
  readonly cars: number;
  readonly lengthMetres: number | null;
  readonly unitNames: readonly string[];
  readonly sequenceStatus: string | null;
}

const UIC_DIGITS = 12;
const DOUBLE_DECK = "DOUBLEDECK";
const INTERCITY_2 = "db-intercity-2";
const IC2_LOCOMOTIVES: ReadonlySet<string> = new Set(["db-146-5", "db-147"]);

/**
 * The series numbers a 12-digit UIC vehicle number stands for under DB's scheme: a high-speed
 * multiple-unit car (type 93) by the last three digits of its series block, and only its powered
 * family (4xx, control and middle cars carry 8xx and 9xx); a locomotive (type 91, 92) by its
 * three-digit series, with 146.5 when the serial starts with 5; a regional multiple unit (type 94,
 * 95) by its whole series block (0442 is 442, 1440 stays 1440). Coaches name no series.
 */
export function seriesNumbersOf(vehicleId: string): readonly string[] {
  const digits = vehicleId.replace(/\D/g, "");
  if (digits.length !== UIC_DIGITS) return [];
  const type = digits.slice(0, 2);
  const block = digits.slice(4, 8);
  if (type === "93") {
    const family = block.slice(1);
    return family.startsWith("4") ? [family] : [];
  }
  if (type === "91" || type === "92") {
    const family = block.slice(1);
    return digits[8] === "5" ? [`${family}.5`, family] : [family];
  }
  if (type === "94" || type === "95") return [String(Number(block))];
  return [];
}

/** Series id by series number from the catalogue's `br` field ("427, 428, 429" names three). */
export function seriesByNumber(
  rows: readonly { readonly seriesId: string; readonly br: string | null }[],
): ReadonlyMap<string, string> {
  const single = new Map<string, string>();
  const shared = new Map<string, string>();
  for (const row of rows) {
    const numbers = (row.br ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => /^\d{3,4}(\.\d)?$/.test(part));
    for (const number of numbers) {
      const target = numbers.length === 1 ? single : shared;
      if (!target.has(number)) target.set(number, row.seriesId);
    }
  }
  return new Map([...shared, ...single]);
}

function mostCommon(values: readonly string[]): string | null {
  const counts = new Map<string, number>();
  let best: string | null = null;
  let bestCount = 0;
  for (const value of values) {
    const count = (counts.get(value) ?? 0) + 1;
    counts.set(value, count);
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

type Group = VehicleSequenceAnswer["groups"][number];

function groupSeries(group: Group, series: ReadonlyMap<string, string>): string | null {
  const found: string[] = [];
  for (const vehicle of group.vehicles) {
    const id = seriesNumbersOf(vehicle.vehicleID)
      .map((number) => series.get(number))
      .find((value) => value !== undefined);
    if (id) found.push(id);
  }
  const doubleDeck = group.vehicles.some((v) => v.type?.category?.includes(DOUBLE_DECK));
  if (
    doubleDeck &&
    group.transport?.category === "IC" &&
    found.some((id) => IC2_LOCOMOTIVES.has(id))
  ) {
    return INTERCITY_2;
  }
  return mostCommon(found);
}

function measuredLength(groups: readonly Group[]): number | null {
  const positions = groups.flatMap((group) => group.vehicles.map((v) => v.platformPosition));
  if (positions.length === 0 || positions.some((p) => p === undefined)) return null;
  const starts = positions.map((p) => p?.start ?? 0);
  const ends = positions.map((p) => p?.end ?? 0);
  const length = Math.max(...ends) - Math.min(...starts);
  return length > 0 ? Math.round(length * 10) / 10 : null;
}

/**
 * The formation a vehicle-sequence answer describes: the series most of its units belong to, how
 * many units of it run, all cars, the length measured along the platform, and the unit names. Null
 * when no vehicle number maps to a catalogue series.
 */
export function readFormation(
  answer: VehicleSequenceAnswer,
  series: ReadonlyMap<string, string>,
): FormationReading | null {
  const perGroup = answer.groups.map((group) => groupSeries(group, series));
  const seriesId = mostCommon(perGroup.filter((id): id is string => id !== null));
  if (seriesId === null) return null;
  return {
    seriesId,
    units: perGroup.filter((id) => id === seriesId).length,
    cars: answer.groups.reduce((sum, group) => sum + group.vehicles.length, 0),
    lengthMetres: measuredLength(answer.groups),
    unitNames: answer.groups.map((group) => group.name).filter((name) => name.trim() !== ""),
    sequenceStatus: answer.sequenceStatus ?? null,
  };
}

export function sha256Hex(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}
