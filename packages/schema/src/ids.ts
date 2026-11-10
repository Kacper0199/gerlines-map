import { createHash } from "node:crypto";

/** The GerLines namespace of canonical UUIDv5 ids (D-025, `pipelines/static_import` `ids.py`). */
export const GERLINES_NAMESPACE = "5d1b7a4e-2f4c-5a8e-9c63-0b8f1e6d2a71";

const namespaceBytes = Buffer.from(GERLINES_NAMESPACE.replaceAll("-", ""), "hex");

/** RFC 9562 UUIDv5 of a UTF-8 name, equal to Python's `uuid.uuid5`. */
export function uuidv5(name: string, namespace: Buffer = namespaceBytes): string {
  const hash = createHash("sha1").update(namespace).update(name, "utf8").digest();
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function normalizeTrainNumber(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return null;
  if (/^\d+$/.test(trimmed)) return trimmed.replace(/^0+(?=\d)/, "");
  return trimmed;
}

export interface TripInstanceKey {
  readonly serviceDate: string;
  readonly operatorId: string | null;
  readonly trainNumber: string | null;
  readonly originStopPlaceId: string;
  readonly originDeparture: number;
}

/** UUIDv5 of one real run (architecture §4): service date, operator, train number, origin, departure. */
export function tripInstanceId(key: TripInstanceKey): string {
  const parts = [
    key.serviceDate,
    key.operatorId ?? "",
    key.trainNumber ?? "",
    key.originStopPlaceId,
    new Date(key.originDeparture).toISOString(),
  ];
  return uuidv5(`trip_instance:${parts.join("\x1f")}`);
}
