import { DbJsonError, isObject, optionalNumber, optionalString } from "./stada.ts";

export type FacilityType = "ELEVATOR" | "ESCALATOR";
export type FacilityState = "ACTIVE" | "INACTIVE" | "UNKNOWN";

export interface Facility {
  readonly equipmentNumber: number;
  readonly type: FacilityType;
  readonly state: FacilityState;
  readonly stateExplanation: string | null;
  readonly description: string | null;
  readonly stationNumber: number;
  readonly operatorName: string | null;
  readonly lon: number | null;
  readonly lat: number | null;
  readonly operationalResumeDate: string | null;
}

const TYPES = new Set<string>(["ELEVATOR", "ESCALATOR"]);
const STATES = new Set<string>(["ACTIVE", "INACTIVE", "UNKNOWN"]);

function oneOf<T extends string>(value: string | null, known: ReadonlySet<string>, key: string): T {
  if (value === null || !known.has(value)) throw new DbJsonError(`unknown ${key} ${value}`);
  return value as T;
}

export function parseFacility(record: Readonly<Record<string, unknown>>): Facility {
  const equipmentNumber = optionalNumber(record, "equipmentnumber");
  const stationNumber = optionalNumber(record, "stationnumber");
  if (equipmentNumber === null || stationNumber === null) {
    throw new DbJsonError("facility without equipment or station number");
  }
  const lon = optionalNumber(record, "geocoordX");
  const lat = optionalNumber(record, "geocoordY");
  return {
    equipmentNumber,
    type: oneOf<FacilityType>(optionalString(record, "type"), TYPES, "type"),
    state: oneOf<FacilityState>(optionalString(record, "state"), STATES, "state"),
    stateExplanation: optionalString(record, "stateExplanation"),
    description: optionalString(record, "description"),
    stationNumber,
    operatorName: optionalString(record, "operatorname"),
    lon: lon !== null && lat !== null ? lon : null,
    lat: lon !== null && lat !== null ? lat : null,
    operationalResumeDate: optionalString(record, "operationalResumeDate"),
  };
}

/** The FaSta `/facilities` answer: every lift and escalator with its current state. */
export function parseFacilities(payload: string | Buffer): Facility[] {
  const body: unknown = JSON.parse(
    typeof payload === "string" ? payload : payload.toString("utf8"),
  );
  if (!Array.isArray(body)) throw new DbJsonError("FaSta answer is not a list");
  return body.map((entry: unknown) => {
    if (!isObject(entry)) throw new DbJsonError("facility is not an object");
    return parseFacility(entry);
  });
}
