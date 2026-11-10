// @vitest-environment happy-dom
import { changeLocale } from "@gerlines/i18n";
import type { StatsDelayBin, StatsNetwork, StatsTrain } from "@gerlines/schema/stats";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPanelStore, usePanelStore } from "../state/panel-store.ts";
import { initialState, useAppStore } from "../state/store.ts";
import land from "./fixtures/land-by-2025-11.json" with { type: "json" };
import network from "./fixtures/network-2025-11.json" with { type: "json" };
import station from "./fixtures/station-2025-11.json" with { type: "json" };
import today from "./fixtures/today.json" with { type: "json" };
import train from "./fixtures/train-596-2025-11.json" with { type: "json" };
import { binClass } from "./model.ts";
import { StatsBody } from "./StatsBody.tsx";
import StatsPanel from "./StatsPanel.tsx";
import { initialStatsState, useStatsStore } from "./store.ts";

const NET = network as unknown as StatsNetwork;
const NOVEMBER = { kind: "month", year: 2025, month: 11 } as const;

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

vi.mock("./use-laender.ts", () => ({
  useLaender: () => [
    { code: "DE-BY", names: { en: "Bavaria", de: "Bayern", pl: "Bawaria" } },
    { code: "DE-HH", names: { en: "Hamburg", de: "Hamburg", pl: "Hamburg" } },
  ],
}));

interface Call {
  readonly url: string;
}

function stubApi(answer: (url: string) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (input.startsWith("/api/v1/stats")) calls.push({ url: input });
      return answer(input);
    }),
  );
  return calls;
}

function byFixture(url: string): Response {
  if (url.includes("/lands/")) return respond(200, land);
  if (url.includes("/stations/")) return respond(200, station);
  if (url.includes("/trains/")) return respond(200, train);
  if (url.endsWith("/today")) return respond(200, today);
  return respond(200, network);
}

const en = (value: number, digits = 0) =>
  new Intl.NumberFormat("en", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: true,
  }).format(value);
/** A fraction num/den in percent with one decimal, rounded half up on exact integers. */
const tenthsOf = (num: number, den: number) => Math.floor((2 * num * 1000 + den) / (2 * den));
const digitsOf = (num: number, den: number) =>
  `${Math.floor(tenthsOf(num, den) / 10)}.${tenthsOf(num, den) % 10}`;
const percentDigits = (share: number) => digitsOf(Math.round(share * 10_000), 10_000);
const percent = (share: number) => `${percentDigits(share)}%`;
const percentOfCount = (sum: number, total: number) => `${digitsOf(sum, total)}%`;

function textOf(element: HTMLElement): string {
  return (element.textContent ?? "").replaceAll(" ", " ").replace(/\s+/g, " ").trim();
}

function row(label: string): HTMLElement {
  const term = screen.getByText(label, { selector: "dt" });
  const parent = term.parentElement;
  if (parent === null) throw new Error(`no row for ${label}`);
  return parent;
}

beforeEach(async () => {
  await changeLocale("en");
  useAppStore.setState(initialState());
  resetPanelStore();
  usePanelStore.getState().open("stats");
  useStatsStore.setState({ ...initialStatsState(), period: NOVEMBER });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Germany over a month", () => {
  it("shows every figure exactly as the API answers", async () => {
    const calls = stubApi(byFixture);
    render(<StatsPanel phone={false} />);
    await screen.findByTestId("punctual6");

    expect(calls[0]?.url).toBe("/api/v1/stats/period?from=2025-11-01&to=2025-11-30");
    const s = NET.summary;
    expect(textOf(screen.getByTestId("punctual6"))).toBe(percentDigits(s.punctual6 as number));
    expect(screen.queryByText(`of ${en(s.observedArrivals)} observed arrivals`)).toBeNull();
    expect(textOf(row("Observed arrivals"))).toContain(en(s.observedArrivals));
    expect(textOf(row("Less than 16 minutes late"))).toContain(percent(s.punctual16 as number));
    expect(textOf(row("Cancelled stops"))).toContain(en(s.cancelled));
    expect(textOf(row("Cancelled stops"))).toContain(percent(s.cancelledShare as number));
    expect(textOf(row("Mean delay"))).toContain(
      `${en(Math.round((s.meanDelayS as number) / 6) / 10, 1)} min`,
    );
    expect(textOf(row("Median delay"))).toContain(
      `${en(Math.round((s.medianDelayS as number) / 6) / 10, 1)} min`,
    );
    expect(textOf(row("90th percentile"))).toContain(
      `${en(Math.round((s.p90DelayS as number) / 6) / 10, 1)} min`,
    );
    expect(textOf(row("Longest delay"))).toContain("4 h 59 min");
  });

  it("lists each category with its own share and arrivals", async () => {
    stubApi(byFixture);
    render(<StatsPanel phone={false} />);
    const list = await screen.findByRole("list", { name: "By category" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(6);
    for (const entry of NET.byCategory) {
      const item = list.querySelector<HTMLElement>(`[data-category="${entry.category}"]`);
      expect(item).not.toBeNull();
      expect(textOf(item as HTMLElement)).toContain(percent(entry.summary.punctual6 as number));
      expect(textOf(item as HTMLElement)).toContain(
        `${en(entry.summary.observedArrivals)} arrivals`,
      );
    }
  });

  it("centres each category dot on the first line of its label, so a wrapped label keeps the dot at the top", async () => {
    stubApi(byFixture);
    render(<StatsPanel phone={false} />);
    const list = await screen.findByRole("list", { name: "By category" });
    const dots = list.querySelectorAll<HTMLElement>('[data-slot="category-dot"]');
    expect(dots).toHaveLength(6);
    for (const dot of dots) {
      expect(dot.className).toContain("h-[1lh]");
      expect(dot.className).toContain("self-start");
    }
  });

  it("names the map categories the answer has no row for, with no data instead of leaving them out", async () => {
    stubApi(byFixture);
    render(<StatsPanel phone={false} />);
    const list = await screen.findByRole("list", { name: "By category" });
    for (const missing of ["rfast", "reg", "sbahn"]) {
      const item = list.querySelector<HTMLElement>(`[data-category="${missing}"]`);
      expect(textOf(item as HTMLElement)).toContain("No data");
      expect(item?.querySelector('[data-slot="category-bar"]')).toBeNull();
    }
    expect(screen.getByText(/The headline counts every category above that has data/)).toBeTruthy();
  });

  it("paints each category bar from the map colours and night as the outlined bar of the legend", async () => {
    stubApi(byFixture);
    render(<StatsPanel phone={false} />);
    const list = await screen.findByRole("list", { name: "By category" });
    const bar = (category: string) =>
      list.querySelector<HTMLElement>(`[data-category="${category}"] [data-slot="category-bar"]`);
    expect(bar("hsr")?.style.backgroundColor).toBe("var(--gl-cat-hsr)");
    expect(bar("ld")?.style.backgroundColor).toBe("var(--gl-cat-ld)");
    expect(bar("night")?.style.backgroundColor).toBe("transparent");
    expect(bar("night")?.style.borderColor).toBe("var(--gl-cat-hsr)");
    expect(list.innerHTML).not.toContain("--gl-cat-night");
  });

  it("draws the delay bars per minute, so the wide bins after 16 minutes show no bump", async () => {
    stubApi(byFixture);
    render(<StatsPanel phone={false} />);
    await screen.findByTestId("punctual6");
    const chart = screen.getByRole("group", { name: "Delay distribution" });
    const heights = Array.from(chart.querySelectorAll<SVGPathElement>("path[data-bin]")).map(
      (bar) => Number(bar.dataset.height),
    );
    expect(heights).toHaveLength(NET.delayHistogram.length);
    const at = (fromS: number) =>
      heights[NET.delayHistogram.findIndex((bin) => bin.fromS === fromS)] ?? Number.NaN;
    expect(at(960)).toBeLessThan(at(900));
    expect(at(1200)).toBeLessThan(at(960));
    expect(at(3600)).toBeLessThan(at(1800));
    const peak = Math.max(...heights);
    expect(at(0)).toBe(peak);
    expect(chart.querySelector('[data-slot="axis-break"]')).not.toBeNull();
    const labels = Array.from(chart.querySelectorAll("text"))
      .map((text) => text.textContent)
      .filter((text) => text !== null && !text.includes("%"));
    expect(labels).toEqual(["\u221230", "\u22125", "0", "5", "10", "16", "60", "120+"]);
    expect(chart.querySelectorAll('[data-slot="axis-break"]')).toHaveLength(2);
  });

  it("sums the delay legend from the histogram bins and the shares add to the observed stops", async () => {
    stubApi(byFixture);
    render(<StatsPanel phone={false} />);
    const legend = await screen.findByRole("list", { name: "Share of observed stops" });
    const sums: Record<string, number> = { ok: 0, minor: 0, major: 0, severe: 0 };
    for (const bin of NET.delayHistogram as StatsDelayBin[]) {
      const key = binClass(bin);
      sums[key] = (sums[key] ?? 0) + bin.count;
    }
    const total = NET.summary.observed;
    expect(Object.values(sums).reduce((a, b) => a + b, 0)).toBe(total);
    const items = within(legend).getAllByRole("listitem");
    const expected = [
      ["On time, under 3 min", sums.ok],
      ["Late, 3 to 5 min", sums.minor],
      ["Late, 6 to 14 min", sums.major],
      ["Late, 15 min or more", sums.severe],
    ] as const;
    expect(items).toHaveLength(expected.length);
    expected.forEach(([name, sum], index) => {
      const text = textOf(items[index] as HTMLElement);
      expect(text).toContain(name);
      expect(text).toContain(percentOfCount(sum as number, total));
    });
  });

  it("offers every chart as a table with the same values", async () => {
    stubApi(byFixture);
    const user = userEvent.setup();
    render(<StatsPanel phone={false} />);
    await screen.findByTestId("punctual6");
    await user.click(screen.getByRole("button", { name: "Show tables instead of charts" }));
    const hours = await screen.findByRole("table", { name: "By hour of day" });
    const body = within(hours).getAllByRole("row").slice(1);
    expect(body).toHaveLength(24);
    for (const entry of NET.byHour) {
      const cells = within(body[entry.hour] as HTMLElement).getAllByRole("cell");
      expect(textOf(cells[0] as HTMLElement)).toBe(percent(entry.punctual6 as number));
      expect(textOf(cells[1] as HTMLElement)).toBe(en(entry.observedArrivals));
    }
    const bins = within(screen.getByRole("table", { name: "Delay distribution" }))
      .getAllByRole("row")
      .slice(1);
    expect(bins).toHaveLength(NET.delayHistogram.length);
    const first = within(bins[0] as HTMLElement).getAllByRole("cell");
    expect(textOf(first[0] as HTMLElement)).toBe(en(NET.delayHistogram[0]?.count ?? 0));
    const days = within(screen.getByRole("table", { name: "By day" }))
      .getAllByRole("row")
      .slice(1);
    expect(days).toHaveLength(NET.byDay.length);
  });

  it("reads a chart bar to a screen reader with the arrow keys", async () => {
    stubApi(byFixture);
    render(<StatsPanel phone={false} />);
    const chart = await screen.findByRole("group", { name: "Delay distribution" });
    chart.focus();
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    const first = NET.delayHistogram[0] as StatsDelayBin;
    await waitFor(() => {
      const live = chart.querySelector("[aria-live]");
      expect(textOf(live as HTMLElement)).toContain(en(first.count));
    });
    expect(chart.querySelector("[data-slot=chart-tip]")).not.toBeNull();
  });

  it("shows the source, the refresh state and the lag from the API's own fields", async () => {
    stubApi(byFixture);
    render(<StatsPanel phone={false} />);
    await screen.findByTestId("punctual6");
    expect(screen.getByText("The time of the last refresh is not known.")).toBeTruthy();
    expect(
      screen.getByText(
        `Statistics are up to about ${NET.freshness.maxLagMinutes} minutes behind the live map.`,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Source: arrival and departure records/)).toBeTruthy();
    const method = screen.getByText("How this is measured").closest("details") as HTMLElement;
    expect(NET.outsideGermany.unassignedStops).toBe(0);
    expect(textOf(method)).toContain(
      `Not counted: ${en(NET.outsideGermany.foreignStops)} stops abroad.`,
    );
    expect(textOf(method)).not.toContain("without a state");
  });
});

describe("phone sheet", () => {
  it("names its handle after the statistics, not after a train", async () => {
    stubApi(byFixture);
    render(<StatsPanel phone />);
    const handle = document.querySelector<HTMLElement>("[data-slot=bottom-sheet-handle]");
    expect(handle?.getAttribute("aria-label")).toBe("Show more statistics");
  });
});

describe("freshness", () => {
  it("shows the refresh time the API gives, in Berlin time", async () => {
    const refreshed = {
      ...network,
      freshness: { ...network.freshness, refreshedAt: "2025-12-01T10:20:00.000Z" },
    };
    stubApi(() => respond(200, refreshed));
    render(<StatsPanel phone={false} />);
    await screen.findByTestId("punctual6");
    expect(screen.getByText("Last refresh 11:20, 1 December.")).toBeTruthy();
    expect(screen.queryByText("The time of the last refresh is not known.")).toBeNull();
  });
});

describe("missing data", () => {
  it("says why a period has nothing instead of showing zeros", async () => {
    useStatsStore.setState({ period: { kind: "today" } });
    const calls = stubApi(byFixture);
    render(<StatsPanel phone={false} />);
    expect(await screen.findByText("No data for this period")).toBeTruthy();
    expect(calls[0]?.url).toBe("/api/v1/stats/today");
    expect(screen.getByText("No stop was recorded here in this period.")).toBeTruthy();
    expect(screen.queryByTestId("punctual6")).toBeNull();
    expect(screen.queryByRole("group", { name: "Delay distribution" })).toBeNull();
  });

  it("shows No data for a share that is null and keeps the counts that exist", async () => {
    const quiet = {
      ...network,
      summary: {
        ...network.summary,
        observed: 0,
        observedArrivals: 0,
        punctual6: null,
        punctual16: null,
        meanDelayS: null,
        medianDelayS: null,
        p90DelayS: null,
        maxDelayS: null,
      },
      delayHistogram: network.delayHistogram.map((bin) => ({ ...bin, count: 0 })),
      byCategory: [],
      byHour: [],
      byDay: [],
    };
    stubApi(() => respond(200, quiet));
    render(<StatsPanel phone={false} />);
    expect(
      await screen.findByText("Stops were recorded, but none has an observed realtime value."),
    ).toBeTruthy();
    expect(textOf(row("Mean delay"))).toContain("No data");
    expect(textOf(row("Cancelled stops"))).toContain(en(NET.summary.cancelled));
  });
});

describe("failures", () => {
  it("names each failure and retries on request", async () => {
    let answer = respond(503, { error: "not_configured" });
    const calls = stubApi(() => answer.clone());
    const user = userEvent.setup();
    render(<StatsPanel phone={false} />);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Statistics are not available on this server.",
    );
    answer = respond(200, network);
    expect(screen.getByText("1 November 2025 to 30 November 2025, 30 days")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByTestId("punctual6");
    expect(calls).toHaveLength(2);
  });

  it("holds the retry button for the seconds a limited answer asks for", async () => {
    stubApi(
      () =>
        new Response(JSON.stringify({ error: "rate_limited" }), {
          status: 429,
          headers: { "retry-after": "30" },
        }),
    );
    render(<StatsPanel phone={false} />);
    const wait = await screen.findByRole("button", { name: "Try again in 30 s" });
    expect((wait as HTMLButtonElement).disabled).toBe(true);
    expect((await screen.findByRole("alert")).textContent).toContain("Too many requests");
  });

  it("shows a loading status first", async () => {
    stubApi(() => new Promise<Response>(() => undefined));
    render(<StatsPanel phone={false} />);
    const status = await screen.findByText("Loading statistics");
    expect(status.closest('[role="status"]')).not.toBeNull();
    expect(status.className).not.toContain("sr-only");
  });
});

describe("one Land, one station, one train", () => {
  it("shows a Land with its own figures and focuses it on the map", async () => {
    useStatsStore.setState({ area: { kind: "land", code: "DE-BY" }, kind: "land" });
    const calls = stubApi(byFixture);
    render(<StatsPanel phone={false} />);
    await screen.findByTestId("punctual6");
    expect(calls[0]?.url).toBe("/api/v1/stats/lands/DE-BY?from=2025-11-01&to=2025-11-30");
    expect(textOf(screen.getByTestId("punctual6"))).toBe(percentDigits(land.summary.punctual6));
    expect(useAppStore.getState().focusLand).toBe("DE-BY");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Bavaria");
  });

  it("shows a station with its departures and operators", async () => {
    useStatsStore.setState({
      area: { kind: "station", id: station.station.id, name: station.station.name },
      kind: "station",
    });
    stubApi(byFixture);
    render(<StatsPanel phone={false} />);
    await screen.findByTestId("punctual6");
    const departures = document.querySelector("[data-slot=departures]") as HTMLElement;
    expect(textOf(departures)).toContain(en(station.departures.observed));
    expect(textOf(departures)).toContain(percent(station.departures.punctual6));
    const operators = screen
      .getByRole("heading", { name: "By operator" })
      .closest("section") as HTMLElement;
    const first = station.byOperator[0];
    expect(textOf(operators)).toContain(first?.operator?.name ?? "");
    expect(textOf(operators)).toContain(percent(first?.summary.punctual6 as number));
  });

  it("shows a train number with its runs, operator and category", async () => {
    useStatsStore.setState({ area: { kind: "train", number: "596" }, kind: "train" });
    stubApi(byFixture);
    render(<StatsPanel phone={false} />);
    await screen.findByTestId("punctual6");
    const group = train.groups[0];
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Train 596");
    expect(textOf(row("Runs"))).toContain(en(group?.runs ?? 0));
    expect(textOf(screen.getByTestId("punctual6"))).toBe(
      percentDigits(group?.summary.punctual6 as number),
    );
    expect(screen.getByText("DB Fernverkehr AG, ICE and high speed")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "By hour of day" })).toBeNull();
  });

  it("names the train by the product its lines carry, and by the number alone when they carry none", async () => {
    useStatsStore.setState({ area: { kind: "train", number: "596" }, kind: "train" });
    const withLine = {
      ...train,
      groups: train.groups.map((group) => ({ ...group, line: "ICE" })),
    };
    stubApi((url) => (url.includes("/trains/") ? respond(200, withLine) : byFixture(url)));
    render(<StatsPanel phone={false} />);
    await screen.findByTestId("punctual6");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("ICE 596");
  });

  it("waits for a station, line or train before it asks the API", async () => {
    useStatsStore.setState({ kind: "train", area: null });
    const calls = stubApi(byFixture);
    render(<StatsPanel phone={false} />);
    expect(await screen.findByLabelText("Train number")).toBeTruthy();
    expect(calls).toHaveLength(0);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Train number"), "596{Enter}");
    await screen.findByTestId("punctual6");
    expect(calls[0]?.url).toContain("/api/v1/stats/trains/596");
  });

  it("shows an empty state select with a prompt instead of a blank field", async () => {
    useStatsStore.setState({ kind: "land", area: null });
    const calls = stubApi(byFixture);
    render(<StatsPanel phone={false} />);
    const select = (await screen.findByLabelText("Choose a German state")) as HTMLSelectElement;
    expect(select.selectedOptions[0]?.textContent).toBe("No state picked yet");
    expect(calls).toHaveLength(0);
  });

  it("tells what to type into the line and train fields", async () => {
    useStatsStore.setState({ kind: "line", area: null });
    stubApi(byFixture);
    const view = render(<StatsPanel phone={false} />);
    expect(
      await screen.findByText(/A line name as shown on the train, for example RE5/),
    ).toBeTruthy();
    view.unmount();
    useStatsStore.setState({ kind: "train", area: null });
    render(<StatsPanel phone={false} />);
    expect(await screen.findByText("A train number, for example 596.")).toBeTruthy();
  });

  it("refuses a train number the API would refuse", async () => {
    useStatsStore.setState({ kind: "train", area: null });
    const calls = stubApi(byFixture);
    const user = userEvent.setup();
    render(<StatsPanel phone={false} />);
    await user.type(screen.getByLabelText("Train number"), "12 34{Enter}");
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Use letters and digits, at most 12 characters.",
    );
    expect(calls).toHaveLength(0);
  });
});

describe("period", () => {
  it("asks for a custom range and refuses one that is back to front", async () => {
    useStatsStore.setState({ period: { kind: "custom", from: "2025-11-03", to: "2025-11-09" } });
    const calls = stubApi(byFixture);
    render(<StatsPanel phone={false} />);
    await screen.findByTestId("punctual6");
    expect(calls[0]?.url).toBe("/api/v1/stats/period?from=2025-11-03&to=2025-11-09");
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2025-11-20" } });
    expect(await screen.findByText("The first day is after the last day.")).toBeTruthy();
    expect(calls).toHaveLength(1);
  });

  it("steps through months", async () => {
    const calls = stubApi(byFixture);
    const user = userEvent.setup();
    render(<StatsPanel phone={false} />);
    await screen.findByTestId("punctual6");
    await user.click(screen.getByRole("button", { name: "Previous month" }));
    await waitFor(() =>
      expect(calls.at(-1)?.url).toBe("/api/v1/stats/period?from=2025-10-01&to=2025-10-31"),
    );
  });
});

describe("desktop head", () => {
  it("stays at the top of the card while the results scroll, with the close and table buttons in it", async () => {
    stubApi(byFixture);
    render(<StatsPanel phone={false} />);
    await screen.findByTestId("punctual6");
    const head = document.querySelector<HTMLElement>("[data-slot=stats-head]");
    expect(head?.className).toContain("sticky");
    expect(head?.className).toContain("top-0");
    expect(
      within(head as HTMLElement).getByRole("button", { name: "Close statistics" }),
    ).toBeTruthy();
    expect(
      within(head as HTMLElement).getByRole("button", { name: "Show tables instead of charts" }),
    ).toBeTruthy();
  });
});

describe("area tabs in the head", () => {
  it("sit in the sticky desktop head, still tied to their panel, and switch the area", async () => {
    stubApi(byFixture);
    render(<StatsPanel phone={false} />);
    await screen.findByTestId("punctual6");
    const head = document.querySelector<HTMLElement>("[data-slot=stats-head]") as HTMLElement;
    const tabs = within(head).getByRole("tablist", { name: "Area" });
    expect(within(tabs).getAllByRole("tab")).toHaveLength(5);
    const station = within(tabs).getByRole("tab", { name: "Station" });
    await userEvent.setup().click(station);
    expect(station.getAttribute("aria-selected")).toBe("true");
    const panel = document.getElementById(station.getAttribute("aria-controls") as string);
    expect(panel?.getAttribute("role")).toBe("tabpanel");
    expect(head.contains(panel)).toBe(false);
  });

  it("stay in the scrolling content of the phone sheet", async () => {
    stubApi(byFixture);
    render(<StatsPanel phone />);
    expect(document.querySelector("[data-slot=stats-head]")).toBeNull();
    const sheet = document.querySelector<HTMLElement>("[data-slot=bottom-sheet]") as HTMLElement;
    expect(within(sheet).getByRole("tablist", { name: "Area" })).toBeTruthy();
  });
});

describe("tabs have panels", () => {
  function expectPanelsResolve(): void {
    for (const tab of screen.getAllByRole("tab")) {
      const id = tab.getAttribute("aria-controls");
      if (tab.getAttribute("aria-selected") !== "true") continue;
      expect(id).not.toBeNull();
      expect(document.getElementById(id as string)?.getAttribute("role")).toBe("tabpanel");
    }
  }

  it("ties the selected area tab and period tab to a panel", async () => {
    stubApi(byFixture);
    render(<StatsPanel phone={false} />);
    await screen.findByTestId("punctual6");
    expectPanelsResolve();
    expect(screen.getAllByRole("tabpanel").length).toBeGreaterThanOrEqual(2);
  });

  it("ties the picked run group to a panel that holds its figures", async () => {
    useStatsStore.setState({ area: { kind: "train", number: "596" }, kind: "train" });
    const second = { ...train.groups[0], operator: { id: "x", name: "Other Operator" } };
    stubApi((url) =>
      url.includes("/trains/")
        ? respond(200, { ...train, groups: [train.groups[0], second] })
        : byFixture(url),
    );
    render(<StatsPanel phone={false} />);
    await screen.findByTestId("punctual6");
    expectPanelsResolve();
    const group = screen.getByRole("tab", { name: /DB Fernverkehr AG/ });
    const panel = document.getElementById(group.getAttribute("aria-controls") as string);
    expect(panel?.querySelector("[data-testid=punctual6]")).not.toBeNull();
  });
});

describe("languages", () => {
  it("writes German numbers and words", async () => {
    await changeLocale("de");
    stubApi(byFixture);
    render(<StatsPanel phone={false} />);
    const hero = await screen.findByTestId("punctual6");
    expect(textOf(hero)).toBe("52,8");
    expect(screen.getByText("Pünktliche Ankünfte")).toBeTruthy();
    expect(screen.getByText("Beobachtete Ankünfte")).toBeTruthy();
  });

  it("writes Polish numbers and words", async () => {
    await changeLocale("pl");
    stubApi(byFixture);
    render(<StatsPanel phone={false} />);
    const hero = await screen.findByTestId("punctual6");
    expect(textOf(hero)).toBe("52,8");
    expect(screen.getByText("Punktualne przyjazdy")).toBeTruthy();
  });
});

describe("the whole answer is taken from one request", () => {
  it("does not ask twice for the same area and period", async () => {
    const calls = stubApi(byFixture);
    render(<StatsPanel phone={false} />);
    await screen.findByTestId("punctual6");
    await act(async () => undefined);
    expect(calls).toHaveLength(1);
  });
});

describe("run groups", () => {
  const second = {
    ...train.groups[0],
    operator: { id: "other", name: "Other Operator" },
    category: "reg",
    line: null,
  };
  const data = { ...train, groups: [train.groups[0], second] } as unknown as StatsTrain;

  it("keeps the picked group by its name when a new answer lists the groups in another order", async () => {
    const user = userEvent.setup();
    const view = render(<StatsBody data={data} tables={false} earlyHint={false} />);
    await user.click(screen.getByRole("tab", { name: /Other Operator/ }));
    expect(screen.getByRole("tab", { name: /Other Operator/ }).getAttribute("aria-selected")).toBe(
      "true",
    );
    const reordered = { ...data, groups: [second, train.groups[0]] } as unknown as StatsTrain;
    view.rerender(<StatsBody data={reordered} tables={false} earlyHint={false} />);
    expect(screen.getByRole("tab", { name: /Other Operator/ }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("falls back to the first group when the picked one is gone", async () => {
    const user = userEvent.setup();
    const view = render(<StatsBody data={data} tables={false} earlyHint={false} />);
    await user.click(screen.getByRole("tab", { name: /Other Operator/ }));
    view.rerender(
      <StatsBody
        data={{ ...data, groups: [train.groups[0]] } as unknown as StatsTrain}
        tables={false}
        earlyHint={false}
      />,
    );
    expect(screen.getByText("DB Fernverkehr AG, ICE and high speed")).toBeTruthy();
  });
});
