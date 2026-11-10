export class DbJsonError extends Error {}

export interface StadaEva {
  readonly eva: number;
  readonly isMain: boolean;
  readonly lon: number | null;
  readonly lat: number | null;
}

export interface StadaRil100 {
  readonly ril100: string;
  readonly isMain: boolean;
  readonly primaryLocationCode: string | null;
}

export type SteplessAccess = "yes" | "no" | "partial";

/** A StaDa station reduced to what enriches a `stop_place`. */
export interface StadaStation {
  readonly stationNumber: number;
  readonly name: string;
  readonly ifopt: string | null;
  readonly category: number | null;
  readonly priceCategory: number | null;
  readonly federalState: string | null;
  readonly federalStateCode: string | null;
  readonly countryCode: string | null;
  readonly municipalityCode: string | null;
  readonly mainEva: number | null;
  readonly evaNumbers: readonly StadaEva[];
  readonly mainRil100: string | null;
  readonly ril100Identifiers: readonly StadaRil100[];
  readonly steplessAccess: SteplessAccess | null;
  readonly productLine: string | null;
  readonly aufgabentraeger: string | null;
  readonly localizedNames: Readonly<Record<string, string>>;
}

export interface StadaList {
  readonly total: number;
  readonly stations: readonly StadaStation[];
}

type Json = Readonly<Record<string, unknown>>;

export function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function optionalString(record: Json, key: string): string | null {
  const value = record[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new DbJsonError(`${key} is not a string`);
  return value;
}

export function optionalNumber(record: Json, key: string): number | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new DbJsonError(`${key} is not a number`);
  }
  return value;
}

function point(value: unknown): { lon: number | null; lat: number | null } {
  if (!isObject(value) || !Array.isArray(value.coordinates)) return { lon: null, lat: null };
  const [lon, lat] = value.coordinates as unknown[];
  return typeof lon === "number" && typeof lat === "number"
    ? { lon, lat }
    : { lon: null, lat: null };
}

function list(record: Json, key: string): Json[] {
  const value = record[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every(isObject)) {
    throw new DbJsonError(`${key} is not a list of objects`);
  }
  return value;
}

function evaNumber(entry: Json): StadaEva {
  const eva = optionalNumber(entry, "number");
  if (eva === null || !Number.isInteger(eva)) throw new DbJsonError("EVA entry without number");
  return { eva, isMain: entry.isMain === true, ...point(entry.geographicCoordinates) };
}

function ril100(entry: Json): StadaRil100 {
  const id = optionalString(entry, "rilIdentifier");
  if (id === null) throw new DbJsonError("RIL100 entry without identifier");
  return {
    ril100: id,
    isMain: entry.isMain === true,
    primaryLocationCode: optionalString(entry, "primaryLocationCode"),
  };
}

function steplessAccess(record: Json): SteplessAccess | null {
  const value = optionalString(record, "hasSteplessAccess");
  if (value === null) return null;
  if (value === "yes" || value === "no" || value === "partial") return value;
  throw new DbJsonError(`unknown hasSteplessAccess ${value}`);
}

function localizedNames(record: Json): Record<string, string> {
  const value = record.localizedNames;
  if (!isObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function nested(record: Json, key: string, field: string): string | null {
  const value = record[key];
  return isObject(value) ? optionalString(value, field) : null;
}

export function parseStadaStation(record: Json): StadaStation {
  const stationNumber = optionalNumber(record, "number");
  const name = optionalString(record, "name");
  if (stationNumber === null || name === null)
    throw new DbJsonError("station without number or name");
  const evaNumbers = list(record, "evaNumbers").map(evaNumber);
  const ril100Identifiers = list(record, "ril100Identifiers").map(ril100);
  return {
    stationNumber,
    name,
    ifopt: optionalString(record, "ifopt"),
    category: optionalNumber(record, "category"),
    priceCategory: optionalNumber(record, "priceCategory"),
    federalState: optionalString(record, "federalState"),
    federalStateCode: optionalString(record, "federalStateCode"),
    countryCode: optionalString(record, "countryCode"),
    municipalityCode: optionalString(record, "municipalityCode"),
    mainEva: evaNumbers.find((entry) => entry.isMain)?.eva ?? null,
    evaNumbers,
    mainRil100: ril100Identifiers.find((entry) => entry.isMain)?.ril100 ?? null,
    ril100Identifiers,
    steplessAccess: steplessAccess(record),
    productLine: nested(record, "productLine", "productLine"),
    aufgabentraeger: nested(record, "aufgabentraeger", "shortName"),
    localizedNames: localizedNames(record),
  };
}

/** The StaDa `/stations` answer; refuses a page that does not hold every station it counts. */
export function parseStadaStations(payload: string | Buffer): StadaList {
  const body: unknown = JSON.parse(
    typeof payload === "string" ? payload : payload.toString("utf8"),
  );
  if (!isObject(body) || !Array.isArray(body.result)) {
    throw new DbJsonError("StaDa answer has no result list");
  }
  const total = optionalNumber(body, "total");
  const stations = body.result.map((entry: unknown) => {
    if (!isObject(entry)) throw new DbJsonError("station is not an object");
    return parseStadaStation(entry);
  });
  if (total !== null && optionalNumber(body, "offset") === 0 && total !== stations.length) {
    throw new DbJsonError(`StaDa page holds ${stations.length} of ${total} stations`);
  }
  return { total: total ?? stations.length, stations };
}
