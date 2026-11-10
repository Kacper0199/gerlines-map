// @vitest-environment happy-dom
import { changeLocale } from "@gerlines/i18n";
import type { SearchResponse, SearchResult } from "@gerlines/schema/search";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axeViolations } from "../../test/helpers/axe.ts";
import { SearchBox } from "../search/SearchBox.tsx";
import { resetPlaceStore } from "../state/place-store.ts";
import { initialState, useAppStore } from "../state/store.ts";

const STATION: SearchResult = {
  kind: "station",
  id: "4eda9b92-2ddf-5610-b59b-ed665a8b2610",
  name: "Köln Hbf",
  lon: 6.958729,
  lat: 50.94303,
  eva: 8000207,
  dhid: "de:05315:11201",
  lines: ["RE1", "S11"],
  trainsToday: 1207,
};
const LAND: SearchResult = {
  kind: "place",
  id: "land:DE-BY",
  type: "land",
  name: "Bavaria",
  region: null,
  landCode: "DE-BY",
  lon: 11.8,
  lat: 48.7,
  bbox: [8.97, 47.27, 13.84, 50.56],
};

function answering(results: readonly SearchResult[], status = 200) {
  const body: SearchResponse = {
    query: "x",
    serviceDate: "2026-11-07",
    timetableVersion: "1",
    results: [...results],
  };
  return vi.fn(async (_url: string) => new Response(JSON.stringify(body), { status }));
}

beforeEach(async () => {
  await changeLocale("en");
  useAppStore.setState(initialState());
  resetPlaceStore();
});
afterEach(cleanup);

describe("search field", () => {
  it("is a search landmark holding the combobox", () => {
    const { container } = render(<SearchBox placeholder="Search" fetch={answering([])} />);
    const landmark = container.querySelector("search");
    expect(landmark?.getAttribute("aria-label")).toBe("Search");
    expect(landmark?.contains(screen.getByRole("combobox"))).toBe(true);
  });

  it("announces how many results came back, once", async () => {
    const user = userEvent.setup();
    render(<SearchBox placeholder="Search" fetch={answering([STATION, LAND])} />);
    await user.type(screen.getByRole("combobox"), "köln");
    await waitFor(() => expect(screen.getByText("2 results")).toBeTruthy());
    expect(screen.getAllByText("2 results")).toHaveLength(1);
  });

  it("retries a failed search with Enter, which the retry button cannot offer to the keyboard", async () => {
    const user = userEvent.setup();
    const failing = answering([], 503);
    render(<SearchBox placeholder="Search" fetch={failing} />);
    await user.type(screen.getByRole("combobox"), "xy");
    await screen.findByRole("button", { name: "Try again" });
    expect(screen.getByText("Press Enter to try again.")).toBeTruthy();
    const calls = failing.mock.calls.length;
    await user.keyboard("{Enter}");
    await waitFor(() => expect(failing.mock.calls.length).toBeGreaterThan(calls));
  });

  it("has no axe violations with results, with no match and after an error", async () => {
    const user = userEvent.setup();
    const { container, unmount } = render(
      <SearchBox placeholder="Search" fetch={answering([STATION, LAND])} />,
    );
    await user.type(screen.getByRole("combobox"), "köln");
    await screen.findAllByRole("option");
    expect(await axeViolations(container)).toEqual([]);
    unmount();
    const failed = render(<SearchBox placeholder="Search" fetch={answering([], 503)} />);
    await user.type(screen.getByRole("combobox"), "xy");
    await screen.findByRole("button", { name: "Try again" });
    expect(await axeViolations(failed.container)).toEqual([]);
  });
});
