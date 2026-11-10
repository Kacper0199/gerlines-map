import { describe, expect, it } from "vitest";
import { atOf, formatAt, parseAt, writeAt } from "./playback-url.ts";

describe("playback url", () => {
  it("reads a UTC moment to the second", () => {
    expect(parseAt("2025-11-01T12:30:15Z")).toBe(Date.UTC(2025, 10, 1, 12, 30, 15) / 1000);
    expect(atOf("?lang=de&at=2025-11-01T12:30:15Z")).toBe(Date.UTC(2025, 10, 1, 12, 30, 15) / 1000);
  });

  it("refuses everything else", () => {
    for (const bad of [
      null,
      "",
      "1762000000",
      "2025-11-01T12:30:15",
      "2025-11-01T12:30:15+01:00",
      "2025-13-01T12:30:15Z",
      "2025-02-30T12:30:15Z",
      "2025-11-01T25:30:15Z",
      "2025-11-01T12:60:15Z",
      "2025-11-01T12:30:60Z",
    ]) {
      expect(parseAt(bad)).toBeNull();
    }
  });

  it("writes a moment next to the other parameters and takes it out again", () => {
    const at = Date.UTC(2025, 10, 1, 12, 30, 15) / 1000;
    expect(formatAt(at)).toBe("2025-11-01T12:30:15Z");
    expect(writeAt("?lang=de", at)).toBe("?lang=de&at=2025-11-01T12:30:15Z");
    expect(writeAt("?lang=de&at=2025-11-01T12:30:15Z", null)).toBe("?lang=de");
    expect(writeAt("?at=2025-11-01T12:30:15Z", null)).toBe("");
    expect(writeAt("", at)).toBe("?at=2025-11-01T12:30:15Z");
  });
});
