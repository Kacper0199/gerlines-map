// @vitest-environment happy-dom
import { changeLocale } from "@gerlines/i18n";
import type { SearchResponse, SearchResult } from "@gerlines/schema/search";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useShortcutsStore } from "../a11y/shortcuts.ts";
import { resetPlaceStore, usePlaceStore } from "../state/place-store.ts";
import { initialState, useAppStore } from "../state/store.ts";
import { applyView } from "../url/apply-view.ts";
import { EMPTY_VIEW } from "../url/url-state.ts";
import { chooseResult, STATION_ZOOM } from "./choose.ts";
import { groupResults } from "./result-view.ts";
import { nextActive, SearchBox } from "./SearchBox.tsx";
import { fetchSearch, fetchStation, retryAfterMsOf, searchQueryOf } from "./search-client.ts";

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
const TRAIN: SearchResult = {
  kind: "train",
  id: "f11c9606-0337-5731-b27e-92f3a0ca129d",
  title: "ICE 655",
  productName: "ICE",
  trainNumber: "655",
  line: "19",
  category: "hsr",
  foreign: false,
  operator: "DB Fernverkehr AG",
  origin: { stopPlaceId: STATION.id, name: "Köln Hbf" },
  destination: {
    stopPlaceId: "61d0e4f4-5650-5835-98d1-3fa5318550a0",
    name: "Berlin Gesundbrunnen",
  },
  departure: "2026-11-07T10:00:00.000Z",
  arrival: "2026-11-07T16:00:00.000Z",
  serviceDate: "2026-11-07",
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

function answering(
  results: readonly SearchResult[],
  status = 200,
  headers: Record<string, string> = {},
) {
  const body: SearchResponse = {
    query: "x",
    serviceDate: "2026-11-07",
    timetableVersion: "1",
    results: [...results],
  };
  return vi.fn(async (_url: string) => new Response(JSON.stringify(body), { status, headers }));
}

beforeEach(async () => {
  await changeLocale("en");
  useAppStore.setState(initialState());
  resetPlaceStore();
});
afterEach(cleanup);

describe("search client", () => {
  it("asks only once the text holds a letter or digit", () => {
    expect(searchQueryOf("  ")).toBeNull();
    expect(searchQueryOf("--")).toBeNull();
    expect(searchQueryOf(" köln ")).toBe("köln");
    expect(searchQueryOf("k")).toBeNull();
    expect(searchQueryOf("1")).toBe("1");
  });

  it("reads a valid answer and treats anything else as an error", async () => {
    const fetch = answering([STATION]);
    expect(await fetchSearch("köln", "de", { fetch })).toEqual({ kind: "ok", results: [STATION] });
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/v1/search?q=k%C3%B6ln&lang=de");
    const broken = vi.fn(async () => new Response('{"results": 1}', { status: 200 }));
    expect(await fetchSearch("x", "en", { fetch: broken })).toEqual({ kind: "error" });
    expect(await fetchSearch("x", "en", { fetch: answering([], 503) })).toEqual({ kind: "error" });
  });

  it.each([
    [429, "7", 7000],
    [503, "30", 30_000],
    [503, "900", 120_000],
    [429, "Sun, 08 Nov 2026 12:00:20 GMT", 20_000],
    [503, "Sun, 08 Nov 2026 11:00:00 GMT", undefined],
    [429, "soon", undefined],
    [429, undefined, undefined],
    [500, "7", undefined],
    [404, "7", undefined],
  ])("reads the wait of a %i answer with Retry-After %s as %s ms", async (status, header, wait) => {
    vi.useFakeTimers({ now: Date.parse("2026-11-08T12:00:00Z") });
    try {
      const fetch = answering([], status, header === undefined ? {} : { "retry-after": header });
      const answer = await fetchSearch("köln", "en", { fetch });
      expect(answer).toEqual(
        wait === undefined ? { kind: "error" } : { kind: "error", retryAfterMs: wait },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives no wait to a network error", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("offline");
    });
    expect(await fetchSearch("köln", "en", { fetch })).toEqual({ kind: "error" });
  });

  it("reads Retry-After as seconds or a date and ignores the rest", () => {
    expect(retryAfterMsOf("5", 0)).toBe(5000);
    expect(retryAfterMsOf(" 0 ", 0)).toBeUndefined();
    expect(retryAfterMsOf(null, 0)).toBeUndefined();
    expect(retryAfterMsOf("", 0)).toBeUndefined();
    expect(retryAfterMsOf("Thu, 01 Jan 1970 00:00:09 GMT", 0)).toBe(9000);
  });

  it("looks a station up by its id and refuses an answer for another one", async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify(STATION)));
    expect(await fetchStation(STATION.id, { fetch: ok })).toMatchObject({ kind: "ok" });
    const missing = vi.fn(async () => new Response("{}", { status: 404 }));
    expect(await fetchStation(STATION.id, { fetch: missing })).toEqual({ kind: "not-found" });
    expect(await fetchStation(TRAIN.id, { fetch: ok })).toEqual({ kind: "error" });
  });
});

describe("result order", () => {
  it("groups by kind in the order of each kind's best result and numbers them as drawn", () => {
    const groups = groupResults([
      TRAIN,
      STATION,
      LAND,
      { ...STATION, id: TRAIN.origin.stopPlaceId },
    ]);
    expect(groups.map((group) => group.kind)).toEqual(["train", "station", "place"]);
    expect(groups[1]?.results.map((entry) => entry.index)).toEqual([1, 2]);
    expect(groups[2]?.results[0]?.index).toBe(3);
  });

  it("wraps the arrow keys at both ends", () => {
    expect(nextActive("ArrowDown", -1, 3)).toBe(0);
    expect(nextActive("ArrowDown", 2, 3)).toBe(0);
    expect(nextActive("ArrowUp", 0, 3)).toBe(2);
    expect(nextActive("ArrowUp", -1, 3)).toBe(2);
  });
});

describe("chooseResult", () => {
  it("opens a train card and closes a station", () => {
    usePlaceStore.getState().selectStation({ ...STATION, kind: undefined } as never);
    chooseResult(TRAIN);
    expect(useAppStore.getState().selectedId).toBe(TRAIN.id);
    expect(usePlaceStore.getState().station).toBeNull();
  });

  it("opens a station card and flies there", () => {
    useAppStore.getState().select(TRAIN.id);
    chooseResult(STATION);
    expect(useAppStore.getState().selectedId).toBeNull();
    expect(usePlaceStore.getState().station?.name).toBe("Köln Hbf");
    expect(usePlaceStore.getState().camera?.target).toEqual({
      kind: "point",
      lon: STATION.lon,
      lat: STATION.lat,
      zoom: STATION_ZOOM,
    });
  });

  it("focuses a Land", () => {
    chooseResult(LAND);
    expect(useAppStore.getState().focusLand).toBe("DE-BY");
  });
});

describe("SearchBox", () => {
  it("lists grouped results and picks one with the arrow keys and Enter", async () => {
    const user = userEvent.setup();
    const fetch = answering([TRAIN, STATION]);
    render(<SearchBox placeholder="Search" fetch={fetch} />);
    const field = screen.getByRole("combobox", { name: "Search" });
    await user.type(field, "köln");
    const list = await screen.findByRole("listbox", { name: "Search results" });
    await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(2));
    expect(within(list).getByRole("group", { name: "Trains" })).toBeTruthy();
    expect(within(list).getByRole("group", { name: "Stations" })).toBeTruthy();
    expect(field.getAttribute("aria-expanded")).toBe("true");
    await user.keyboard("{ArrowDown}{ArrowDown}");
    const active = field.getAttribute("aria-activedescendant") ?? "";
    expect(document.getElementById(active)?.textContent).toContain("Köln Hbf");
    await user.keyboard("{Enter}");
    expect(usePlaceStore.getState().station?.id).toBe(STATION.id);
    expect(field.getAttribute("aria-expanded")).toBe("false");
  });

  it("says when nothing matches, and offers Try again after an error", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<SearchBox placeholder="Search" fetch={answering([])} />);
    await user.type(screen.getByRole("combobox"), "Atlantis");
    expect(
      await screen.findByText("No train, line, station or place matches Atlantis"),
    ).toBeTruthy();
    unmount();
    const failing = answering([], 503);
    render(<SearchBox placeholder="Search" fetch={failing} />);
    await user.type(screen.getByRole("combobox"), "xy");
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(failing.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  describe("Try again after a refusal that named a wait", () => {
    const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      ({
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(headers),
        json: async () => body,
      }) as Response;
    const found = {
      query: "x",
      serviceDate: "2026-11-07",
      timetableVersion: "1",
      results: [STATION],
    };
    const refusal = (status: number, retryAfter?: string) => {
      let call = 0;
      return vi.fn(async (_url: string) => {
        call += 1;
        return call === 1
          ? reply(status, {}, retryAfter === undefined ? {} : { "retry-after": retryAfter })
          : reply(200, found);
      });
    };
    const typeAndFail = async (fetch: ReturnType<typeof refusal>) => {
      render(<SearchBox placeholder="Search" fetch={fetch} />);
      const field = screen.getByRole("combobox");
      fireEvent.change(field, { target: { value: "xy" } });
      await act(() => vi.advanceTimersByTimeAsync(200));
      return field;
    };

    beforeEach(() => {
      vi.useFakeTimers({
        now: Date.parse("2026-11-08T12:00:00Z"),
        toFake: ["setTimeout", "clearTimeout", "Date"],
      });
    });
    afterEach(() => vi.useRealTimers());

    it.each([
      [429, "5", 5000],
      [503, "5", 5000],
      [503, "Sun, 08 Nov 2026 12:00:05 GMT", 5000],
    ])(
      "keeps a %i answer with %s busy until the wait has passed, then retries once",
      async (status, header, waitMs) => {
        const fetch = refusal(status, header);
        const field = await typeAndFail(fetch);
        const button = screen.getByRole("button", { name: "Try again" });
        expect(button.getAttribute("aria-busy")).toBe("true");
        expect(screen.queryByText("Press Enter to try again.")).toBeNull();
        fireEvent.click(button);
        fireEvent.keyDown(field, { key: "Enter" });
        await act(() => vi.advanceTimersByTimeAsync(waitMs - 1000));
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(button.getAttribute("aria-busy")).toBe("true");
        await act(() => vi.advanceTimersByTimeAsync(1000));
        expect(button.getAttribute("aria-busy")).toBeNull();
        expect(screen.getByText("Press Enter to try again.")).toBeTruthy();
        expect(fetch).toHaveBeenCalledTimes(1);
        fireEvent.keyDown(field, { key: "Enter" });
        await act(() => vi.advanceTimersByTimeAsync(200));
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(screen.getByText("Köln Hbf")).toBeTruthy();
      },
    );

    it.each([
      ["a 429 without Retry-After", 429, undefined],
      ["a 503 with an unreadable Retry-After", 503, "soon"],
      ["a 500", 500, "5"],
    ])("does not wait after %s", async (_name, status, header) => {
      const fetch = refusal(status, header);
      await typeAndFail(fetch);
      const button = screen.getByRole("button", { name: "Try again" });
      expect(button.getAttribute("aria-busy")).toBeNull();
      fireEvent.click(button);
      await act(() => vi.advanceTimersByTimeAsync(200));
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("does not wait after a network error", async () => {
      let call = 0;
      const fetch = vi.fn(async (_url: string) => {
        call += 1;
        if (call === 1) throw new TypeError("offline");
        return reply(200, { ...found, results: [] });
      });
      render(<SearchBox placeholder="Search" fetch={fetch} />);
      const field = screen.getByRole("combobox");
      fireEvent.change(field, { target: { value: "xy" } });
      await act(() => vi.advanceTimersByTimeAsync(200));
      const button = screen.getByRole("button", { name: "Try again" });
      expect(button.getAttribute("aria-busy")).toBeNull();
      fireEvent.keyDown(field, { key: "Enter" });
      await act(() => vi.advanceTimersByTimeAsync(200));
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("waits again when the next refusal names a wait", async () => {
      const fetch = vi.fn(async (_url: string) => reply(429, {}, { "retry-after": "3" }));
      await typeAndFail(fetch);
      await act(() => vi.advanceTimersByTimeAsync(3000));
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await act(() => vi.advanceTimersByTimeAsync(200));
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("button", { name: "Try again" }).getAttribute("aria-busy")).toBe(
        "true",
      );
    });
  });

  it("closes with Escape, clears with a second Escape, and takes the slash key to focus", async () => {
    const user = userEvent.setup();
    render(<SearchBox placeholder="Search" fetch={answering([STATION])} />);
    const field = screen.getByRole("combobox") as HTMLInputElement;
    await user.keyboard("/");
    expect(document.activeElement).toBe(field);
    await user.type(field, "koeln");
    await screen.findAllByRole("option");
    await user.keyboard("{Escape}");
    expect(field.getAttribute("aria-expanded")).toBe("false");
    await user.keyboard("{Escape}");
    expect(field.value).toBe("");
  });

  it("leaves the slash key alone while the keyboard shortcuts are off (WCAG 2.1.4)", async () => {
    const user = userEvent.setup();
    useShortcutsStore.getState().setEnabled(false);
    try {
      render(<SearchBox placeholder="Search" fetch={answering([STATION])} />);
      const field = screen.getByRole("combobox") as HTMLInputElement;
      await user.keyboard("/");
      expect(document.activeElement).not.toBe(field);
      useShortcutsStore.getState().setEnabled(true);
      await user.keyboard("/");
      expect(document.activeElement).toBe(field);
    } finally {
      useShortcutsStore.getState().setEnabled(true);
    }
  });

  it("waits with Enter for the answer to what is typed, never picking an older one", async () => {
    const user = userEvent.setup();
    const bonn: SearchResult = {
      ...STATION,
      id: "5eda9b92-2ddf-5610-b59b-ed665a8b2610",
      name: "Bonn Hbf",
    };
    let release: () => void = () => undefined;
    const held = new Promise<void>((done) => (release = done));
    const body = (results: SearchResult[]) =>
      JSON.stringify({ query: "x", serviceDate: "2026-11-07", timetableVersion: "1", results });
    const fetch = vi.fn(async (url: string) => {
      if (url.includes("q=Bonn")) {
        await held;
        return new Response(body([bonn]));
      }
      return new Response(body([{ ...STATION, name: "Berlin Hbf" }]));
    });
    render(<SearchBox placeholder="Search" fetch={fetch} />);
    const field = screen.getByRole("combobox");
    await user.type(field, "Bo");
    await screen.findByText("Berlin Hbf");
    await user.type(field, "nn");
    expect(screen.getByRole("listbox").getAttribute("aria-busy")).toBe("true");
    await user.keyboard("{Enter}");
    expect(usePlaceStore.getState().station).toBeNull();
    release();
    await waitFor(() => expect(usePlaceStore.getState().station?.name).toBe("Bonn Hbf"));
  });

  it("keeps the active result in view while the arrow keys move", async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (
      this: HTMLElement,
    ) {
      seen.push(this.id);
    });
    render(<SearchBox placeholder="Search" fetch={answering([TRAIN, STATION])} />);
    const field = screen.getByRole("combobox");
    await user.type(field, "köln");
    await screen.findAllByRole("option");
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(seen.at(-1)).toBe(field.getAttribute("aria-activedescendant"));
    expect(scroll).toHaveBeenLastCalledWith({ block: "nearest" });
    scroll.mockRestore();
  });

  it("names a train with only a number as Train with that number", async () => {
    const user = userEvent.setup();
    render(
      <SearchBox
        placeholder="Search"
        fetch={answering([{ ...TRAIN, title: "88319", productName: null }])}
      />,
    );
    await user.type(screen.getByRole("combobox"), "88319");
    expect(await screen.findByText("Train 88319")).toBeTruthy();
    expect(screen.getByText("Köln Hbf → Berlin Gesundbrunnen")).toBeTruthy();
  });
});

describe("applyView", () => {
  function stores(
    fetchStationImpl = vi.fn(async () => ({ kind: "ok" as const, station: STATION as never })),
  ) {
    return {
      app: () => useAppStore.getState(),
      place: () => usePlaceStore.getState(),
      knownTrainOfKey: (key: number) => (key === 7 ? TRAIN.id : null),
      fetchStation: fetchStationImpl,
      fetch: vi.fn(),
    };
  }

  it("selects the linked train and leaves a frame key of the same train alone", () => {
    applyView({ ...EMPTY_VIEW, train: TRAIN.id }, "load", stores());
    expect(useAppStore.getState().selectedId).toBe(TRAIN.id);
    useAppStore.getState().select("live:7");
    applyView({ ...EMPTY_VIEW, train: TRAIN.id }, "pop", stores());
    expect(useAppStore.getState().selectedId).toBe("live:7");
  });

  it("loads a linked station, opens its card and flies there when the link has no camera", async () => {
    applyView({ ...EMPTY_VIEW, station: STATION.id }, "load", stores());
    expect(usePlaceStore.getState().pendingStationId).toBe(STATION.id);
    await waitFor(() => expect(usePlaceStore.getState().station?.name).toBe("Köln Hbf"));
    expect(usePlaceStore.getState().camera?.target.kind).toBe("point");
  });

  it("restores the camera of an entry, animated on Back, cut on load", () => {
    const camera = { zoom: 9, lat: 50, lon: 8 };
    applyView({ ...EMPTY_VIEW, camera }, "load", stores());
    expect(usePlaceStore.getState().camera?.target).toEqual({
      kind: "view",
      camera,
      animate: false,
    });
    applyView({ ...EMPTY_VIEW, camera }, "pop", stores());
    expect(usePlaceStore.getState().camera?.target).toEqual({
      kind: "view",
      camera,
      animate: true,
    });
  });

  it("clears the selection and the Land focus an entry does not hold", () => {
    act(() => {
      useAppStore.getState().select(TRAIN.id);
      useAppStore.getState().setFocusLand("DE-BY");
    });
    applyView(EMPTY_VIEW, "pop", stores());
    expect(useAppStore.getState().selectedId).toBeNull();
    expect(useAppStore.getState().focusLand).toBeNull();
  });
});
