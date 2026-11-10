import type { StatsLandCode } from "@gerlines/schema/stats";

export type StatsArea =
  | { readonly kind: "network" }
  | { readonly kind: "land"; readonly code: StatsLandCode }
  | { readonly kind: "station"; readonly id: string; readonly name: string }
  | { readonly kind: "line"; readonly name: string }
  | { readonly kind: "train"; readonly number: string };

export type AreaKind = StatsArea["kind"];

export const AREA_KINDS: readonly AreaKind[] = ["network", "land", "station", "line", "train"];

export function sameArea(a: StatsArea, b: StatsArea): boolean {
  switch (a.kind) {
    case "network":
      return b.kind === "network";
    case "land":
      return b.kind === "land" && a.code === b.code;
    case "station":
      return b.kind === "station" && a.id === b.id;
    case "line":
      return b.kind === "line" && a.name === b.name;
    case "train":
      return b.kind === "train" && a.number === b.number;
  }
}
