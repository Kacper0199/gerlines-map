import { randomBytes } from "node:crypto";

/** RFC 9562 UUIDv7 from an injected time, so ids are ordered like the PostgreSQL 18 `uuidv7()` default. */
export function uuidv7(epochMs: number, random: Uint8Array = randomBytes(10)): string {
  const bytes = new Uint8Array(16);
  let time = Math.floor(epochMs);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = time % 256;
    time = Math.floor(time / 256);
  }
  bytes.set(random.subarray(0, 10), 6);
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
