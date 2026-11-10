import { describe, expect, it } from "vitest";
import { uuidv7 } from "./uuid.ts";

describe("uuidv7", () => {
  it("encodes the time in the first 48 bits with version 7 and the RFC variant", () => {
    const id = uuidv7(Date.parse("2026-10-25T09:00:00Z"), new Uint8Array(10).fill(0xff));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16)).toBe(
      Date.parse("2026-10-25T09:00:00Z"),
    );
  });

  it("orders ids by time", () => {
    const a = uuidv7(1_000);
    const b = uuidv7(2_000);
    expect(a < b).toBe(true);
  });
});
