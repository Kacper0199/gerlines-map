import { normalizeTrainNumber } from "./ids.ts";
import { addDays } from "./service-day.ts";
import type { TrainCategory, TrainDetail } from "./train-detail.ts";
import {
  LAYER_CONFIDENCE,
  MAJORITY_WINDOW_DAYS,
  type VehicleResolution,
} from "./vehicle-identity.ts";

export interface TrainKey {
  readonly serviceDate: string;
  readonly operatorId: string | null;
  readonly category: TrainCategory;
  readonly line: string | null;
  readonly trainNumber: string | null;
}

/** The fields a train's resolver key is built from: the instance's, then the timetable trip's. */
export interface TrainKeyFields {
  readonly serviceDate: string;
  readonly category: TrainCategory;
  readonly line: string | null;
  readonly instanceOperatorId: string | null;
  readonly tripOperatorId: string | null;
  readonly instanceTrainNumber: string | null;
  readonly tripShortName: string | null;
}

/** A catalogue operator's display name: its brand, else its name, a blank one as none. */
export function operatorNameOf(row: {
  readonly brandName: string | null;
  readonly name: string | null;
}): string | null {
  const brand = row.brandName?.trim() ?? "";
  if (brand !== "") return brand;
  const name = row.name?.trim() ?? "";
  return name === "" ? null : name;
}

/**
 * The operator a train runs under, as the train card names it: the instance's, else the trip's,
 * and none when the catalogue has no name for it.
 */
export function keyOperatorId(
  instanceOperatorId: string | null,
  tripOperatorId: string | null,
  named: (operatorId: string) => boolean,
): string | null {
  const id = instanceOperatorId ?? tripOperatorId;
  return id !== null && named(id) ? id : null;
}

/** The train number as the card shows it: the instance's, else the trip's short name, normalised. */
export function displayTrainNumber(
  instanceTrainNumber: string | null,
  tripShortName: string | null,
): string | null {
  return normalizeTrainNumber(instanceTrainNumber ?? tripShortName);
}

/** The train number layers L0 and L1 key on (formation_observation): one to six digits. */
export function resolverTrainNumber(trainNumber: string | null): string | null {
  return trainNumber !== null && /^\d{1,6}$/.test(trainNumber) ? trainNumber : null;
}

export function keyTrainNumber(
  instanceTrainNumber: string | null,
  tripShortName: string | null,
): string | null {
  return resolverTrainNumber(displayTrainNumber(instanceTrainNumber, tripShortName));
}

/** The resolver key of a planned train; the live engine and the train card build it the same way. */
export function trainKeyOf(
  fields: TrainKeyFields,
  named: (operatorId: string) => boolean,
): TrainKey {
  return {
    serviceDate: fields.serviceDate,
    operatorId: keyOperatorId(fields.instanceOperatorId, fields.tripOperatorId, named),
    category: fields.category,
    line: fields.line,
    trainNumber: keyTrainNumber(fields.instanceTrainNumber, fields.tripShortName),
  };
}

/** The resolver key of a train card, whose operator and number already follow `trainKeyOf`. */
export function trainKeyOfDetail(
  detail: Pick<TrainDetail, "serviceDate" | "category" | "line" | "operator" | "trainNumber">,
): TrainKey {
  return {
    serviceDate: detail.serviceDate,
    operatorId: detail.operator?.id ?? null,
    category: detail.category,
    line: detail.line,
    trainNumber: resolverTrainNumber(detail.trainNumber),
  };
}

export interface SeriesFacts {
  readonly seriesId: string;
  readonly name: string;
  /** The Baureihe number or numbers as the catalogue writes them ("422", "483, 484"); null where it has none. */
  readonly br?: string | null;
  readonly unitLengthMetres: number | null;
}

export interface FleetRuleRow {
  readonly ruleId: string;
  readonly scope: "line" | "operator" | "category";
  readonly operatorId: string | null;
  readonly categoryCode: string | null;
  readonly lineKeys: readonly string[];
  readonly seriesIds: readonly string[];
  readonly modelId: string | null;
  readonly modelName: string | null;
  readonly units: number | null;
  readonly fleetCount: number | null;
  readonly fleetTotal: number | null;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly sourceId: string;
}

/** An exact formation of this train on this service day (layer L0). */
export interface ExactFormation {
  readonly seriesId: string;
  readonly units: number | null;
  readonly cars: number | null;
  readonly lengthMetres: number | null;
  readonly sourceId: string;
}

/** The most frequent series of past exact formations of this train number (layer L1). */
export interface Majority {
  readonly seriesId: string;
  readonly units: number | null;
  readonly count: number;
  readonly total: number;
  readonly sourceId: string;
}

export interface ResolverData {
  readonly rules: readonly FleetRuleRow[];
  readonly series: ReadonlyMap<string, SeriesFacts>;
  readonly exact?: ExactFormation | null;
  readonly majority?: Majority | null;
}

/** One stored exact formation (table formation_observation), as layers L0 and L1 read it. */
export interface ObservedFormation {
  readonly serviceDate: string;
  readonly trainNumber: string;
  readonly operatorId: string | null;
  readonly seriesId: string;
  readonly units: number | null;
  readonly cars: number | null;
  readonly lengthMetres: number | null;
  readonly sourceId: string;
  /** Unix milliseconds. */
  readonly observedAt: number;
}

/** A fleet_rule row (migration 0086) as SQL returns it, dates as ISO text. */
export interface FleetRuleDbRow {
  readonly rule_id: string;
  readonly scope: FleetRuleRow["scope"];
  readonly operator_id: string | null;
  readonly category_code: string | null;
  readonly line_keys: string[];
  readonly series_ids: string[];
  readonly model_id: string | null;
  readonly model_name: string | null;
  readonly units: number | null;
  readonly fleet_count: number | null;
  readonly fleet_total: number | null;
  readonly valid_from: string | null;
  readonly valid_to: string | null;
  readonly source_id: string;
}

export function fleetRuleOf(row: FleetRuleDbRow): FleetRuleRow {
  return {
    ruleId: row.rule_id,
    scope: row.scope,
    operatorId: row.operator_id,
    categoryCode: row.category_code,
    lineKeys: row.line_keys,
    seriesIds: row.series_ids,
    modelId: row.model_id,
    modelName: row.model_name,
    units: row.units,
    fleetCount: row.fleet_count,
    fleetTotal: row.fleet_total,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    sourceId: row.source_id,
  };
}

/** A formation_observation row (migration 0085) as SQL returns it, the service date as ISO text. */
export interface ObservationDbRow {
  readonly service_date: string;
  readonly train_number: string;
  readonly operator_id: string | null;
  readonly series_id: string;
  readonly units: number | null;
  readonly cars: number | null;
  readonly length_m: number | null;
  readonly source_id: string;
  readonly observed_at: Date;
}

export function observedFormationOf(row: ObservationDbRow): ObservedFormation {
  return {
    serviceDate: row.service_date,
    trainNumber: row.train_number,
    operatorId: row.operator_id,
    seriesId: row.series_id,
    units: row.units,
    cars: row.cars,
    lengthMetres: row.length_m,
    sourceId: row.source_id,
    observedAt: row.observed_at.getTime(),
  };
}

/** The train whose observations are asked for; a known operator leaves out every other one. */
export interface FormationQuery {
  readonly serviceDate: string;
  readonly trainNumber: string;
  readonly operatorId: string | null;
}

function sameTrain(row: ObservedFormation, query: FormationQuery): boolean {
  return (
    row.trainNumber === query.trainNumber &&
    (query.operatorId === null || row.operatorId === query.operatorId)
  );
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Layer L0: the newest observation of the train on its service day. */
export function exactOf(
  rows: readonly ObservedFormation[],
  query: FormationQuery,
): ExactFormation | null {
  let newest: ObservedFormation | undefined;
  for (const row of rows) {
    if (row.serviceDate !== query.serviceDate || !sameTrain(row, query)) continue;
    if (!newest || row.observedAt > newest.observedAt) newest = row;
  }
  return newest
    ? {
        seriesId: newest.seriesId,
        units: newest.units,
        cars: newest.cars,
        lengthMetres: newest.lengthMetres,
        sourceId: newest.sourceId,
      }
    : null;
}

/** The most frequent known value, the smallest on a tie; null when none is known. */
function modeOf(values: readonly (number | null)[]): number | null {
  const counts = new Map<number, number>();
  for (const value of values) if (value !== null) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: number | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && value < best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Layer L1's input: the series observed most often for the train number in the
 * MAJORITY_WINDOW_DAYS before its service day (ties by series id), with the most frequent units of
 * that series and the total number of observations in the window.
 */
export function majorityOf(
  rows: readonly ObservedFormation[],
  query: FormationQuery,
): Majority | null {
  const from = addDays(query.serviceDate, -MAJORITY_WINDOW_DAYS);
  const bySeries = new Map<string, ObservedFormation[]>();
  let total = 0;
  for (const row of rows) {
    if (row.serviceDate < from || row.serviceDate >= query.serviceDate) continue;
    if (!sameTrain(row, query)) continue;
    total++;
    const group = bySeries.get(row.seriesId);
    if (group) group.push(row);
    else bySeries.set(row.seriesId, [row]);
  }
  let chosen: [string, ObservedFormation[]] | undefined;
  for (const entry of bySeries) {
    if (
      !chosen ||
      entry[1].length > chosen[1].length ||
      (entry[1].length === chosen[1].length && compareText(entry[0], chosen[0]) < 0)
    ) {
      chosen = entry;
    }
  }
  if (!chosen) return null;
  const [seriesId, group] = chosen;
  return {
    seriesId,
    units: modeOf(group.map((row) => row.units)),
    count: group.length,
    total,
    sourceId: group.map((row) => row.sourceId).sort(compareText)[0] as string,
  };
}

/** Lines compare in upper case without spaces, as the catalogue loader stores them. */
export function lineKey(line: string): string {
  return line.replace(/\s+/g, "").toUpperCase();
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function validOn(rule: FleetRuleRow, day: string): boolean {
  return (
    (rule.validFrom === null || rule.validFrom <= day) &&
    (rule.validTo === null || day <= rule.validTo)
  );
}

function matches(rule: FleetRuleRow, key: TrainKey): boolean {
  if (!validOn(rule, key.serviceDate)) return false;
  if (rule.categoryCode !== null && rule.categoryCode !== key.category) return false;
  if (rule.scope === "category") return true;
  if (rule.operatorId !== key.operatorId) return false;
  if (rule.scope === "operator") return true;
  return key.line !== null && rule.lineKeys.includes(lineKey(key.line));
}

function lengthOf(series: SeriesFacts | undefined, units: number | null): number | null {
  if (!series?.unitLengthMetres || units === null) return null;
  return round(series.unitLengthMetres * units);
}

function identity(
  seriesId: string,
  data: ResolverData,
  fields: Omit<VehicleResolution, "seriesId" | "seriesName" | "br" | "variant" | "lengthMetres"> & {
    readonly lengthMetres?: number | null;
  },
): VehicleResolution | null {
  const series = data.series.get(seriesId);
  if (!series) return null;
  return {
    seriesId,
    seriesName: series.name,
    br: series.br ?? null,
    variant: null,
    ...fields,
    lengthMetres: fields.lengthMetres ?? lengthOf(series, fields.units),
  };
}

function fromExact(exact: ExactFormation, data: ResolverData): VehicleResolution | null {
  return identity(exact.seriesId, data, {
    units: exact.units,
    cars: exact.cars,
    lengthMetres: exact.lengthMetres,
    layer: "L0",
    confidence: LAYER_CONFIDENCE.L0,
    source: exact.sourceId,
    ruleId: null,
    alternatives: [],
  });
}

/** L1 answers only for a strict majority of at least two observations. */
function fromMajority(majority: Majority, data: ResolverData): VehicleResolution | null {
  const share = majority.count / majority.total;
  if (majority.total < 2 || share <= 0.5) return null;
  const { min, max, fullAfter } = LAYER_CONFIDENCE.L1;
  const weight = Math.min(majority.total, fullAfter) / fullAfter;
  return identity(majority.seriesId, data, {
    units: majority.units,
    cars: null,
    layer: "L1",
    confidence: round(min + (max - min) * share * weight),
    source: majority.sourceId,
    ruleId: null,
    alternatives: [],
  });
}

/**
 * L2: a rule naming one series answers with it. A rule allowing several series answers with the
 * operator's dominant series when it is among them, else with the first series the source lists,
 * at a confidence that falls with the number of series. That answer can sit below L3's confidence,
 * and still wins: L3's series is then one the cited line source excludes.
 */
function fromLine(
  rule: FleetRuleRow,
  dominant: string | null,
  data: ResolverData,
): VehicleResolution | null {
  const { single, dominant: dominantConfidence, floor, spread } = LAYER_CONFIDENCE.L2;
  const several = rule.seriesIds.length > 1;
  const chosen =
    several && dominant && rule.seriesIds.includes(dominant) ? dominant : rule.seriesIds[0];
  if (!chosen) return null;
  const confidence = !several
    ? single
    : chosen === dominant
      ? dominantConfidence
      : Math.max(floor, round(spread / rule.seriesIds.length));
  return identity(chosen, data, {
    units: rule.units,
    cars: null,
    layer: "L2",
    confidence,
    source: rule.sourceId,
    ruleId: rule.ruleId,
    alternatives: rule.seriesIds.filter((id) => id !== chosen),
  });
}

function fromOperator(rule: FleetRuleRow, data: ResolverData): VehicleResolution | null {
  const seriesId = rule.seriesIds[0];
  if (!seriesId || !rule.fleetCount || !rule.fleetTotal) return null;
  const { min, max } = LAYER_CONFIDENCE.L3;
  return identity(seriesId, data, {
    units: null,
    cars: null,
    layer: "L3",
    confidence: round(min + (max - min) * (rule.fleetCount / rule.fleetTotal)),
    source: rule.sourceId,
    ruleId: rule.ruleId,
    alternatives: [],
  });
}

function fromCategory(rule: FleetRuleRow): VehicleResolution | null {
  if (!rule.modelId || !rule.modelName) return null;
  return {
    seriesId: rule.modelId,
    seriesName: rule.modelName,
    br: null,
    variant: null,
    units: null,
    cars: null,
    lengthMetres: null,
    layer: "L4",
    confidence: LAYER_CONFIDENCE.L4,
    source: rule.sourceId,
    ruleId: rule.ruleId,
    alternatives: [],
  };
}

/** The most specific operator rule: one for the train's category before one for every category. */
function operatorRule(rules: readonly FleetRuleRow[]): FleetRuleRow | undefined {
  return rules.find((rule) => rule.categoryCode !== null) ?? rules[0];
}

/**
 * The vehicle identity of a train (ADR-0011): the exact formation of the day (L0), else the
 * majority of past exact formations (L1), the line rule (L2), the operator's dominant series (L3),
 * the generic model of the category (L4). Null only when no rule covers the category.
 */
export function resolveIdentity(key: TrainKey, data: ResolverData): VehicleResolution | null {
  const exact = data.exact ? fromExact(data.exact, data) : null;
  if (exact) return exact;
  const learned = data.majority ? fromMajority(data.majority, data) : null;
  if (learned) return learned;
  const applying = data.rules.filter((rule) => matches(rule, key));
  const operator = operatorRule(applying.filter((rule) => rule.scope === "operator"));
  const line = applying.find((rule) => rule.scope === "line");
  const fromRule = line ? fromLine(line, operator?.seriesIds[0] ?? null, data) : null;
  if (fromRule) return fromRule;
  const fromFleet = operator ? fromOperator(operator, data) : null;
  if (fromFleet) return fromFleet;
  const generic = applying.find((rule) => rule.scope === "category");
  return generic ? fromCategory(generic) : null;
}
