// @vitest-environment happy-dom
import { changeLocale } from "@gerlines/i18n";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataStatus } from "../../motion/protocol.ts";
import { usePlaybackStore } from "../../playback/store.ts";
import { initialState, useAppStore } from "../../state/store.ts";
import { ATTRIBUTION_AUTO_COLLAPSE_MS, Attribution } from "./Attribution.tsx";
import { LegendCard } from "./LegendCard.tsx";
import { LiveBar } from "./LiveBar.tsx";
import { LocaleSwitch } from "./LocaleSwitch.tsx";
import { SearchCard } from "./SearchCard.tsx";
import { StylePicker } from "./StylePicker.tsx";
import { ZoomControls } from "./ZoomControls.tsx";

const STATUS: DataStatus = {
  state: "live",
  dataTimeMs: Date.parse("2026-10-23T19:34:00Z"),
  trips: 2665,
  realtime: 2234,
  untracked: 37,
  counts: { hsr: 151, ld: 40, night: 3, rfast: 463, reg: 610, sbahn: 621, foreign: 777 },
  error: undefined,
};

const ZERO_COUNTS = { hsr: 0, ld: 0, night: 0, rfast: 0, reg: 0, sbahn: 0, foreign: 0 };

beforeEach(async () => {
  await changeLocale("en");
  useAppStore.setState({ ...initialState(), status: STATUS });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("SearchCard", () => {
  it("names the product and its promise, and offers the search field as a combobox", () => {
    render(<SearchCard />);

    expect(screen.getByRole("heading", { name: "GerLines" })).toBeTruthy();
    expect(screen.getByText("Every train in Germany, live")).toBeTruthy();
    const field = screen.getByRole("combobox", { name: "Search" });
    expect((field as HTMLInputElement).disabled).toBe(false);
    expect(field.getAttribute("placeholder")).toBe("Search for a train, line or station");
    expect(field.getAttribute("aria-expanded")).toBe("false");
    expect(field.getAttribute("aria-keyshortcuts")).toBe("/");
  });

  it("offers category, delay and operator as colour modes, all of them enabled", () => {
    render(<SearchCard />);

    expect((screen.getByRole("radio", { name: "Category" }) as HTMLInputElement).checked).toBe(
      true,
    );
    for (const name of ["Category", "Delay", "Operator"]) {
      expect((screen.getByRole("radio", { name }) as HTMLInputElement).disabled).toBe(false);
    }
    expect(screen.queryByText("Soon")).toBeNull();
    expect(screen.queryByText(/live data/)).toBeNull();
  });

  it("switches to the operator mode and keeps it for the next visit", async () => {
    render(<SearchCard />);

    await userEvent.click(screen.getByRole("radio", { name: "Operator" }));

    expect(useAppStore.getState().colourMode).toBe("operator");
    expect((screen.getByRole("radio", { name: "Operator" }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(window.localStorage.getItem("gerlines.colourMode")).toBe("operator");
  });

  it("moves between the three modes with the arrow keys", async () => {
    render(<SearchCard />);

    screen.getByRole("radio", { name: "Category" }).focus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");

    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Operator" }));
  });

  it("switches the colour mode in the store and keeps it for the next visit", async () => {
    render(<SearchCard />);

    await userEvent.click(screen.getByRole("radio", { name: "Delay" }));

    expect(useAppStore.getState().colourMode).toBe("delay");
    expect((screen.getByRole("radio", { name: "Delay" }) as HTMLInputElement).checked).toBe(true);
    expect(window.localStorage.getItem("gerlines.colourMode")).toBe("delay");
    await userEvent.click(screen.getByRole("radio", { name: "Category" }));
    expect(useAppStore.getState().colourMode).toBe("category");
  });

  it("shows the wordmark without the tagline when compact", () => {
    render(<SearchCard compact />);

    const heading = screen.getByRole("heading", { name: "GerLines" });
    expect(heading.className).toContain("type-wordmark");
    expect(heading.className).not.toContain("sr-only");
    expect(screen.queryByText("Every train in Germany, live")).toBeNull();
  });

  it("names the operator mode in the language of the interface", async () => {
    await act(() => changeLocale("de"));

    render(<SearchCard />);

    expect(screen.getByRole("radio", { name: "Betreiber" })).toBeTruthy();
  });
});

describe("LiveBar", () => {
  it("shows the live state with the time and day of the data", () => {
    render(<LiveBar />);

    expect(screen.getByRole("status").textContent).toBe("Live");
    expect(screen.getByText("Germany, all trains")).toBeTruthy();
    expect(
      screen.getByText(
        (_, element) =>
          element?.classList.contains("num") === true && element.textContent === "21:34",
      ),
    ).toBeTruthy();
    expect(screen.getByText("23 October")).toBeTruthy();
  });

  it.each([
    [{ state: "recorded" }, "Recorded sample"],
    [{ state: "stale" }, "Data is stale"],
    [{ state: "loading", dataTimeMs: undefined }, "Loading trains"],
    [{ state: "error", error: "upstream_unavailable" }, "The data source does not answer"],
    [{ state: "error", error: "unreachable" }, "Could not reach the server"],
    [{ state: "error", error: "unreadable" }, "The server sent data that cannot be read"],
    [{ state: "error", error: "server_error" }, "The server answered with an error"],
    [{ state: "error", error: "no_live_server" }, "No live server is running"],
    [{ state: "error", error: undefined }, "No data"],
  ] as const)("says what %o means", (patch, label) => {
    useAppStore.setState({ status: { ...STATUS, ...patch } });

    render(<LiveBar />);

    expect(screen.getByRole("status").textContent).toBe(label);
  });

  it("says that no live server runs in development and keeps the zoom stage, with no link to another source", () => {
    expect(import.meta.env.DEV).toBe(true);
    useAppStore.setState({ status: { ...STATUS, state: "error", error: "no_live_server" } });

    render(<LiveBar />);

    expect(screen.getByRole("status").textContent).toBe("No live server is running");
    expect(screen.getByText("Germany, all trains")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("names the zoom stage and can leave it out", () => {
    useAppStore.setState({ zoom: 9 });
    render(<LiveBar />);
    expect(screen.getByText("Region, all trains")).toBeTruthy();
    cleanup();
    useAppStore.setState({ zoom: 12 });
    render(<LiveBar />);
    expect(screen.getByText("City, trains with heading")).toBeTruthy();
    cleanup();

    render(<LiveBar showStage={false} />);

    expect(screen.queryByText("City, trains with heading")).toBeNull();
  });

  it("stacks the zoom stage line under the status row for the phone", () => {
    useAppStore.setState({ zoom: 6 });

    render(<LiveBar stacked />);

    const bar = document.querySelector("[data-slot=live-bar]");
    expect(bar?.className).toContain("flex-col");
    expect(within(bar as HTMLElement).getByText("Germany, all trains").className).toContain(
      "type-caption",
    );
    expect(screen.getByRole("status").textContent).toBe("Live");
  });

  it("holds the room of the History button in the stacked bar before the map can play a past hour", () => {
    render(<LiveBar stacked />);

    const tail = document.querySelector("[data-slot=live-bar-tail]");
    expect(screen.queryByRole("button", { name: "History" })).toBeNull();
    expect(tail?.className).toContain("min-h-target");
    act(() => usePlaybackStore.getState().attach(() => undefined));
    expect(screen.getByRole("button", { name: "History" })).toBeTruthy();
    expect(document.querySelector("[data-slot=live-bar-tail]")?.className).toContain(
      "min-h-target",
    );
    act(() => usePlaybackStore.getState().attach(null));
  });

  it("speaks the language of the interface", async () => {
    await act(() => changeLocale("de"));

    render(<LiveBar />);

    expect(screen.getByText("Deutschland, alle Züge")).toBeTruthy();
    expect(screen.getByText("23. Oktober")).toBeTruthy();
  });
});

describe("LegendCard in the delay mode", () => {
  const DELAY_COUNTS = { ok: 1500, minor: 300, major: 120, severe: 40, none: 190, foreign: 777 };

  beforeEach(() => {
    useAppStore.setState({
      colourMode: "delay",
      status: { ...STATUS, delayCounts: DELAY_COUNTS },
    });
  });

  it("lists the delay classes with their counts instead of the category colours", () => {
    render(<LegendCard />);

    const list = screen.getByTestId("delay-legend");
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("data-delay-class"))).toEqual([
      "ok",
      "minor",
      "major",
      "severe",
      "none",
      "foreign",
    ]);
    expect(rows[0]?.textContent).toContain("On time, under");
    expect(rows[0]?.textContent).toContain("1,500");
    expect(within(list).getByText("No realtime data")).toBeTruthy();
    expect(rows[4]?.textContent).toContain("190");
    expect(rows[5]?.textContent).toContain("Foreign trains");
    expect(rows[5]?.textContent).toContain("777");
    const sum = rows.reduce((total, row) => {
      const count = Number(
        (row.textContent ?? "")
          .replace(/\D+$/, "")
          .match(/[\d,]+$/)?.[0]
          ?.replace(/,/g, ""),
      );
      return total + count;
    }, 0);
    expect(sum).toBe(Object.values(DELAY_COUNTS).reduce((a, b) => a + b, 0));
  });

  it("puts the label control above the toggles, which stay behind a Show on the map disclosure", async () => {
    render(<LegendCard />);

    const control = screen.getByTestId("label-mode");
    const disclosure = screen.getByRole("button", { name: "Show on the map" });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(
      control.compareDocumentPosition(disclosure) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await userEvent.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the category and foreign toggles under a Show on the map heading", async () => {
    render(<LegendCard />);

    await userEvent.click(screen.getByRole("button", { name: "Show on the map" }));
    const box = screen.getByRole("checkbox", { name: "ICE and high speed" });
    expect(box.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(box);
    expect(useAppStore.getState().hiddenCategories).toEqual(["hsr"]);
    await userEvent.click(screen.getByRole("checkbox", { name: "Foreign trains" }));
    expect(useAppStore.getState().hiddenCategories).toEqual(["hsr", "foreign"]);
    expect(screen.getByText("151")).toBeTruthy();
    expect(screen.getAllByText("777").length).toBe(2);
  });

  it("mutes the count of a hidden category row with its name, as the category legend does", async () => {
    render(<LegendCard />);

    await userEvent.click(screen.getByRole("button", { name: "Show on the map" }));
    const row = screen.getByRole("checkbox", { name: "ICE and high speed" }).closest("label");
    const count = within(row as HTMLElement).getByText("151");
    expect(row?.className).toContain("group/row");
    expect(row?.className).toContain("has-[[data-unchecked]]:text-ink-muted");
    expect(count.className).toMatch(/(^|\s)text-ink(\s|$)/);
    expect(count.className).toContain("group-has-[[data-unchecked]]/row:text-ink-muted");
    expect(count.className).not.toMatch(/(^|\s)text-ink-muted(\s|$)/);
  });

  it("shows the delay counts as missing until the first status arrives", () => {
    useAppStore.setState({ ...initialState(), colourMode: "delay" });
    render(<LegendCard />);

    expect(within(screen.getByTestId("delay-legend")).getAllByTestId("count-missing").length).toBe(
      6,
    );
  });

  it("does not show the delay rows in the category mode", () => {
    useAppStore.setState({ colourMode: "category" });
    render(<LegendCard />);

    expect(screen.queryByTestId("delay-legend")).toBeNull();
    expect(screen.queryByText("Show on the map")).toBeNull();
  });
});

describe("LegendCard in the operator mode", () => {
  const OPERATOR_COUNTS = {
    db: 1500,
    transdev: 140,
    netinera: 90,
    kvvh: 80,
    hlb: 60,
    sweg: 40,
    other: 650,
    unknown: 55,
  };
  const TOTAL = Object.values(OPERATOR_COUNTS).reduce((a, b) => a + b, 0);

  beforeEach(() => {
    useAppStore.setState({
      colourMode: "operator",
      status: { ...STATUS, trips: TOTAL, operatorCounts: OPERATOR_COUNTS },
    });
  });

  it("lists the groups with their counts, then Other and Unknown, summing to the total", () => {
    render(<LegendCard />);

    const rows = within(screen.getByTestId("operator-legend")).getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("data-operator-group"))).toEqual([
      "db",
      "transdev",
      "netinera",
      "kvvh",
      "hlb",
      "sweg",
      "other",
      "unknown",
    ]);
    expect(rows[0]?.textContent).toContain("Deutsche Bahn");
    expect(rows[0]?.textContent).toContain("1,500");
    expect(rows[6]?.textContent).toContain("Other operators");
    expect(rows[7]?.textContent).toContain("Operator unknown");
    expect(rows[7]?.textContent).toContain("55");
    const sum = rows.reduce(
      (total, row) =>
        total + Number((row.textContent ?? "").match(/[\d,]+$/)?.[0]?.replace(/,/g, "")),
      0,
    );
    expect(sum).toBe(TOTAL);
    expect(screen.getByText("Grouped by parent organisation")).toBeTruthy();
  });

  it("hides and shows a group with its checkbox and keeps the count", async () => {
    render(<LegendCard />);

    const box = screen.getByRole("checkbox", { name: "Transdev" });
    expect(box.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(box);
    expect(useAppStore.getState().hiddenOperatorGroups).toEqual(["transdev"]);
    expect(screen.getByRole("checkbox", { name: "Transdev" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(screen.getByText("140")).toBeTruthy();
    await userEvent.click(screen.getByRole("checkbox", { name: "Operator unknown" }));
    expect(useAppStore.getState().hiddenOperatorGroups).toEqual(["transdev", "unknown"]);
    await userEvent.click(screen.getByRole("checkbox", { name: "Transdev" }));
    expect(useAppStore.getState().hiddenOperatorGroups).toEqual(["unknown"]);
  });

  it("mutes the count of a hidden group with its name and keeps the others in ink", async () => {
    render(<LegendCard />);

    const rowOf = (name: string) =>
      screen.getByRole("checkbox", { name }).closest("label") as HTMLElement;
    await userEvent.click(screen.getByRole("checkbox", { name: "Transdev" }));
    const row = rowOf("Transdev");
    const count = within(row).getByText("140");
    expect(row.querySelector("[data-unchecked]")).toBeTruthy();
    expect(row.className).toContain("group/row");
    expect(row.className).toContain("has-[[data-unchecked]]:text-ink-muted");
    expect(count.className).toMatch(/(^|\s)text-ink(\s|$)/);
    expect(count.className).toContain("group-has-[[data-unchecked]]/row:text-ink-muted");
    expect(rowOf("Netinera").querySelector("[data-unchecked]")).toBeNull();
  });

  it("makes every group checkbox a tab stop in the order of the rows", async () => {
    render(<LegendCard />);

    const user = userEvent.setup();
    const names = [];
    for (let stop = 0; stop < 9; stop++) {
      await user.tab();
      names.push(document.activeElement?.getAttribute("aria-label"));
    }
    expect(names).toEqual([
      "Trains in view",
      "Deutsche Bahn",
      "Transdev",
      "Netinera",
      "KVVH",
      "Hessische Landesbahn",
      "SWEG",
      "Other operators",
      "Operator unknown",
    ]);
  });

  it("shows the counts as missing until the first status arrives", () => {
    useAppStore.setState({ ...initialState(), colourMode: "operator" });
    render(<LegendCard />);

    expect(
      within(screen.getByTestId("operator-legend")).getAllByTestId("count-missing").length,
    ).toBe(8);
  });

  it("shows the counts as missing when the data has no operator counts", () => {
    useAppStore.setState({ status: STATUS });
    render(<LegendCard />);

    expect(
      within(screen.getByTestId("operator-legend")).getAllByTestId("count-missing").length,
    ).toBe(8);
  });

  it("draws the swatches of Other and Unknown smaller, as the dots on the map", () => {
    render(<LegendCard />);

    const radius = (group: string) =>
      document.querySelector(`[data-operator-group="${group}"] circle`)?.getAttribute("r");
    expect(radius("db")).toBe("5");
    expect(radius("sweg")).toBe("5");
    expect(radius("other")).toBe("4");
    expect(radius("unknown")).toBe("4");
  });

  it("puts the label control above the category toggles, which stay behind Show on the map", async () => {
    render(<LegendCard />);

    expect(screen.getByTestId("label-mode")).toBeTruthy();
    const disclosure = screen.getByRole("button", { name: "Show on the map" });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(disclosure);
    await userEvent.click(screen.getByRole("checkbox", { name: "Foreign trains" }));
    expect(useAppStore.getState().hiddenCategories).toEqual(["foreign"]);
  });

  it("does not show the operator rows in the other modes", () => {
    useAppStore.setState({ colourMode: "delay" });
    render(<LegendCard />);

    expect(screen.queryByTestId("operator-legend")).toBeNull();
  });

  it("names the groups and the hint in German and Polish", async () => {
    await act(() => changeLocale("pl"));
    const { unmount } = render(<LegendCard />);
    expect(screen.getByText("Pozostali przewoźnicy")).toBeTruthy();
    expect(screen.getByText("Przewoźnik nieznany")).toBeTruthy();
    unmount();
    await act(() => changeLocale("de"));
    render(<LegendCard />);
    expect(screen.getByText("Andere Betreiber")).toBeTruthy();
    expect(screen.getByText("Nach Mutterkonzern gruppiert")).toBeTruthy();
  });
});

describe("LegendCard label mode", () => {
  it("offers off, line and delay, starting with off", () => {
    render(<LegendCard />);

    const group = screen.getByRole("radiogroup", { name: "Train labels" });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((radio) => radio.closest("label")?.textContent),
    ).toEqual(["Off", "Line", "Delay"]);
    expect((within(group).getByRole("radio", { name: "Off" }) as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it("stores the choice and keeps it for the next visit", async () => {
    render(<LegendCard />);

    await userEvent.click(
      within(screen.getByTestId("label-mode")).getByRole("radio", { name: "Line" }),
    );

    expect(useAppStore.getState().labelMode).toBe("line");
    expect(window.localStorage.getItem("gerlines.labelMode")).toBe("line");
  });

  it("hints to zoom in while labels are on and the map is too far out, and not otherwise", () => {
    useAppStore.setState({ labelMode: "line", zoom: 7 });
    render(<LegendCard />);

    expect(screen.getByText("Zoom in to show the labels")).toBeTruthy();
    cleanup();
    useAppStore.setState({ labelMode: "line", zoom: 12 });
    render(<LegendCard />);
    expect(screen.queryByText("Zoom in to show the labels")).toBeNull();
    cleanup();
    useAppStore.setState({ labelMode: "off", zoom: 7 });
    render(<LegendCard />);
    expect(screen.queryByText("Zoom in to show the labels")).toBeNull();
  });
});

describe("LegendCard", () => {
  it("lists each category with its count and the totals", () => {
    render(<LegendCard />);

    expect(screen.getByText("ICE and high speed")).toBeTruthy();
    expect(screen.getByText("151")).toBeTruthy();
    expect(screen.getByText("Foreign trains")).toBeTruthy();
    expect(screen.getByText("777")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Trains on the map" }).textContent).toContain(
      "2,665 total, 2,234 realtime",
    );
  });

  it("shows the counts as missing, not as zero, until the first status arrives", () => {
    useAppStore.setState(initialState());
    render(<LegendCard />);

    const region = screen.getByRole("region", { name: "Trains on the map" });
    expect(region.textContent).toContain("Loading trains");
    expect(region.textContent).not.toMatch(/\b0\b/);
    expect(screen.getAllByTestId("count-missing").length).toBe(7);
  });

  it("keeps Loading trains and no zero totals until the first keyframe is applied", () => {
    useAppStore.setState({
      status: { ...STATUS, trips: 0, realtime: 0, framed: false, counts: ZERO_COUNTS },
    });
    render(<LegendCard />);

    const region = screen.getByRole("region", { name: "Trains on the map" });
    expect(region.textContent).toContain("Loading trains");
    expect(region.textContent).not.toMatch(/\b0\b/);
    expect(screen.getAllByTestId("count-missing").length).toBe(7);
  });

  it("shows the totals from the first applied keyframe on", () => {
    useAppStore.setState({ status: { ...STATUS, framed: true } });
    render(<LegendCard />);

    expect(screen.getByRole("region", { name: "Trains on the map" }).textContent).toContain(
      "2,665 total, 2,234 realtime",
    );
  });

  it("shows the counts as missing when the source fails before any data arrived", () => {
    useAppStore.setState({
      status: { ...initialState().status, state: "error", error: "unreachable" },
    });
    render(<LegendCard />);

    const region = screen.getByRole("region", { name: "Trains on the map" });
    expect(region.textContent).toContain("No data");
    expect(region.textContent).not.toMatch(/\b0\b/);
    expect(screen.getAllByTestId("count-missing").length).toBe(7);
  });

  it("keeps the last counts when the source fails after data arrived", () => {
    useAppStore.setState({ status: { ...STATUS, state: "error", error: "unreachable" } });
    render(<LegendCard />);

    expect(screen.getByRole("region", { name: "Trains on the map" }).textContent).toContain(
      "2,665 total",
    );
    expect(screen.queryAllByTestId("count-missing")).toHaveLength(0);
  });

  it("keeps each totals phrase on one line so a Polish break falls after the comma", () => {
    render(<LegendCard />);

    const phrases = [...document.querySelectorAll("span.whitespace-nowrap")].map(
      (node) => node.textContent,
    );
    expect(phrases).toContain("2,665 total");
    expect(phrases).toContain("2,234 realtime");
  });

  it("hides and shows a category from its checkbox", async () => {
    const user = userEvent.setup();
    render(<LegendCard />);

    await user.click(screen.getByRole("checkbox", { name: "RB" }));
    expect(useAppStore.getState().hiddenCategories).toEqual(["reg"]);
    await user.click(screen.getByRole("checkbox", { name: "RB" }));

    expect(useAppStore.getState().hiddenCategories).toEqual([]);
  });

  it("says how many trains are left off the map because their track is unknown", () => {
    render(<LegendCard />);

    expect(screen.getByRole("note").textContent).toBe(
      "37 trains without track geometry are not shown",
    );
  });

  it("uses the singular for one train and shows no note when every train has a track", () => {
    useAppStore.setState({ status: { ...STATUS, untracked: 1 } });
    render(<LegendCard />);
    expect(screen.getByRole("note").textContent).toBe(
      "1 train without track geometry is not shown",
    );
    cleanup();
    useAppStore.setState({ status: { ...STATUS, untracked: 0 } });

    render(<LegendCard />);

    expect(screen.queryByRole("note")).toBeNull();
  });

  it("groups the count like the language of the interface", async () => {
    await act(() => changeLocale("pl"));
    useAppStore.setState({ status: { ...STATUS, untracked: 2665 } });

    render(<LegendCard />);

    expect(screen.getByRole("note").textContent?.replace(/\s/g, " ")).toBe(
      "Nie pokazano 2 665 pociągów bez geometrii toru",
    );
  });

  it("collapses and expands when collapsible", () => {
    render(<LegendCard collapsible defaultOpen={false} />);
    const toggle = screen.getByRole("button", { name: /^Trains(?! in view)/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("checkbox", { name: "RB" })).toBeNull();

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("checkbox", { name: "RB" })).toBeTruthy();
  });
});

describe("ZoomControls", () => {
  it("zooms by one level in each direction", () => {
    const onZoom = vi.fn();
    render(<ZoomControls onZoom={onZoom} />);

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));

    expect(onZoom.mock.calls).toEqual([[1], [-1]]);
  });
});

describe("Attribution", () => {
  it("credits the map and train data providers with links that open safely", () => {
    render(<Attribution />);

    for (const name of [
      "OpenStreetMap contributors",
      "OpenFreeMap",
      "OpenMapTiles",
      "DELFI",
      "gtfs.de",
      "CC BY 4.0",
      "CC BY-SA 4.0",
      "© GeoBasis-DE / BKG (2026)",
      "DL-DE BY 2.0",
      "Natural Earth",
      "DB StaDa",
    ]) {
      for (const link of screen.getAllByRole("link", { name })) {
        expect(link.getAttribute("rel")).toContain("noopener");
        expect(link.className).toContain("whitespace-nowrap");
      }
    }
  });

  it("credits DB StaDa under CC BY 4.0 for the station names", () => {
    render(<Attribution />);

    expect(document.body.textContent).toContain("Station names DB StaDa (CC BY 4.0).");
    expect(screen.getByRole("link", { name: "DB StaDa" }).getAttribute("href")).toBe(
      "https://developers.deutschebahn.com/db-api-marketplace/apis/product/stada",
    );
    expect(screen.getAllByRole("link", { name: "CC BY 4.0" })).toHaveLength(2);
  });

  it("says which licence covers the timetable and which the realtime data", () => {
    render(<Attribution />);

    expect(document.body.textContent).toContain(
      "DELFI, gtfs.de (timetable CC BY 4.0, realtime CC BY-SA 4.0)",
    );
  });

  it("credits our own sources for an old link that asked for another train source", () => {
    window.history.replaceState(null, "", "/?source=transitous");
    try {
      render(<Attribution />);

      expect(screen.getByRole("link", { name: "DELFI" })).toBeTruthy();
      expect(screen.getByRole("link", { name: "gtfs.de" })).toBeTruthy();
      expect(screen.getByRole("link", { name: "CC BY-SA 4.0" })).toBeTruthy();
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });

  it("credits the imagery sources only in the satellite style", () => {
    const { unmount } = render(<Attribution />);
    expect(screen.queryByRole("link", { name: "VersaTiles" })).toBeNull();
    unmount();

    act(() => useAppStore.getState().setMapStyle("satellite"));
    render(<Attribution />);

    const link = screen.getByRole("link", { name: "VersaTiles" });
    expect(link.getAttribute("href")).toBe("https://versatiles.org/sources/");
    expect(
      screen.getByText(/Land survey offices and modified Copernicus Sentinel data/),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "© Mapterhorn" })).toBeNull();
  });

  it("credits the elevation source in the terrain style", () => {
    act(() => useAppStore.getState().setMapStyle("terrain"));
    render(<Attribution />);

    const link = screen.getByRole("link", { name: "© Mapterhorn" });
    expect(link.getAttribute("href")).toBe("https://mapterhorn.com/attribution/");
    expect(link.className).toContain("whitespace-nowrap");
    expect(screen.getByRole("link", { name: "OpenStreetMap contributors" })).toBeTruthy();
  });

  it("names the imagery providers in German and Polish", async () => {
    act(() => useAppStore.getState().setMapStyle("satellite"));
    await act(() => changeLocale("pl"));
    render(<Attribution />);

    expect(screen.getByText(/zmodyfikowane dane Copernicus Sentinel/)).toBeTruthy();
  });

  it("is visible on load even when collapsible, with the info button ready", () => {
    render(<Attribution collapsible />);

    expect(screen.getByRole("link", { name: "DL-DE BY 2.0" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Hide data sources" }).getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("never collapses by itself when it is not collapsible", () => {
    vi.useFakeTimers();
    render(<Attribution />);

    act(() => {
      useAppStore.getState().markMapInteracted();
      vi.advanceTimersByTime(ATTRIBUTION_AUTO_COLLAPSE_MS * 2);
    });

    expect(screen.getByRole("link", { name: "DL-DE BY 2.0" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /data sources/ })).toBeNull();
  });

  describe("when a panel needs its room", () => {
    it("folds to the info button at once, without waiting for the timer or an interaction", () => {
      render(<Attribution fold />);

      expect(screen.queryByRole("link", { name: "DL-DE BY 2.0" })).toBeNull();
      expect(
        screen.getByRole("button", { name: "Show data sources" }).getAttribute("aria-expanded"),
      ).toBe("false");
    });

    it("shows the full credits again when the panel is gone and folds again when it comes back", () => {
      const { rerender } = render(<Attribution fold />);

      rerender(<Attribution fold={false} />);
      expect(screen.getByRole("link", { name: "DL-DE BY 2.0" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: /data sources/ })).toBeNull();

      rerender(<Attribution fold />);
      expect(screen.queryByRole("link", { name: "DL-DE BY 2.0" })).toBeNull();
    });

    it("still reopens from the info button when the user asks for the credits", () => {
      render(<Attribution fold />);

      fireEvent.click(screen.getByRole("button", { name: "Show data sources" }));

      expect(screen.getByRole("link", { name: "DL-DE BY 2.0" })).toBeTruthy();
    });

    it("does not pull the credits away from the keyboard focus inside them", () => {
      const { rerender } = render(<Attribution fold={false} />);
      screen.getByRole("link", { name: "DELFI" }).focus();

      rerender(<Attribution fold />);

      expect(screen.getByRole("link", { name: "DELFI" })).toBeTruthy();
    });
    it("folds the credits after all once the focus leaves them while a panel needs the room", () => {
      const { rerender } = render(<Attribution fold={false} />);
      const link = screen.getByRole("link", { name: "DELFI" });
      link.focus();
      rerender(<Attribution fold />);
      expect(screen.getByRole("link", { name: "DELFI" })).toBeTruthy();

      fireEvent.blur(link, { relatedTarget: null });

      expect(screen.queryByRole("link", { name: "DELFI" })).toBeNull();
    });

    it("keeps the credits the user reopened from the info button when the focus leaves them", () => {
      render(<Attribution fold />);
      fireEvent.click(screen.getByRole("button", { name: "Show data sources" }));

      fireEvent.blur(screen.getByRole("button", { name: "Hide data sources" }), {
        relatedTarget: null,
      });

      expect(screen.getByRole("link", { name: "DELFI" })).toBeTruthy();
    });
  });

  describe("when collapsible", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("collapses to the info button after five seconds", () => {
      render(<Attribution collapsible />);
      act(() => {
        vi.advanceTimersByTime(ATTRIBUTION_AUTO_COLLAPSE_MS - 1);
      });
      expect(screen.queryByRole("link", { name: "DL-DE BY 2.0" })).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(1);
      });

      expect(screen.queryByRole("link", { name: "DL-DE BY 2.0" })).toBeNull();
      expect(
        screen.getByRole("button", { name: "Show data sources" }).getAttribute("aria-expanded"),
      ).toBe("false");
    });

    it("collapses at once on the first map interaction", () => {
      render(<Attribution collapsible />);

      act(() => {
        useAppStore.getState().markMapInteracted();
      });

      expect(screen.queryByRole("link", { name: "DL-DE BY 2.0" })).toBeNull();
    });

    it("reopens from the info button and then stays open", () => {
      render(<Attribution collapsible />);
      act(() => {
        useAppStore.getState().markMapInteracted();
      });

      fireEvent.click(screen.getByRole("button", { name: "Show data sources" }));
      act(() => {
        vi.advanceTimersByTime(ATTRIBUTION_AUTO_COLLAPSE_MS * 2);
        useAppStore.getState().markMapInteracted();
      });

      expect(screen.getByRole("link", { name: "DL-DE BY 2.0" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Hide data sources" }));
      expect(screen.queryByRole("link", { name: "DL-DE BY 2.0" })).toBeNull();
    });

    it("keeps the credits open while the keyboard focus is inside them", () => {
      render(<Attribution collapsible />);
      screen.getByRole("link", { name: "DELFI" }).focus();

      act(() => {
        vi.advanceTimersByTime(ATTRIBUTION_AUTO_COLLAPSE_MS);
      });

      expect(screen.getByRole("link", { name: "DELFI" })).toBeTruthy();
    });
  });
});

describe("StylePicker", () => {
  it("folded, is one plain row until pressed, then opens its popover with the styles and the switches", async () => {
    const user = userEvent.setup();
    render(<StylePicker folded />);
    const row = screen.getByTestId("style-fold");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Satellite" })).toBeNull();

    await user.click(row);
    await screen.findByRole("button", { name: "Satellite" });
    expect(screen.getByTestId("style-fold")).toBe(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("switch", { name: "Keyboard shortcuts" })).toBeTruthy();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Satellite" })).toBeNull());
    expect(document.activeElement).toBe(row);
  });

  it("offers all four styles and switches the map style, the theme and the stored choice", () => {
    render(<StylePicker />);
    expect(screen.getByRole("button", { name: "Dark" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText("Soon")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Satellite" }));
    expect(useAppStore.getState()).toMatchObject({ mapStyle: "satellite", theme: "dark" });
    expect(window.localStorage.getItem("gerlines-map-style")).toBe("satellite");

    fireEvent.click(screen.getByRole("button", { name: "Terrain" }));
    expect(useAppStore.getState()).toMatchObject({ mapStyle: "terrain", theme: "light" });
    expect(window.localStorage.getItem("gerlines-theme")).toBe("light");
    expect(screen.getByRole("button", { name: "Terrain" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("shows the 3D terrain switch only in the terrain style and remembers the choice", () => {
    render(<StylePicker />);
    expect(screen.queryByRole("switch", { name: "3D terrain" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Terrain" }));
    fireEvent.click(screen.getByRole("switch", { name: "3D terrain" }));

    expect(useAppStore.getState().terrain3d).toBe(true);
    expect(window.localStorage.getItem("gerlines-terrain-3d")).toBe("on");
    fireEvent.click(screen.getByRole("button", { name: "Light" }));
    expect(useAppStore.getState().terrain3d).toBe(false);
    expect(screen.queryByRole("switch", { name: "3D terrain" })).toBeNull();
  });

  it("offers the 3D terrain switch in production builds too, since trains now sit on the relief", () => {
    vi.stubEnv("DEV", false);
    act(() => useAppStore.getState().setMapStyle("terrain"));
    render(<StylePicker />);

    expect(screen.getByRole("switch", { name: "3D terrain" })).toBeTruthy();
    vi.unstubAllEnvs();
  });

  it("offers the 3D buildings switch only while the relief is on, and remembers the choice", () => {
    render(<StylePicker />);
    expect(screen.queryByRole("switch", { name: "3D buildings" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Terrain" }));
    expect(screen.queryByRole("switch", { name: "3D buildings" })).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "3D terrain" }));
    fireEvent.click(screen.getByRole("switch", { name: "3D buildings" }));

    expect(useAppStore.getState().buildings).toBe(true);
    expect(window.localStorage.getItem("gerlines-buildings-3d")).toBe("on");
    fireEvent.click(screen.getByRole("switch", { name: "3D terrain" }));
    expect(screen.queryByRole("switch", { name: "3D buildings" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
    expect(screen.queryByRole("switch", { name: "3D buildings" })).toBeNull();
  });

  it("says 3D can be slow only on a low GPU tier and only while a 3D switch is on", () => {
    const { unmount } = render(<StylePicker />);
    expect(screen.queryByText("3D can run slowly on this device")).toBeNull();
    unmount();

    act(() => useAppStore.setState({ gpuTier: "low" }));
    const low = render(<StylePicker />);
    expect(screen.queryByText("3D can run slowly on this device")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Terrain" }));
    expect(screen.queryByText("3D can run slowly on this device")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "3D terrain" }));
    expect(screen.getByText("3D can run slowly on this device")).toBeTruthy();
    low.unmount();
  });

  it("names the 3D switch in German", async () => {
    await act(() => changeLocale("de"));
    act(() => useAppStore.getState().setMapStyle("terrain"));
    render(<StylePicker />);

    expect(screen.getByRole("switch", { name: "Gelände in 3D" })).toBeTruthy();
  });
});

describe("LocaleSwitch", () => {
  it("changes the language of the interface without a reload", async () => {
    render(<LocaleSwitch />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "PL, Polski" }));
    });

    expect(document.documentElement.lang).toBe("pl-PL");
    expect(
      within(screen.getByRole("group", { name: "Język" }))
        .getByRole("button", {
          name: "PL, Polski",
        })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
