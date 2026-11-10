import { describe, expect, it } from "vitest";
import { gated, readGate, StatsBusyError } from "./reads.ts";

describe("readGate", () => {
  it("counts each read by the queries it runs at once", () => {
    const gate = readGate(6);
    expect(gate.tryEnter(4)).toBe(true);
    expect(gate.tryEnter(3)).toBe(false);
    expect(gate.tryEnter(2)).toBe(true);
    expect(gate.inFlight()).toBe(6);
    gate.leave(4);
    expect(gate.inFlight()).toBe(2);
    expect(gate.tryEnter(3)).toBe(true);
  });

  it("lets a read heavier than the gate run alone", () => {
    const gate = readGate(2);
    expect(gate.tryEnter(5)).toBe(true);
    expect(gate.inFlight()).toBe(2);
    expect(gate.tryEnter()).toBe(false);
    gate.leave(5);
    expect(gate.inFlight()).toBe(0);
  });

  it("gives the queries of a read back when it fails or the gate is full", async () => {
    const gate = readGate(6);
    await expect(gated(gate, () => Promise.reject(new Error("timeout")), 6)).rejects.toThrow(
      "timeout",
    );
    expect(gate.inFlight()).toBe(0);
    gate.tryEnter(4);
    await expect(gated(gate, async () => 1, 3)).rejects.toBeInstanceOf(StatsBusyError);
    expect(gate.inFlight()).toBe(4);
    expect(await gated(gate, async () => 1, 2)).toBe(1);
    expect(gate.inFlight()).toBe(4);
  });
});
