// @vitest-environment happy-dom
import { changeLocale } from "@gerlines/i18n";
import { TooltipProvider } from "@gerlines/ui";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestCardFocus, takeCardFocus } from "../../../a11y/card-focus.ts";
import { initialState, useAppStore } from "../../../state/store.ts";
import { STALE_AFTER_MS } from "../model.ts";
import { FIVE_STOPS, MINUTE, T0, testDetail, testStops } from "../test-detail.ts";
import type { TrainActionHandlers } from "./CardActions.tsx";
import { type TrainCardState, TrainPanel, TrainSheet } from "./TrainCard.tsx";

const NOW = T0 + 30 * MINUTE;
const READY: TrainCardState = { status: "ready", detail: testDetail() };
const S_BAHN_422 = {
  seriesId: "db-422",
  seriesName: "DB Class 422",
  br: "422",
  variant: null,
  units: 2,
  cars: null,
  lengthMetres: 138.86,
  layer: "L2" as const,
  confidence: 0.7,
  source: "wikipedia-de-s-bahn-rhein-ruhr",
  sourceName: "Wikipedia (de), S-Bahn Rhein-Ruhr",
};
const MAP_ACTIONS: TrainActionHandlers = { onFollowChange: vi.fn(), onRoute: vi.fn() };

function wrap(node: ReactNode) {
  return render(<TooltipProvider>{node}</TooltipProvider>);
}

function panel(state: TrainCardState = READY, handlers: TrainActionHandlers = {}, nowMs = NOW) {
  const onClose = vi.fn();
  const view = wrap(
    <TrainPanel state={state} nowMs={nowMs} handlers={handlers} onClose={onClose} />,
  );
  return { ...view, onClose };
}

function byText(text: string): HTMLElement {
  return screen.getByText(
    (_, element) =>
      element?.textContent === text &&
      [...element.children].every((child) => child.textContent !== text),
  );
}

function clockText(text: string): HTMLElement[] {
  return screen.getAllByText(
    (_, element) => element?.classList.contains("num") === true && element.textContent === text,
  );
}

afterEach(async () => {
  cleanup();
  await changeLocale("en", { persist: false });
});

describe("TrainPanel, focus", () => {
  it("takes the focus on its heading when the trains in view list opened it", () => {
    useAppStore.setState({ ...initialState(), selectedId: "live:7" });
    takeCardFocus();
    requestCardFocus("live:7");
    panel();
    const heading = screen.getByRole("heading", { level: 2, name: "ICE 541" });
    expect(document.activeElement).toBe(heading);
    expect(heading.getAttribute("tabindex")).toBe("-1");
  });

  it("does not take the focus for a card the map opened", () => {
    useAppStore.setState({ ...initialState(), selectedId: "live:7" });
    takeCardFocus();
    panel();
    expect(document.activeElement).toBe(document.body);
  });
});

describe("TrainPanel, collapsed", () => {
  it("names the train, its delay, its route and its operator", () => {
    panel();
    expect(screen.getByRole("heading", { level: 2, name: "ICE 541" })).toBeTruthy();
    expect(screen.getByRole("article", { name: "ICE 541" })).toBeTruthy();
    expect(screen.getByText("Line 10")).toBeTruthy();
    expect(screen.getByText("+6")).toBeTruthy();
    expect(screen.getByText("Realtime")).toBeTruthy();
    expect(screen.getByText("To Hannover Hbf")).toBeTruthy();
    expect(screen.getByText("DB Fernverkehr")).toBeTruthy();
  });

  it("says Now before a delay that is the current one rather than a stop's", () => {
    const { container } = panel({
      status: "ready",
      detail: testDetail({ delayBasis: "current", delaySeconds: 60 }),
    });
    const head = container.querySelector("header");
    expect(head?.textContent).toContain("Now +1");
    cleanup();
    const plain = panel();
    expect(plain.container.querySelector("header")?.textContent).not.toContain("Now");
  });

  it("words a title without a product as Train 541 with the line below, never a bare number", async () => {
    panel({ status: "ready", detail: testDetail({ productName: null, line: "10" }) });
    expect(screen.getByRole("heading", { level: 2, name: "Train 541" })).toBeTruthy();
    expect(screen.getByText("Line 10")).toBeTruthy();
    cleanup();
    await changeLocale("de", { persist: false });
    panel({ status: "ready", detail: testDetail({ productName: null, line: "10" }) });
    expect(screen.getByRole("heading", { level: 2, name: "Zug 541" })).toBeTruthy();
  });

  it("steps a long one-word title down so it fits beside the delay", () => {
    panel({
      status: "ready",
      detail: testDetail({ productName: "Weißeritztalbahn", line: "Weißeritztalbahn" }),
    });
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading.textContent).toContain("Weißeritztalbahn");
    expect(heading.className).toContain("text-[22px]");
    cleanup();
    panel();
    expect(screen.getByRole("heading", { level: 2 }).className).toContain("text-[28px]");
  });

  it("shows the last passed stop, Now and the next stop with its changed platform and both times", () => {
    panel();
    const list = screen.getByRole("list", { name: "Stops of this train" });
    expect(within(list).getByText("Berlin-Spandau")).toBeTruthy();
    expect(within(list).getByText("Now")).toBeTruthy();
    expect(within(list).getByText("Stendal Hbf")).toBeTruthy();
    const platform = byText("Platform 8, was 7");
    expect(list.contains(platform)).toBe(true);
    expect([...platform.querySelectorAll(".num")].map((node) => node.textContent)).toEqual([
      "8",
      "7",
    ]);
    expect(clockText("09:46").length).toBeGreaterThan(0);
    const struck = [...list.querySelectorAll("s")].map((s) => s.textContent);
    expect(struck).toEqual(["Scheduled 09:12", "Scheduled 09:40"]);
    expect(within(list).queryByText("Wolfsburg Hbf")).toBeNull();
  });

  it("keeps the vehicle one click deeper and says where the data comes from", () => {
    panel();
    expect(screen.queryByText("Not identified yet")).toBeNull();
    expect(screen.getByText(/Realtime data from DELFI e\.V\. and GTFS\.de\./)).toBeTruthy();
    expect(screen.getByText(/Position is estimated between reports\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "How is the position found?" })).toBeTruthy();
  });

  it("names the vehicle in one line of the collapsed card and swaps it for the block with all stops", () => {
    panel({ status: "ready", detail: testDetail({ vehicle: S_BAHN_422 }) });
    const summary = document.querySelector("[data-slot=vehicle-summary]");
    expect(summary?.textContent).toBe("DB Class 422, 2 units, 139 m");
    expect(screen.queryByRole("region", { name: "Vehicle" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All 5 stops" }));
    expect(document.querySelector("[data-slot=vehicle-summary]")).toBeNull();
    expect(screen.getByRole("region", { name: "Vehicle" })).toBeTruthy();
  });

  it("words the collapsed vehicle line in German and Polish", async () => {
    await changeLocale("de", { persist: false });
    const de = panel({ status: "ready", detail: testDetail({ vehicle: S_BAHN_422 }) });
    expect(document.querySelector("[data-slot=vehicle-summary]")?.textContent).toBe(
      "Baureihe 422, 2 Einheiten, 139 m",
    );
    de.unmount();
    await changeLocale("pl", { persist: false });
    panel({ status: "ready", detail: testDetail({ vehicle: S_BAHN_422 }) });
    expect(document.querySelector("[data-slot=vehicle-summary]")?.textContent).toBe(
      "Seria DB 422, 2 jednostki, 139 m",
    );
  });

  it("leaves a generic guess of layer L4 out of the collapsed line and names it in the block with its confidence", async () => {
    const generic = {
      ...S_BAHN_422,
      seriesId: "generic-sbahn",
      seriesName: "Generic S-Bahn multiple unit",
      br: null,
      units: null,
      lengthMetres: null,
      layer: "L4" as const,
      confidence: 0.1,
      source: "gerlines",
      sourceName: null,
    };
    await changeLocale("pl", { persist: false });
    panel({ status: "ready", detail: testDetail({ vehicle: generic }) });
    expect(document.querySelector("[data-slot=vehicle-summary]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Wszystkie 5 stacji/ }));
    const block = screen.getByRole("region", { name: "Pojazd" });
    expect(block.textContent).toContain("Typowy zespół trakcyjny S-Bahn");
    expect(block.textContent).toContain("Możliwy");
  });

  it("adds no vehicle line to the collapsed card when the vehicle is not identified", () => {
    panel();
    expect(document.querySelector("[data-slot=vehicle-summary]")).toBeNull();
  });

  it("opens all stops with their delays and the missing vehicle", () => {
    panel();
    const toggle = screen.getByRole("button", { name: "All 5 stops" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Fewer stops" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    const list = screen.getByRole("list", { name: "Stops of this train" });
    for (const stop of FIVE_STOPS) {
      expect(within(list).getByText(stop.name)).toBeTruthy();
    }
    const chips = [...list.querySelectorAll("[data-slot=delay-chip]")].map(
      (chip) => chip.textContent,
    );
    expect(chips).toEqual(["Delay +2", "Delay +4", "Delay +6", "Delay +5"]);
    expect(screen.getByText("Not identified yet")).toBeTruthy();
    expect(screen.getByText(/fleet data, which is not connected yet/)).toBeTruthy();
  });

  it("offers Follow, Route and Share and reports a copied link", async () => {
    const onFollowChange = vi.fn();
    const onShare = vi.fn(async () => "copied" as const);
    panel(READY, { following: false, onFollowChange, onRoute: vi.fn(), onShare });
    const follow = screen.getByRole("button", { name: "Follow" });
    expect(follow.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(follow);
    expect(onFollowChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole("button", { name: "Route" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(await screen.findByRole("button", { name: "Link copied" })).toBeTruthy();
  });

  it("keeps one Follow label and says the state with aria-pressed", () => {
    const onFollowChange = vi.fn();
    panel(READY, { following: true, onFollowChange });
    const follow = screen.getByRole("button", { name: "Follow", pressed: true });
    expect(follow.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(follow);
    expect(onFollowChange).toHaveBeenCalledWith(false);
  });

  it("offers each map action only when its handler exists, Share always", () => {
    panel(READY, { onShare: vi.fn(async () => "copied" as const) });
    expect(screen.queryByRole("button", { name: "Follow" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Route" })).toBeNull();
    expect(screen.getByRole("button", { name: "Share" })).toBeTruthy();
  });

  it("closes with the close button", () => {
    const { onClose } = panel();
    fireEvent.click(screen.getByRole("button", { name: "Close train card" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("TrainPanel segment profile", () => {
  it("offers the profile of a train the map draws and not of one it does not", async () => {
    wrap(
      <TrainPanel
        state={{ status: "ready", detail: testDetail() }}
        nowMs={NOW}
        handlers={MAP_ACTIONS}
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByRole("button", { name: "Show segment profile" })).toBeTruthy();
    cleanup();
    wrap(
      <TrainPanel
        state={{
          status: "ready",
          detail: testDetail(),
          freshness: { fetchAgeMs: 0, refreshError: null, notDrawn: true },
        }}
        nowMs={NOW}
        handlers={{}}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Show segment profile" })).toBeNull();
  });
});

describe("TrainPanel states", () => {
  it("shows a timetable only train without delays or struck times", () => {
    const detail = testDetail({
      stops: testStops(FIVE_STOPS, false),
      delaySeconds: null,
      provenance: { ...testDetail().provenance, kind: "timetable", feedObservedAt: null },
    });
    panel({ status: "ready", detail });
    expect(screen.getByText("No data")).toBeTruthy();
    expect(screen.getByText("Timetable only")).toBeTruthy();
    expect(document.querySelector("s")).toBeNull();
    expect(screen.getByText(/Timetable from/)).toBeTruthy();
  });

  it("shows a cancelled train without a position and without Follow", () => {
    panel({ status: "ready", detail: testDetail({ cancelled: true }) });
    expect(screen.getAllByText("Cancelled").length).toBeGreaterThan(0);
    expect(screen.getByText("This train is cancelled and is not shown on the map.")).toBeTruthy();
    expect(screen.queryByText("Now")).toBeNull();
    expect(screen.queryByRole("button", { name: "Follow" })).toBeNull();
    expect(screen.getByRole("button", { name: "Share" })).toBeTruthy();
  });

  it("marks a cancelled stop in the list", () => {
    const specs = FIVE_STOPS.map((spec, i) => (i === 3 ? { ...spec, cancelled: true } : spec));
    panel({ status: "ready", detail: testDetail({ stops: testStops(specs) }) });
    fireEvent.click(screen.getByRole("button", { name: "All 5 stops" }));
    expect(screen.getByText("Stop cancelled")).toBeTruthy();
  });

  it("says when the data is stale", () => {
    const late = new Date(T0 + 29.5 * MINUTE + STALE_AFTER_MS + MINUTE).toISOString();
    panel({ status: "ready", detail: testDetail({ asOf: late }) });
    expect(screen.getByText("Data is stale")).toBeTruthy();
    expect(screen.getByText(/The data is older than three minutes\./)).toBeTruthy();
  });

  it("wraps a long stop name instead of cutting it", () => {
    const long = "Brieskow-Finkenheerd, Kraftwerk Finkenheerd Bahnhof";
    const specs = FIVE_STOPS.map((spec, i) => (i === 2 ? { ...spec, name: long } : spec));
    panel({ status: "ready", detail: testDetail({ stops: testStops(specs) }) });
    const name = screen.getByText(long);
    expect(name.className).toContain("wrap-break-word");
    expect(name.className).not.toContain("truncate");
  });

  it("announces loading", () => {
    panel({ status: "loading" });
    expect(screen.getByRole("status").textContent).toBe("Loading train");
    expect(document.querySelector("[aria-busy=true]")).toBeTruthy();
  });

  it("offers a retry after an error and says when the train is gone", () => {
    const retry = vi.fn();
    const first = panel({ status: "error", retry });
    expect(screen.getByRole("alert").textContent).toContain("This train could not be loaded.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalled();
    first.unmount();
    panel({ status: "not-found" });
    expect(screen.getByText("This train is no longer in the data.")).toBeTruthy();
  });

  it("opens the station card from a stop and goes back", () => {
    panel();
    fireEvent.click(screen.getByRole("button", { name: "Stendal Hbf" }));
    expect(screen.getByRole("heading", { level: 2, name: "Stendal Hbf" })).toBeTruthy();
    expect(screen.getByText("This train")).toBeTruthy();
    expect(screen.getByText("Departures and arrivals")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to ICE 541" }));
    expect(screen.getByRole("heading", { level: 2, name: "ICE 541" })).toBeTruthy();
  });

  it("moves focus to the station heading and back to the stop it came from", () => {
    panel();
    fireEvent.click(screen.getByRole("button", { name: "All 5 stops" }));
    fireEvent.click(screen.getByRole("button", { name: "Wolfsburg Hbf" }));
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 2, name: "Wolfsburg Hbf" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to ICE 541" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Wolfsburg Hbf" }));
    expect(screen.getByRole("button", { name: "Fewer stops" })).toBeTruthy();
  });

  it("brings the Now row into view when all stops open and keeps the toggle in sight", () => {
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      panel();
      fireEvent.click(screen.getByRole("button", { name: "All 5 stops" }));
      expect(scrolled.map((node) => node.getAttribute("data-slot"))).toContain("between");
      const toggle = screen.getByRole("button", { name: "Fewer stops" });
      expect(toggle.parentElement?.className).toContain("sticky");
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("shows each station line with its own delay and drops the number a struck time already says", () => {
    const stops = testStops(FIVE_STOPS).map((stop) =>
      stop.index === 3
        ? {
            ...stop,
            predictedArrival: stop.scheduledArrival,
            arrivalDelaySeconds: 20,
            predictedDeparture: new Date(T0 + 74 * MINUTE).toISOString(),
            departureDelaySeconds: 120,
          }
        : stop,
    );
    wrap(
      <TrainPanel
        state={{ status: "ready", detail: testDetail({ stops }) }}
        nowMs={NOW}
        handlers={{}}
        onClose={() => undefined}
        defaultStationIndex={3}
      />,
    );
    const lines = screen.getByRole("region", { name: "This train" });
    expect(within(lines).getByText("On time")).toBeTruthy();
    expect(within(lines).queryByText("+2")).toBeNull();
    expect(within(lines).queryByText("+0")).toBeNull();
    expect([...lines.querySelectorAll("s")].map((node) => node.textContent)).toEqual([
      "Scheduled 10:12",
    ]);
  });

  it("says where a train ends early in the head", () => {
    const specs = FIVE_STOPS.map((spec, i) => (i >= 3 ? { ...spec, cancelled: true } : spec));
    panel({ status: "ready", detail: testDetail({ stops: testStops(specs) }) });
    expect(screen.getByText("Ends at Stendal Hbf, 2 stops cancelled")).toBeTruthy();
  });

  it("says when updating fails while it keeps the last data", () => {
    panel({
      status: "ready",
      detail: testDetail(),
      freshness: { fetchAgeMs: 20_000, refreshError: "unreachable" },
    });
    expect(screen.getByText(/Updating failed, trying again\./)).toBeTruthy();
  });

  it("marks a time on the next day", () => {
    const detail = testDetail({
      progress: { lastPassedIndex: 0, nextIndex: 1 },
      stops: testStops([
        { name: "Hamburg", departure: 13 * 60, delay: 0 },
        { name: "Hannover", arrival: 14 * 60 + 30, departure: 14 * 60 + 35, delay: 0 },
        { name: "Basel SBB", arrival: 22 * 60, delay: 0 },
      ]),
    });
    panel({ status: "ready", detail }, {}, T0 + 13 * 60 * MINUTE + 10 * MINUTE);
    fireEvent.click(screen.getByRole("button", { name: "All 3 stops" }));
    expect(screen.getByText("next day")).toBeTruthy();
  });

  it("speaks German and Polish", async () => {
    await changeLocale("de", { persist: false });
    const de = panel(READY, MAP_ACTIONS);
    expect(byText("Gleis 8 statt 7")).toBeTruthy();
    expect(screen.getByText(/DELFI e\.V\. und GTFS\.de/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Alle 5 Halte" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Folgen" })).toBeTruthy();
    de.unmount();
    await changeLocale("pl", { persist: false });
    panel();
    expect(byText("Peron 8 zamiast 7")).toBeTruthy();
    expect(screen.getByText("Kierunek Hannover Hbf")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Wszystkie 5 stacji" })).toBeTruthy();
  });
});

describe("TrainSheet", () => {
  function sheet(defaultExpanded = false) {
    return wrap(
      <TrainSheet
        state={READY}
        nowMs={NOW}
        handlers={MAP_ACTIONS}
        onClose={() => undefined}
        defaultExpanded={defaultExpanded}
      />,
    );
  }

  it("keeps the train number in the peek for a train titled by its line", () => {
    wrap(
      <TrainSheet
        state={{
          status: "ready",
          detail: testDetail({
            category: "rfast",
            productName: null,
            line: "RE6",
            trainNumber: "3627",
          }),
        }}
        nowMs={NOW}
        handlers={MAP_ACTIONS}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "RE6" })).toBeTruthy();
    expect(screen.getByText("Train 3627")).toBeTruthy();
  });

  it("names the last stop as the destination and adds a bracketed headsign note", () => {
    wrap(
      <TrainSheet
        state={{
          status: "ready",
          detail: testDetail({ headsign: "Hauptbahnhof (Umleitung)" }),
        }}
        nowMs={NOW}
        handlers={MAP_ACTIONS}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText("To Hannover Hbf (Umleitung)")).toBeTruthy();
  });

  it("shows a short run in the peek", () => {
    const specs = FIVE_STOPS.map((spec, i) => (i >= 3 ? { ...spec, cancelled: true } : spec));
    wrap(
      <TrainSheet
        state={{ status: "ready", detail: testDetail({ stops: testStops(specs) }) }}
        nowMs={NOW}
        handlers={{}}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText("Ends at Stendal Hbf, 2 stops cancelled")).toBeTruthy();
  });

  it("keeps the category badge beside the handle when it fits and moves it to its own row when not", () => {
    const badgeWidth = { value: 80 };
    const scroll = vi
      .spyOn(HTMLElement.prototype, "scrollWidth", "get")
      .mockImplementation(() => badgeWidth.value);
    const client = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(118);
    try {
      sheet();
      const region = screen.getByRole("region", { name: "Selected train" });
      const head = region.querySelector("[data-slot=bottom-sheet-head]") as HTMLElement;
      expect(within(head).getByText("High speed")).toBeTruthy();
      expect(region.querySelector("header")?.textContent).not.toContain("High speed");
      cleanup();

      badgeWidth.value = 156;
      sheet();
      const moved = screen.getByRole("region", { name: "Selected train" });
      const headCopy = moved.querySelector("[data-slot=bottom-sheet-head] [aria-hidden=true]");
      expect(headCopy?.className).toContain("invisible");
      expect(moved.querySelector("header")?.textContent).toContain("High speed");
    } finally {
      scroll.mockRestore();
      client.mockRestore();
    }
  });

  it("keeps the peek to the key facts and the actions", () => {
    sheet();
    expect(screen.getByText("To Hannover Hbf")).toBeTruthy();
    expect(screen.queryByText("DB Fernverkehr")).toBeNull();
    expect(screen.queryByText("Realtime")).toBeNull();
    expect(screen.queryByText("Berlin-Spandau")).toBeNull();
    expect(screen.getByText("Stendal Hbf")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Follow" })).toBeTruthy();
  });

  it("shows every stop, the vehicle and the provenance when expanded", () => {
    sheet(true);
    const list = screen.getByRole("list", { name: "Stops of this train" });
    expect(within(list).getAllByRole("listitem").length).toBe(6);
    expect(screen.getByText("Not identified yet")).toBeTruthy();
    expect(screen.getByText("DB Fernverkehr")).toBeTruthy();
  });
});

describe("TrainSheet, expanded and scrolled", () => {
  type Entry = { isIntersecting: boolean; target: Element };
  let observers: Array<{
    callback: (entries: Entry[]) => void;
    target: Element | null;
    live: boolean;
  }> = [];

  function stubObserver() {
    observers = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        private readonly record: (typeof observers)[number];
        constructor(callback: (entries: Entry[]) => void) {
          this.record = { callback, target: null, live: true };
          observers.push(this.record);
        }
        observe(target: Element) {
          this.record.target = target;
        }
        disconnect() {
          this.record.live = false;
        }
      },
    );
  }

  function sheetAt(expanded: boolean, state: TrainCardState = READY) {
    stubObserver();
    return wrap(
      <TrainSheet
        state={state}
        nowMs={NOW}
        handlers={MAP_ACTIONS}
        onClose={() => undefined}
        defaultExpanded={expanded}
      />,
    );
  }

  function scrollHead(visible: boolean) {
    act(() => {
      for (const observer of observers) {
        if (observer.live && observer.target) {
          observer.callback([{ isIntersecting: visible, target: observer.target }]);
        }
      }
    });
  }

  const bar = () => document.querySelector("[data-slot=stuck-title]") as HTMLElement | null;
  const handle = () => document.querySelector("[data-slot=bottom-sheet-handle]") as HTMLElement;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pins the title and the delay once the card head has scrolled away, and not before", () => {
    sheetAt(true);
    expect(bar()).toBeNull();

    scrollHead(false);
    expect(bar()?.textContent).toContain("ICE 541");
    expect(bar()?.textContent).toContain("+6");
    expect(bar()?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getAllByRole("heading", { level: 2, name: "ICE 541" })).toHaveLength(1);

    scrollHead(true);
    expect(bar()).toBeNull();
  });

  it("draws the pinned delay at the size of the pinned title, never at the head's display size", () => {
    sheetAt(true);
    scrollHead(false);

    const delay = [...(bar() as HTMLElement).querySelectorAll("span.inline-block")].find((span) =>
      span.textContent?.startsWith("+6"),
    ) as HTMLElement;
    expect(delay.className).toContain("type-body-strong");
    expect(delay.className).not.toContain("text-[28px]");
  });

  it("stacks the bar above the stop markers and above the sticky bars at the bottom of the card", () => {
    sheetAt(true);
    scrollHead(false);
    const zOf = (element: Element) =>
      Number(/(?:^| )z-(\d+)(?: |$)/.exec(element.className)?.[1] ?? 0);
    const marker = document.querySelector("[data-slot=stop-marker]");
    const others = [...document.querySelectorAll(".sticky")].filter((element) => element !== bar());

    expect(marker).not.toBeNull();
    expect(others.length).toBeGreaterThan(0);
    const bar_ = bar() as HTMLElement;
    for (const other of [marker as Element, ...others]) {
      expect(zOf(bar_)).toBeGreaterThan(zOf(other));
    }
  });

  it("pins the bar in a sheet that opened in the peek and was expanded with the handle", () => {
    sheetAt(false);
    expect(bar()).toBeNull();

    fireEvent.click(handle());
    scrollHead(false);
    expect(bar()?.textContent).toContain("ICE 541");
  });

  it("shows no bar over a visible head after expanded, peek, expanded", () => {
    sheetAt(true);
    scrollHead(false);
    expect(bar()).not.toBeNull();

    fireEvent.click(handle());
    expect(bar()).toBeNull();
    fireEvent.click(handle());
    expect(bar()).toBeNull();

    scrollHead(false);
    expect(bar()).not.toBeNull();
    scrollHead(true);
    expect(bar()).toBeNull();
  });

  it("watches the title, so the bar takes over as soon as the title is gone", () => {
    sheetAt(true);
    const watched = observers.find((observer) => observer.live)?.target;

    expect(watched?.tagName).toBe("H2");
  });

  it("has no accessibility violations with the bar pinned", async () => {
    const { container } = sheetAt(true);
    scrollHead(false);
    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
    });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });

  it("names a cancelled train in the bar instead of a delay", () => {
    sheetAt(true, { status: "ready", detail: testDetail({ cancelled: true }) });
    scrollHead(false);

    expect(bar()?.textContent).toContain("Cancelled");
  });
});

describe("TrainPanel, scrolled on a desktop", () => {
  type Entry = { isIntersecting: boolean; target: Element };
  let callbacks: Array<(entries: Entry[]) => void> = [];

  function scrollHead(visible: boolean) {
    act(() => {
      for (const callback of callbacks) {
        callback([{ isIntersecting: visible, target: document.body }]);
      }
    });
  }

  const bar = () => document.querySelector("[data-slot=stuck-title]") as HTMLElement | null;

  beforeEach(() => {
    callbacks = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: (entries: Entry[]) => void) {
          callbacks.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the title, the delay and Close in view once the head has scrolled away", () => {
    const { onClose } = panel();
    expect(bar()).toBeNull();

    scrollHead(false);
    expect(bar()?.textContent).toContain("ICE 541");
    expect(bar()?.textContent).toContain("+6");
    const close = within(bar() as HTMLElement).getByRole("button", { name: "Close train card" });
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);

    scrollHead(true);
    expect(bar()).toBeNull();
  });

  it("gives the focus to the Close button of the head when the bar under it goes away", () => {
    panel();
    scrollHead(false);
    const pinned = within(bar() as HTMLElement).getByRole("button", { name: "Close train card" });
    pinned.focus();
    expect(document.activeElement).toBe(pinned);

    scrollHead(true);

    expect(bar()).toBeNull();
    const [head] = screen.getAllByRole("button", { name: "Close train card" });
    expect(document.activeElement).toBe(head);
  });

  it("leaves the focus alone when the bar goes away while the focus is elsewhere", () => {
    panel(READY, MAP_ACTIONS);
    scrollHead(false);
    const follow = screen.getByRole("button", { name: "Follow" });
    follow.focus();
    scrollHead(true);
    expect(document.activeElement).toBe(follow);
  });

  it("scrolls a focused row clear of the pinned bar", () => {
    panel();
    const scroller = document.querySelector("article .overflow-y-auto") as HTMLElement;
    expect(scroller.className.split(" ")).toContain("scroll-pt-12");
  });

  it("hides only the title from assistive technology, never the button inside the bar", async () => {
    const { container } = panel();
    scrollHead(false);
    expect(bar()?.getAttribute("aria-hidden")).toBeNull();
    expect(bar()?.querySelector("[aria-hidden=true]")?.textContent).toContain("ICE 541");
    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
    });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });
});

describe("accessibility (axe-core, colour contrast is checked in the browser)", () => {
  it.each([
    ["collapsed panel", () => panel()],
    ["loading panel", () => panel({ status: "loading" })],
    ["error panel", () => panel({ status: "error", retry: () => undefined })],
    [
      "expanded sheet",
      () =>
        wrap(
          <TrainSheet
            state={READY}
            nowMs={NOW}
            handlers={{}}
            onClose={() => undefined}
            defaultExpanded
          />,
        ),
    ],
  ])("has no violations in the %s", async (_name, show) => {
    const { container } = show();
    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
    });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });
});
