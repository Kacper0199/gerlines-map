import { beforeEach, describe, expect, it } from "vitest";
import { resetPanelStore, usePanelStore } from "../state/panel-store.ts";
import { initialStatsState, useStatsStore } from "./store.ts";

beforeEach(() => {
  resetPanelStore();
  useStatsStore.setState(initialStatsState());
});

describe("statistics store", () => {
  it("opens on Germany today", () => {
    const state = useStatsStore.getState();
    expect(usePanelStore.getState().active).toBeNull();
    expect(state.kind).toBe("network");
    expect(state.area).toEqual({ kind: "network" });
    expect(state.period).toEqual({ kind: "today" });
  });

  it("keeps a finished area when the same tab is picked again and waits when another tab is picked", () => {
    const { setArea, setKind } = useStatsStore.getState();
    setArea({ kind: "train", number: "596" });
    setKind("train");
    expect(useStatsStore.getState().area).toEqual({ kind: "train", number: "596" });
    setKind("station");
    expect(useStatsStore.getState().area).toBeNull();
    expect(useStatsStore.getState().kind).toBe("station");
    setKind("network");
    expect(useStatsStore.getState().area).toEqual({ kind: "network" });
  });

  it("shows Germany again after the panel closed on a Land, so a cleared focus is not brought back", () => {
    const { setArea, setOpen } = useStatsStore.getState();
    setOpen(true);
    setArea({ kind: "land", code: "DE-BY" });
    setOpen(false);
    expect(useStatsStore.getState().area).toEqual({ kind: "network" });
    expect(useStatsStore.getState().kind).toBe("network");
  });

  it("keeps a train, line or station across a close", () => {
    const { setArea, setOpen } = useStatsStore.getState();
    setArea({ kind: "line", name: "RE5" });
    setOpen(false);
    expect(useStatsStore.getState().area).toEqual({ kind: "line", name: "RE5" });
  });

  it("forgets a Land when another panel takes the slot, as when the panel is closed", () => {
    const { setArea, setOpen } = useStatsStore.getState();
    setOpen(true);
    setArea({ kind: "land", code: "DE-BY" });
    usePanelStore.getState().open("journeys");
    expect(useStatsStore.getState().area).toEqual({ kind: "network" });
  });

  it("is open exactly while the shell's active panel is the statistics", () => {
    const { setOpen } = useStatsStore.getState();
    setOpen(true);
    expect(usePanelStore.getState().active).toBe("stats");
    usePanelStore.getState().open("journeys");
    setOpen(false);
    expect(usePanelStore.getState().active).toBe("journeys");
    setOpen(true);
    expect(usePanelStore.getState().active).toBe("stats");
  });

  it("keeps a Land while a train card holds the slot and forgets it when another panel replaces the wait", () => {
    const { setArea, setOpen } = useStatsStore.getState();
    setOpen(true);
    setArea({ kind: "land", code: "DE-BY" });
    usePanelStore.getState().suspend();
    expect(useStatsStore.getState().area).toEqual({ kind: "land", code: "DE-BY" });
    usePanelStore.getState().resume();
    expect(useStatsStore.getState().area).toEqual({ kind: "land", code: "DE-BY" });
    usePanelStore.getState().suspend();
    usePanelStore.getState().open("journeys");
    expect(useStatsStore.getState().area).toEqual({ kind: "network" });
  });
});
