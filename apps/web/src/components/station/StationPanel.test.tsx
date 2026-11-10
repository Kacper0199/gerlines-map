// @vitest-environment happy-dom
import { changeLocale } from "@gerlines/i18n";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPlaceStore, usePlaceStore } from "../../state/place-store.ts";
import { StationPanel } from "./StationPanel.tsx";

const LINES = ["RB24", "RB25", "RB26", "RB27", "RE1", "RE5", "RE6", "RE7", "S11", "S12"];

beforeEach(async () => {
  await changeLocale("en");
  resetPlaceStore();
  usePlaceStore.getState().selectStation({
    id: "4eda9b92-2ddf-5610-b59b-ed665a8b2610",
    name: "Köln Hbf",
    lon: 6.958729,
    lat: 50.94303,
    eva: 8000207,
    dhid: "de:05315:11201",
    lines: LINES,
    trainsToday: 1207,
  });
});
afterEach(cleanup);

describe("StationPanel", () => {
  it("shows the name, the trains of the day, the lines and the board as Soon", () => {
    render(<StationPanel phone={false} />);
    expect(screen.getByRole("heading", { level: 2, name: "Köln Hbf" })).toBeTruthy();
    expect(screen.getByText("1,207 trains today")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(LINES.length);
    expect(screen.getByText("Departures and arrivals")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Share station" })).toBeTruthy();
  });

  it("keeps the phone sheet short with the first lines and the count of the rest", () => {
    render(<StationPanel phone />);
    expect(screen.getAllByRole("listitem")).toHaveLength(9);
    expect(screen.getByText("+2")).toBeTruthy();
  });

  it("closes with the close button and with Escape", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<StationPanel phone={false} />);
    await user.click(screen.getByRole("button", { name: "Close station card" }));
    expect(usePlaceStore.getState().station).toBeNull();
    usePlaceStore.getState().selectStation({ ...LINES_STATION });
    rerender(<StationPanel phone={false} />);
    await user.keyboard("{Escape}");
    expect(usePlaceStore.getState().station).toBeNull();
  });
});

describe("StationPanel for a station that did not load", () => {
  beforeEach(() => resetPlaceStore());

  it("says a station that does not exist is not found, without Try again", () => {
    usePlaceStore.getState().markStationMissing(LINES_STATION.id, "not-found");
    render(<StationPanel phone={false} retry={vi.fn()} />);
    expect(screen.getByRole("heading", { level: 2, name: "Station not found" })).toBeTruthy();
    expect(screen.getByText("The link names a station that is not in the timetable.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("offers Try again when the station could not be loaded, and waits while it loads", async () => {
    const user = userEvent.setup();
    const retry = vi.fn((id: string) => usePlaceStore.getState().setPendingStation(id));
    usePlaceStore.getState().markStationMissing(LINES_STATION.id, "error");
    const { rerender } = render(<StationPanel phone retry={retry} />);
    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "Station details are not available right now",
      }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledWith(LINES_STATION.id);
    rerender(<StationPanel phone retry={retry} />);
    const waiting = screen.getByRole("button", { name: "Loading station" });
    expect(waiting.hasAttribute("disabled")).toBe(true);
  });

  it("closes the not found card with Escape", async () => {
    const user = userEvent.setup();
    usePlaceStore.getState().markStationMissing(LINES_STATION.id, "not-found");
    render(<StationPanel phone={false} retry={vi.fn()} />);
    await user.keyboard("{Escape}");
    expect(usePlaceStore.getState().missingStation).toBeNull();
  });
});

const LINES_STATION = {
  id: "4eda9b92-2ddf-5610-b59b-ed665a8b2610",
  name: "Köln Hbf",
  lon: 6.958729,
  lat: 50.94303,
  eva: 8000207,
  dhid: "de:05315:11201",
  lines: LINES,
  trainsToday: 1207,
};
