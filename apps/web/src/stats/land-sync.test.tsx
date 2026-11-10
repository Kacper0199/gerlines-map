// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialState, useAppStore } from "../state/store.ts";
import { useLandSync } from "./land-sync.ts";
import { initialStatsState, useStatsStore } from "./store.ts";

beforeEach(() => {
  useAppStore.setState(initialState());
  useStatsStore.setState(initialStatsState());
});
afterEach(cleanup);

describe("useLandSync", () => {
  it("focuses the Land on the map when the panel picks it", () => {
    renderHook(() => useLandSync());
    act(() => useStatsStore.getState().setArea({ kind: "land", code: "DE-BY" }));
    expect(useAppStore.getState().focusLand).toBe("DE-BY");
  });

  it("moves the panel to a Land focused elsewhere and back to Germany when the focus is cleared", () => {
    renderHook(() => useLandSync());
    act(() => useAppStore.getState().setFocusLand("DE-HH"));
    expect(useStatsStore.getState().area).toEqual({ kind: "land", code: "DE-HH" });
    act(() => useAppStore.getState().setFocusLand("DE-SN"));
    expect(useStatsStore.getState().area).toEqual({ kind: "land", code: "DE-SN" });
    expect(useAppStore.getState().focusLand).toBe("DE-SN");
    act(() => useAppStore.getState().setFocusLand(null));
    expect(useStatsStore.getState().area).toEqual({ kind: "network" });
  });

  it("clears the focus when the reader leaves the Land tab", () => {
    renderHook(() => useLandSync());
    act(() => useStatsStore.getState().setArea({ kind: "land", code: "DE-BY" }));
    act(() => useStatsStore.getState().setKind("station"));
    expect(useAppStore.getState().focusLand).toBeNull();
    expect(useStatsStore.getState().area).toBeNull();
  });

  it("changes the focus when the panel picks another Land", () => {
    renderHook(() => useLandSync());
    act(() => useStatsStore.getState().setArea({ kind: "land", code: "DE-BY" }));
    act(() => useStatsStore.getState().setArea({ kind: "land", code: "DE-NW" }));
    expect(useAppStore.getState().focusLand).toBe("DE-NW");
  });

  it("adopts the focused Land when the panel opens on it", () => {
    useAppStore.setState({ focusLand: "DE-HE" });
    renderHook(() => useLandSync());
    expect(useStatsStore.getState().area).toEqual({ kind: "land", code: "DE-HE" });
  });
});
