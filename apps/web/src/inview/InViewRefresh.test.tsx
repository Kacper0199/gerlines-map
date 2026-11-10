// @vitest-environment happy-dom
import { changeLocale } from "@gerlines/i18n";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataStatus, NearTrain } from "../motion/protocol.ts";
import { resetPanelStore, usePanelStore } from "../state/panel-store.ts";
import { initialState, useAppStore } from "../state/store.ts";
import InViewPanel, { MOVE_DEBOUNCE_MS, REFRESH_MS } from "./InViewPanel.tsx";
import { type NearestAnswer, resetInViewStore, useInViewStore } from "./store.ts";

function train(key: number): NearTrain {
  return {
    key,
    id: `live:${key}`,
    line: "RE 1",
    trainNumber: 4000 + key,
    category: "reg",
    foreign: false,
    delaySeconds: 0,
    lon: 8.01,
    lat: 50.01,
    distanceM: 1500,
  };
}

const answerOf = (trains: readonly NearTrain[]): NearestAnswer => ({
  centre: { lon: 8, lat: 50 },
  result: { inView: trains.length, trains },
});

const LIVE: DataStatus = {
  state: "live",
  dataTimeMs: Date.parse("2026-10-23T19:34:00Z"),
  trips: 2000,
  realtime: 1800,
  untracked: 0,
  counts: { hsr: 1, ld: 1, night: 0, rfast: 1, reg: 1, sbahn: 1, foreign: 1 },
  error: undefined,
};

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function pass(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  await changeLocale("en");
  useAppStore.setState({ ...initialState(), status: { ...LIVE, state: "loading", trips: 0 } });
  resetPanelStore();
  resetInViewStore();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("trains in view keeps up with the map", () => {
  it("fills by itself when the data arrives while the list is open and nothing moved", async () => {
    let trains: readonly NearTrain[] = [];
    useInViewStore.getState().attach(async () => answerOf(trains));
    render(<InViewPanel phone={false} />);
    await flush();
    expect(screen.getByText("No trains near the middle of the map.")).toBeTruthy();
    trains = [train(1), train(2)];
    act(() => useAppStore.setState({ status: LIVE }));
    await flush();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("asks again every so often while the focus is outside the list", async () => {
    const ask = vi.fn(async () => answerOf([train(1)]));
    useInViewStore.getState().attach(ask);
    render(<InViewPanel phone={false} />);
    await flush();
    const before = ask.mock.calls.length;
    await pass(REFRESH_MS + 100);
    expect(ask.mock.calls.length).toBeGreaterThan(before);
  });

  it("leaves the list alone while the focus is inside it, so rows do not move under the user", async () => {
    const ask = vi.fn(async () => answerOf([train(1), train(2)]));
    useInViewStore.getState().attach(ask);
    render(<InViewPanel phone={false} />);
    await flush();
    screen.getAllByRole("button", { name: /RE 1/ })[0]?.focus();
    const before = ask.mock.calls.length;
    await pass(REFRESH_MS * 3);
    expect(ask.mock.calls.length).toBe(before);
  });

  it("has an Update list button that asks at once, also with the focus in the list", async () => {
    const ask = vi.fn(async () => answerOf([train(1)]));
    useInViewStore.getState().attach(ask);
    render(<InViewPanel phone={false} />);
    await flush();
    const before = ask.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Update list" }));
    await flush();
    expect(ask.mock.calls.length).toBe(before + 1);
  });

  it("asks once after a burst of moves, a debounce of 300 ms", async () => {
    const ask = vi.fn(async () => answerOf([train(1)]));
    useInViewStore.getState().attach(ask);
    render(<InViewPanel phone={false} />);
    await flush();
    const before = ask.mock.calls.length;
    for (let i = 0; i < 6; i++) {
      act(() => useInViewStore.getState().userMoved());
      await pass(MOVE_DEBOUNCE_MS / 4);
    }
    expect(ask.mock.calls.length).toBe(before);
    await pass(MOVE_DEBOUNCE_MS + 50);
    expect(ask.mock.calls.length).toBe(before + 1);
  });

  it("says the list could not be loaded when there is no map, instead of looking forever", async () => {
    useInViewStore.getState().attach(async () => {
      throw new Error("no map");
    });
    render(<InViewPanel phone={false} />);
    await flush();
    expect(screen.queryByText("Looking for trains")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("The list of trains could not be loaded.");
  });
});

describe("closing the list on a phone", () => {
  it("returns the focus to the Layers button when the legend button that opened it is gone", async () => {
    useInViewStore.getState().attach(async () => answerOf([train(1)]));
    usePanelStore.getState().open("inview");
    render(
      <button type="button" data-slot="layers-button">
        Layers
      </button>,
    );
    const view = render(<InViewPanel phone />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Close the trains in view" }));
    view.unmount();
    await pass(50);
    expect(document.activeElement?.getAttribute("data-slot")).toBe("layers-button");
  });

  it("falls back to the map canvas when neither button exists", async () => {
    useInViewStore.getState().attach(async () => answerOf([train(1)]));
    usePanelStore.getState().open("inview");
    const canvas = document.createElement("canvas");
    canvas.className = "maplibregl-canvas";
    canvas.tabIndex = 0;
    document.body.append(canvas);
    const view = render(<InViewPanel phone />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Close the trains in view" }));
    view.unmount();
    await pass(50);
    expect(document.activeElement).toBe(canvas);
    canvas.remove();
  });
});
