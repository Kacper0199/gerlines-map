import { describe, expect, it } from "vitest";
import {
  isLabelMode,
  LABEL_MIN_ZOOM,
  LABEL_MODES,
  labelOf,
  readLabelMode,
  writeLabelMode,
} from "./label-mode.ts";

const trip = (overrides: Partial<Parameters<typeof labelOf>[1]> = {}) => ({
  line: "RE 1",
  trainNumber: 4711,
  delay: 0,
  realtime: true,
  foreign: false,
  ...overrides,
});

describe("labelOf", () => {
  it("shows nothing when labels are off", () => {
    expect(labelOf("off", trip())).toBe("");
  });

  it("shows the line, then the train number, then nothing", () => {
    expect(labelOf("line", trip())).toBe("RE 1");
    expect(labelOf("line", trip({ line: null }))).toBe("4711");
    expect(labelOf("line", trip({ line: null, trainNumber: null }))).toBe("");
  });

  it("shows the delay as whole minutes, cut off like the class boundaries, from 3 minutes on", () => {
    expect(labelOf("delay", trip({ delay: 179 }))).toBe("");
    expect(labelOf("delay", trip({ delay: 180 }))).toBe("+3");
    expect(labelOf("delay", trip({ delay: 359 }))).toBe("+5");
    expect(labelOf("delay", trip({ delay: 3600 }))).toBe("+60");
  });

  it("writes nothing for a train on time or early", () => {
    expect(labelOf("delay", trip({ delay: 0 }))).toBe("");
    expect(labelOf("delay", trip({ delay: -130 }))).toBe("");
  });

  it("shows no delay for a train without realtime data or a foreign one, never a made up value", () => {
    expect(labelOf("delay", trip({ realtime: false }))).toBe("");
    expect(labelOf("delay", trip({ delay: null }))).toBe("");
    expect(labelOf("delay", trip({ foreign: true, delay: 600 }))).toBe("");
  });
});

describe("label mode preference", () => {
  const storage = (initial: Record<string, string> = {}) => {
    const data = new Map(Object.entries(initial));
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    };
  };

  it("knows off, line and delay and defaults to off", () => {
    expect(LABEL_MODES).toEqual(["off", "line", "delay"]);
    expect(isLabelMode("line")).toBe(true);
    expect(isLabelMode("colour")).toBe(false);
    expect(readLabelMode(storage())).toBe("off");
    expect(readLabelMode(storage({ "gerlines.labelMode": "nonsense" }))).toBe("off");
  });

  it("round trips and survives a failing storage", () => {
    const store = storage();
    writeLabelMode("delay", store);
    expect(readLabelMode(store)).toBe("delay");
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readLabelMode(broken)).toBe("off");
    expect(() => writeLabelMode("line", broken)).not.toThrow();
  });

  it("starts showing labels at a zoom where the markers are chevrons", () => {
    expect(LABEL_MIN_ZOOM).toBeGreaterThanOrEqual(10);
  });
});
