import { create } from "zustand";
import { usePanelStore } from "../state/panel-store.ts";
import type { AreaKind, StatsArea } from "./area.ts";
import type { PeriodChoice } from "./periods.ts";

export interface StatsState {
  /** The tab picked in the area selector; `area` follows once it is complete. */
  readonly kind: AreaKind;
  /** The area on show, null while the picked kind still waits for its station, line or train. */
  readonly area: StatsArea | null;
  readonly period: PeriodChoice;
  readonly tables: boolean;
  /** Opens or closes the panel through the shell's active-panel field. */
  setOpen(open: boolean): void;
  setKind(kind: AreaKind): void;
  setArea(area: StatsArea): void;
  setPeriod(period: PeriodChoice): void;
  setTables(tables: boolean): void;
}

type StateFields = Pick<StatsState, "kind" | "area" | "period" | "tables">;

export function initialStatsState(): StateFields {
  return {
    kind: "network",
    area: { kind: "network" },
    period: { kind: "today" },
    tables: false,
  };
}

export const useStatsStore = create<StatsState>()((set, get) => ({
  ...initialStatsState(),
  setOpen: (open) => {
    const panels = usePanelStore.getState();
    if (open) panels.open("stats");
    else panels.close("stats");
  },
  setKind: (kind) => {
    const held = get().area;
    set({
      kind,
      area: kind === "network" ? { kind } : held?.kind === kind ? held : null,
    });
  },
  setArea: (area) => set({ kind: area.kind, area }),
  setPeriod: (period) => set({ period }),
  setTables: (tables) => set({ tables }),
}));

const holds = (state: { active: string | null; returnTo: string | null }) =>
  state.active === "stats" || state.returnTo === "stats";

/** A Land left standing would bring its focus back when the panel opens again, so leaving the slot for good forgets it. */
usePanelStore.subscribe((next, previous) => {
  if (!holds(previous) || holds(next)) return;
  const { area } = useStatsStore.getState();
  if (area?.kind === "land") useStatsStore.setState({ kind: "network", area: { kind: "network" } });
});
