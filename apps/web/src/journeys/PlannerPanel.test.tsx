// @vitest-environment happy-dom
import { changeLocale } from "@gerlines/i18n";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePlaybackStore } from "../playback/store.ts";
import { useAppStore } from "../state/store.ts";
import { StatsButton } from "../stats/StatsEntry.tsx";
import { FIXTURES } from "./fixtures.ts";
import { PlannerButton } from "./PlannerButton.tsx";
import { PlannerPanel } from "./PlannerPanel.tsx";
import { type PlannerStation, usePlannerStore } from "./planner-store.ts";

const PLAYING = {
  phase: "playing",
  playing: true,
  position: Date.parse("2026-11-10T06:30:00Z") / 1000,
  speed: 1,
  windowStart: 0,
  windowEnd: 3600,
  error: null,
  notice: null,
} as const;

const BREMEN: PlannerStation = {
  id: "e8278339-81d9-5653-888a-65dea36f07bc",
  name: "Bremen Hbf",
  stopId: "de:04011:13927",
  lon: 8.813834,
  lat: 53.083481,
};
const HAMBURG: PlannerStation = {
  id: "efa75307-7081-52d9-90a7-49ccda1ff516",
  name: "Hamburg Hbf",
  stopId: "de:02000:10950",
  lon: 10.006909,
  lat: 53.552736,
};

let journeysAnswer: () => Response;
let reliabilityAnswer: () => Response;
const requested: URL[] = [];

beforeEach(async () => {
  await changeLocale("en", { persist: false });
  requested.length = 0;
  journeysAnswer = () => Response.json(FIXTURES.bremenHamburg);
  reliabilityAnswer = () => Response.json(FIXTURES.reliabilityBremenHamburg);
  vi.stubGlobal("fetch", async (input: string) => {
    const url = new URL(input, "http://local");
    requested.push(url);
    if (url.pathname.endsWith("/reliability")) return reliabilityAnswer();
    if (url.searchParams.get("cursor")?.startsWith("LATER"))
      return Response.json(FIXTURES.bremenHamburgLater);
    return journeysAnswer();
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  usePlannerStore.getState().reset();
  usePlannerStore.getState().openPlanner();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function searched() {
  const state = usePlannerStore.getState();
  state.setFrom(BREMEN);
  state.setTo(HAMBURG);
  state.setTime("2026-11-10T07:00");
  await act(() => usePlannerStore.getState().search());
}

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-slot=journey-row]")];
}

describe("PlannerPanel on desktop", () => {
  it("says what is missing when Find journeys has no stations", async () => {
    render(<PlannerPanel phone={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Find journeys" }));
    expect(screen.getByRole("alert").textContent).toBe(
      "Choose a departure and a destination station",
    );
    expect(requested).toHaveLength(0);
  });

  it("lists the journeys with times, changes, trains and their punctuality, the first one shown", async () => {
    render(<PlannerPanel phone={false} />);
    await searched();
    expect(rows()).toHaveLength(5);
    const first = rows()[0] as HTMLElement;
    expect(first?.getAttribute("aria-pressed")).toBe("true");
    expect(within(first).getByText("Train 1028")).toBeTruthy();
    expect(first.textContent).toContain("07:22");
    expect(first.textContent).toContain("08:18");
    expect(first.textContent).toContain("56 min");
    expect(first.textContent).toContain("Direct");
    await waitFor(() => expect(first.textContent).toContain("2 recorded runs, too few to rate"));
    expect(first.textContent).not.toContain("%");
    expect(first.textContent).toContain("Fastest");
    expect(screen.getByText("Line 42, DB Fernverkehr AG")).toBeTruthy();
    expect(screen.getByText(/Timetable DELFI, routed by MOTIS/)).toBeTruthy();
  });

  it("rates a train with enough runs since its first recorded day, departure and arrival named", async () => {
    reliabilityAnswer = () =>
      Response.json({
        ...FIXTURES.reliabilityBremenHamburg,
        trains: FIXTURES.reliabilityBremenHamburg.trains.map((train) =>
          train.status === "known" ? { ...train, runs: 12 } : train,
        ),
      });
    render(<PlannerPanel phone={false} />);
    await searched();
    const first = rows()[0] as HTMLElement;
    await waitFor(() =>
      expect(first.textContent).toContain("83% on time since 27 Oct, 12 recorded runs"),
    );
    expect(first.textContent).toMatch(/^Departure07:22Arrival08:18/);
  });

  it("names what the filters left out next to an empty answer and offers every train", async () => {
    journeysAnswer = () =>
      Response.json({ ...FIXTURES.bremenHamburg, journeys: [], removedByFilter: 3 });
    usePlannerStore.getState().toggleCategory("hsr");
    render(<PlannerPanel phone={false} />);
    await searched();
    expect(screen.getByText("No journey found for this time with these trains")).toBeTruthy();
    expect(screen.getByText("3 journeys left out by your filters")).toBeTruthy();
    journeysAnswer = () => Response.json(FIXTURES.bremenHamburg);
    await userEvent.click(screen.getByRole("button", { name: "Search all trains and operators" }));
    await waitFor(() => expect(rows()).toHaveLength(5));
    expect(usePlannerStore.getState().categories).toHaveLength(6);
  });

  it("shows another journey and its legs when it is picked", async () => {
    render(<PlannerPanel phone={false} />);
    await searched();
    await userEvent.click(rows()[1] as HTMLElement);
    expect(rows()[1]?.getAttribute("aria-pressed")).toBe("true");
    expect(rows()[0]?.getAttribute("aria-pressed")).toBe("false");
    expect(usePlannerStore.getState().selectedId).toBe(FIXTURES.bremenHamburg.journeys[1]?.id);
    expect(screen.getByText("Train 82012, metronom")).toBeTruthy();
  });

  it("opens the live train card from a leg whose train runs now", async () => {
    const tripInstanceId = "05b180df-12b5-5062-93a3-0a1c50b4e115";
    const answer = structuredClone(FIXTURES.bremenHamburg);
    const [leg] = (answer.journeys[0]?.legs ?? []).filter((l) => l.kind === "transit");
    if (leg?.kind !== "transit") throw new Error("the fixture has a train leg");
    leg.run = {
      tripInstanceId,
      departure: "2026-11-10T05:00:00Z",
      arrival: "2026-11-10T07:30:00Z",
    };
    journeysAnswer = () => Response.json(answer);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-11-10T06:30:00Z") });
    render(<PlannerPanel phone={false} />);
    await searched();
    await userEvent.click(screen.getByRole("button", { name: "Show the train live" }));
    expect(useAppStore.getState().selectedId).toBe(tripInstanceId);
    vi.useRealTimers();
  });

  it("offers no live train for a leg whose train does not run now", async () => {
    const answer = structuredClone(FIXTURES.bremenHamburg);
    const [leg] = (answer.journeys[0]?.legs ?? []).filter((l) => l.kind === "transit");
    if (leg?.kind !== "transit") throw new Error("the fixture has a train leg");
    leg.run = {
      tripInstanceId: "05b180df-12b5-5062-93a3-0a1c50b4e115",
      departure: "2026-11-10T05:00:00Z",
      arrival: "2026-11-10T07:30:00Z",
    };
    journeysAnswer = () => Response.json(answer);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-11-09T06:30:00Z") });
    render(<PlannerPanel phone={false} />);
    await searched();
    expect(screen.queryByRole("button", { name: "Show the train live" })).toBeNull();
    vi.useRealTimers();
  });

  it("offers no live train during a playback, which shows a past hour", async () => {
    const answer = structuredClone(FIXTURES.bremenHamburg);
    const [leg] = (answer.journeys[0]?.legs ?? []).filter((l) => l.kind === "transit");
    if (leg?.kind !== "transit") throw new Error("the fixture has a train leg");
    leg.run = {
      tripInstanceId: "05b180df-12b5-5062-93a3-0a1c50b4e115",
      departure: "2026-11-10T05:00:00Z",
      arrival: "2026-11-10T07:30:00Z",
    };
    journeysAnswer = () => Response.json(answer);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-11-10T06:30:00Z") });
    usePlaybackStore.setState({ state: PLAYING });
    render(<PlannerPanel phone={false} />);
    await searched();
    expect(screen.getAllByText("Train 1028").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Show the train live" })).toBeNull();
    usePlaybackStore.setState({ state: null });
    vi.useRealTimers();
  });

  it("adds later journeys with the cursor of the answer", async () => {
    render(<PlannerPanel phone={false} />);
    await searched();
    await userEvent.click(screen.getByRole("button", { name: "Later journeys" }));
    await waitFor(() => expect(rows().length).toBeGreaterThan(5));
    expect(
      requested.some(
        (url) => url.searchParams.get("cursor") === FIXTURES.bremenHamburg.laterCursor,
      ),
    ).toBe(true);
  });

  it("says the router is busy and offers to try again", async () => {
    journeysAnswer = () => Response.json({ error: "router_busy" }, { status: 503 });
    render(<PlannerPanel phone={false} />);
    await searched();
    expect(screen.getByText("The journey router is busy, try again in a moment")).toBeTruthy();
    journeysAnswer = () => Response.json(FIXTURES.bremenHamburg);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(rows()).toHaveLength(5));
  });

  it("speaks German and Polish", async () => {
    await changeLocale("de", { persist: false });
    const { unmount } = render(<PlannerPanel phone={false} />);
    expect(screen.getByRole("button", { name: "Verbindungen suchen" })).toBeTruthy();
    unmount();
    await changeLocale("pl", { persist: false });
    render(<PlannerPanel phone={false} />);
    await searched();
    expect(rows()[0]?.textContent).toContain("Pociąg 1028");
    await waitFor(() =>
      expect(rows()[0]?.textContent).toContain("2 zapisane kursy, za mało do oceny"),
    );
  });

  it("has no accessibility violations with results", async () => {
    const { container } = render(<PlannerPanel phone={false} />);
    await searched();
    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
    });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });
});

describe("panel head", () => {
  it("keeps the title in the fixed head row with the close button on phone", () => {
    render(<PlannerPanel phone />);
    const head = document.querySelector<HTMLElement>("[data-slot=bottom-sheet-head]");
    expect(head?.textContent).toContain("Journey planner");
    expect(
      within(head as HTMLElement).getByRole("button", { name: "Close journey planner" }),
    ).toBeTruthy();
    expect(document.querySelectorAll("h2")).toHaveLength(1);
  });

  it("uses the head of the statistics card: a small muted label over a hairline", () => {
    render(<PlannerPanel phone={false} />);
    const title = screen.getByRole("heading", { name: "Journey planner" });
    expect(title.className).toContain("type-label");
    expect(title.className).toContain("text-ink-muted");
    expect(title.className).not.toContain("type-title");
  });
});

describe("PlannerPanel on phone", () => {
  it("drops to the chosen journey once another one is picked", async () => {
    render(<PlannerPanel phone />);
    await searched();
    expect(screen.getByRole("button", { name: "Find journeys" })).toBeTruthy();
    await userEvent.click(rows()[2] as HTMLElement);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Find journeys" })).toBeNull());
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.textContent).toContain("08:17");
  });
});

describe("route button", () => {
  it("is pressed while the planner shows, takes the slot from statistics and gets the focus back on close", async () => {
    usePlannerStore.getState().closePlanner();
    render(
      <>
        <StatsButton />
        <PlannerButton />
        <PlannerPanel phone={false} />
      </>,
    );
    const route = screen.getByRole("button", { name: "Plan a journey" });
    const stats = screen.getByRole("button", { name: "Statistics" });
    await userEvent.click(stats);
    expect(stats.getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(route);
    expect(route.getAttribute("aria-pressed")).toBe("true");
    expect(stats.getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(screen.getByRole("button", { name: "Close journey planner" }));
    await waitFor(() => expect(document.activeElement).toBe(route));
    expect(route.getAttribute("aria-pressed")).toBe("false");
  });
});
