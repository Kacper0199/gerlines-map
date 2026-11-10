import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { shapeFaults, uTurnsOffStop } from "./packs.ts";

interface GateCase {
  name: string;
  x: number[];
  y: number[];
  s: number[];
  stop_arcs: number[];
  u_turns: [number, number][];
  hairpins: number;
}

const { cases } = JSON.parse(
  readFileSync(new URL("./gate-vectors.json", import.meta.url), "utf8"),
) as { cases: GateCase[] };

describe("the pack gate vectors shared with pipelines/rail_graph spurs.py", () => {
  it.each(cases)("$name", ({ x, y, s, stop_arcs, u_turns, hairpins }) => {
    expect(uTurnsOffStop(x, y, s, stop_arcs).map((t) => [t.from, t.to])).toEqual(u_turns);
    expect(shapeFaults(x, y, s, stop_arcs).hairpins).toBe(hairpins);
  });
});
