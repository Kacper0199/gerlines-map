// @vitest-environment happy-dom
import { changeLocale } from "@gerlines/i18n";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPanelStore, usePanelStore } from "../state/panel-store.ts";
import { resetPlaceStore, usePlaceStore } from "../state/place-store.ts";
import { initialState, useAppStore } from "../state/store.ts";
import network from "./fixtures/network-2025-11.json" with { type: "json" };
import { StatsButton, StatsSlot } from "./StatsEntry.tsx";
import { initialStatsState, useStatsStore } from "./store.ts";

vi.mock("./use-laender.ts", () => ({ useLaender: () => [] }));

beforeEach(async () => {
  await changeLocale("en");
  useAppStore.setState(initialState());
  resetPlaceStore();
  resetPanelStore();
  useStatsStore.setState({
    ...initialStatsState(),
    period: { kind: "month", year: 2025, month: 11 },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(network), { status: 200 })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("StatsButton", () => {
  it("opens the statistics and reports its state to assistive technology", async () => {
    const user = userEvent.setup();
    render(<StatsButton />);
    const button = screen.getByRole("button", { name: "Statistics" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    await user.click(button);
    expect(usePanelStore.getState().active === "stats").toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    await user.click(button);
    expect(usePanelStore.getState().active === "stats").toBe(false);
  });

  it("takes the card slot from a selected train or station", async () => {
    useAppStore.getState().select("4eda9b92-2ddf-5610-b59b-ed665a8b2610");
    usePlaceStore.getState().selectStation({
      id: "7caf6c52-407d-3f0f-ae57-e324480e9bf3",
      name: "Nürnberg Hbf",
      lon: 11.08,
      lat: 49.45,
      eva: 8000284,
      dhid: null,
      lines: [],
      trainsToday: 10,
    });
    const user = userEvent.setup();
    render(<StatsButton />);
    await user.click(screen.getByRole("button", { name: "Statistics" }));
    expect(useAppStore.getState().selectedId).toBeNull();
    expect(usePlaceStore.getState().station).toBeNull();
    expect(useStatsStore.getState().area).toEqual({
      kind: "station",
      id: "7caf6c52-407d-3f0f-ae57-e324480e9bf3",
      name: "Nürnberg Hbf",
    });
  });
});

describe("StatsSlot", () => {
  it("loads the panel on demand", async () => {
    render(<StatsSlot phone={false} />);
    expect(await screen.findByRole("article", { name: "Statistics" })).toBeTruthy();
    expect(await screen.findByTestId("punctual6")).toBeTruthy();
  });
});
