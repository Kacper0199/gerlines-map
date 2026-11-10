// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  leftSlotOpen,
  panelHoldsLeftSlot,
  usePanelCardSwitch,
  watchLeftSlot,
} from "./panel-cards.ts";
import { resetPanelStore, usePanelStore } from "./panel-store.ts";
import { resetPlaceStore, usePlaceStore } from "./place-store.ts";
import { initialState, useAppStore } from "./store.ts";

const TRAIN = "4eda9b92-2ddf-5610-b59b-ed665a8b2610";
const STATION = {
  id: "7caf6c52-407d-3f0f-ae57-e324480e9bf3",
  name: "Nürnberg Hbf",
  lon: 11.08,
  lat: 49.45,
  eva: 8000284,
  dhid: null,
  lines: [],
  trainsToday: 10,
};

beforeEach(() => {
  useAppStore.setState(initialState());
  resetPlaceStore();
  resetPanelStore();
});
afterEach(cleanup);

describe("usePanelCardSwitch", () => {
  it("steps the open panel aside for a train and brings it back when the train is deselected", () => {
    renderHook(() => usePanelCardSwitch());
    act(() => usePanelStore.getState().open("stats"));
    act(() => useAppStore.getState().select(TRAIN));
    expect(usePanelStore.getState()).toMatchObject({ active: null, returnTo: "stats" });
    act(() => useAppStore.getState().select(null));
    expect(usePanelStore.getState()).toMatchObject({ active: "stats", returnTo: null });
  });

  it("does the same for a station", () => {
    renderHook(() => usePanelCardSwitch());
    act(() => usePanelStore.getState().open("journeys"));
    act(() => usePlaceStore.getState().selectStation(STATION));
    expect(usePanelStore.getState().active).toBeNull();
    act(() => usePlaceStore.getState().selectStation(null));
    expect(usePanelStore.getState().active).toBe("journeys");
  });

  it("keeps the panel waiting while the selection moves from one card to another", () => {
    renderHook(() => usePanelCardSwitch());
    act(() => usePanelStore.getState().open("stats"));
    act(() => useAppStore.getState().select(TRAIN));
    act(() => usePlaceStore.getState().selectStation(STATION));
    act(() => useAppStore.getState().select(null));
    expect(usePanelStore.getState().active).toBeNull();
    act(() => usePlaceStore.getState().selectStation(null));
    expect(usePanelStore.getState().active).toBe("stats");
  });

  it("leaves an open panel alone when the selection is cleared and nothing was selected", () => {
    renderHook(() => usePanelCardSwitch());
    act(() => usePanelStore.getState().open("stats"));
    act(() => useAppStore.getState().select(null));
    expect(usePanelStore.getState().active).toBe("stats");
  });

  it("stops listening when unmounted", () => {
    const view = renderHook(() => usePanelCardSwitch());
    view.unmount();
    act(() => usePanelStore.getState().open("stats"));
    act(() => useAppStore.getState().select(TRAIN));
    expect(usePanelStore.getState().active).toBe("stats");
  });
});

describe("leftSlotOpen", () => {
  it("is false while the slot is empty", () => {
    expect(leftSlotOpen()).toBe(false);
  });

  it("is true for statistics, the planner, a station card and a station that is missing from the data", () => {
    act(() => usePanelStore.getState().open("stats"));
    expect(leftSlotOpen()).toBe(true);
    act(() => usePanelStore.getState().open("journeys"));
    expect(leftSlotOpen()).toBe(true);
    act(() => usePanelStore.getState().close("journeys"));
    expect(leftSlotOpen()).toBe(false);
    act(() => usePlaceStore.getState().selectStation(STATION));
    expect(leftSlotOpen()).toBe(true);
  });

  it("stays true for a panel that waits behind a train card, which holds the slot itself", () => {
    renderHook(() => usePanelCardSwitch());
    act(() => usePanelStore.getState().open("stats"));
    act(() => useAppStore.getState().select(TRAIN));
    expect(leftSlotOpen()).toBe(true);
  });
});

describe("watchLeftSlot", () => {
  it("reports a panel opening and closing, with the panel alone holding the slot", () => {
    const seen: Array<[boolean, boolean]> = [];
    const stop = watchLeftSlot((open, panelOnly) => seen.push([open, panelOnly]));
    usePanelStore.getState().open("stats");
    usePanelStore.getState().close("stats");
    stop();
    expect(seen).toEqual([
      [true, true],
      [false, false],
    ]);
  });

  it("reports a train card as a card, not as a panel", () => {
    const seen: Array<[boolean, boolean]> = [];
    const stop = watchLeftSlot((open, panelOnly) => seen.push([open, panelOnly]));
    useAppStore.getState().select(TRAIN);
    stop();
    expect(seen).toEqual([[true, false]]);
    expect(panelHoldsLeftSlot()).toBe(false);
  });

  it("stays quiet while the slot stays open under a change of occupant", () => {
    usePanelStore.getState().open("stats");
    const seen: boolean[] = [];
    const stop = watchLeftSlot((open) => seen.push(open));
    usePanelStore.getState().open("journeys");
    stop();
    expect(seen).toEqual([]);
  });
});
