// @vitest-environment happy-dom
import { changeLocale } from "@gerlines/i18n";
import { STATUS_PATH } from "@gerlines/schema/status";
import { Popover, PopoverContent } from "@gerlines/ui";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STATUS_SAMPLE } from "./fixtures.ts";
import { StatusPanelView } from "./StatusPanel.tsx";
import { StatusTrigger } from "./StatusTrigger.tsx";
import { answerAgeOf, fetchStatus } from "./status-client.ts";
import type { StatusLoad } from "./use-data-status.ts";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

const AT = Date.parse(STATUS_SAMPLE.at);

/** The innermost element whose whole text is this, across the mono spans of times. */
function textOf(text: string) {
  return (_: string, element: Element | null) =>
    element?.textContent === text &&
    [...element.children].every((child) => child.textContent !== text);
}

beforeEach(async () => {
  await changeLocale("en");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("status client", () => {
  it("reads the status path and checks the answer", async () => {
    const fetch = vi.fn(async () => json(STATUS_SAMPLE));
    expect(await fetchStatus({ fetch })).toEqual({ kind: "ok", data: STATUS_SAMPLE, ageS: 0 });
    expect(fetch).toHaveBeenCalledWith(STATUS_PATH, expect.objectContaining({ cache: "no-cache" }));
  });

  it("takes the answer's age from the seconds the server left it and the age a cache gave it", async () => {
    const held = json(STATUS_SAMPLE, 200, { "cache-control": "public, max-age=12", age: "5" });
    expect(await fetchStatus({ fetch: async () => held })).toMatchObject({ ageS: 23 });
    expect(answerAgeOf(new Headers({ "cache-control": "public, max-age=30" }))).toBe(0);
    expect(answerAgeOf(new Headers({ age: "7" }))).toBe(7);
    expect(answerAgeOf(new Headers({ age: "soon" }))).toBe(0);
  });

  it.each([
    [json({ error: "not_configured" }, 503), { kind: "not-configured" }],
    [
      json({ error: "status_unavailable" }, 503, { "retry-after": "30" }),
      { kind: "unavailable", retryAfterS: 30 },
    ],
    [
      json({ error: "rate_limited" }, 429, { "retry-after": "12" }),
      { kind: "rate-limited", retryAfterS: 12 },
    ],
    [json({ at: "soon" }), { kind: "unreadable" }],
  ])("names a failure %#", async (response, expected) => {
    expect(await fetchStatus({ fetch: async () => response })).toEqual(expected);
  });

  it("names a network failure", async () => {
    const fetch = async () => {
      throw new TypeError("offline");
    };
    expect(await fetchStatus({ fetch })).toEqual({ kind: "unreachable" });
  });
});

function inPopover(
  load: StatusLoad,
  onRetry: () => void = () => undefined,
  { now = AT, mapFrameAt }: { now?: number; mapFrameAt?: number } = {},
) {
  return (
    <Popover open>
      <PopoverContent>
        <StatusPanelView load={load} onRetry={onRetry} now={now} mapFrameAt={mapFrameAt} />
      </PopoverContent>
    </Popover>
  );
}

describe("status panel", () => {
  const ready = {
    state: "ready",
    data: STATUS_SAMPLE,
    refreshFailed: false,
    answeredAt: AT,
  } as const;

  it("lists the live map and each source with its state, times and group", async () => {
    render(inPopover(ready, () => undefined));
    expect(screen.getByText("Data sources")).toBeTruthy();
    expect(screen.getByText(textOf("As of 13:00"))).toBeTruthy();
    expect(screen.getByText(textOf("Last update 4 s ago"))).toBeTruthy();
    const realtime = screen.getByRole("region", { name: "Realtime in Germany" });
    const gtfsde = within(realtime).getByText("gtfs.de").closest("li") as HTMLElement;
    expect(gtfsde.dataset.state).toBe("stale");
    expect(within(gtfsde).getByText("Data is stale")).toBeTruthy();
    const times = within(gtfsde).getByText(textOf("Recorded 12:50, On the map 12:58"));
    expect([...times.querySelectorAll(".type-data-small")].map((time) => time.textContent)).toEqual(
      ["12:50", "12:58"],
    );
    const iris = document.body.querySelector("[data-source=db-iris]") as HTMLElement;
    expect(iris.textContent).toContain("Not recorded");
    expect(iris.textContent).toContain("Not on the map");
    const pkp = document.body.querySelector("[data-source=pl-pkpic]") as HTMLElement;
    expect(pkp.textContent).toContain("Poland");
    expect(pkp.querySelector("[data-state=down]")?.className).toContain("bg-error");
    expect(
      screen.getByRole("link", { name: "All sources and licences" }).getAttribute("href"),
    ).toBe("/sources");
    const results = await axe.run(
      document.querySelector("[data-slot=popover-content]") as HTMLElement,
      { rules: { region: { enabled: false } } },
    );
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });

  it("counts the live map's age on from the answer, or from this map's own newest frame", () => {
    const { rerender } = render(inPopover(ready, () => undefined, { now: AT + 9_000 }));
    expect(screen.getByText(textOf("Last update 13 s ago"))).toBeTruthy();
    rerender(inPopover(ready, () => undefined, { now: AT + 9_000, mapFrameAt: AT + 7_000 }));
    expect(screen.getByText(textOf("Last update 2 s ago"))).toBeTruthy();
  });

  it("keeps the last answer and says when a refresh failed", () => {
    render(inPopover({ ...ready, refreshFailed: true }, () => undefined));
    expect(screen.getByText("Updating failed, trying again.")).toBeTruthy();
    expect(screen.getByText("OVapi")).toBeTruthy();
  });

  it("shows loading, an error with Try again, a wait, and a server without status", async () => {
    const onRetry = vi.fn();
    const { rerender } = render(inPopover({ state: "loading" }, onRetry));
    expect(screen.getByText("Loading the data status")).toBeTruthy();
    rerender(inPopover({ state: "failed", kind: "unreachable" }, onRetry));
    expect(screen.getByRole("alert").textContent).toContain("The data status could not be loaded.");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
    rerender(inPopover({ state: "failed", kind: "rate-limited", retryAfterS: 12 }, onRetry));
    expect(screen.getByRole("button", { name: "Try again in 12 s" })).toHaveProperty(
      "disabled",
      true,
    );
    rerender(inPopover({ state: "failed", kind: "not-configured" }, onRetry));
    expect(screen.getByRole("alert").textContent).toBe("The status server is not set up.");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("speaks German and Polish", async () => {
    await act(() => changeLocale("de"));
    const { unmount } = render(inPopover(ready, () => undefined));
    expect(screen.getByText("Datenquellen")).toBeTruthy();
    expect(screen.getByText("Niederlande")).toBeTruthy();
    unmount();
    await act(() => changeLocale("pl"));
    render(inPopover(ready, () => undefined));
    expect(screen.getByText("Kraje sąsiednie")).toBeTruthy();
    expect(screen.getByText(textOf("Zarejestrowano 12:50, Na mapie 12:58"))).toBeTruthy();
  });
});

describe("status trigger", () => {
  it("reads nothing until it opens, then loads the panel and the status", async () => {
    const fetch = vi.fn(async () => json(STATUS_SAMPLE));
    vi.stubGlobal("fetch", fetch);
    render(<StatusTrigger label="Live" healthy />);
    expect(screen.getByRole("status").textContent).toBe("Live");
    const button = screen.getByRole("button", { name: "Live. Show the data sources" });
    expect(fetch).not.toHaveBeenCalled();
    await userEvent.click(button);
    await waitFor(() => expect(screen.getByText(textOf("Last update 4 s ago"))).toBeTruthy());
    expect(fetch).toHaveBeenCalledTimes(1);
    const opened = screen.getByRole("button", { name: "Live. Show the data sources" });
    expect(opened.getAttribute("aria-expanded")).toBe("true");
    const popup = document.querySelector("[data-slot=popover-content]");
    await waitFor(() => expect(popup?.contains(document.activeElement)).toBe(true));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText(textOf("Last update 4 s ago"))).toBeNull());
    expect(opened.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(opened);
  });

  it("draws a hollow dot while the data is not healthy", () => {
    render(<StatusTrigger label="Data is stale" healthy={false} />);
    const dot = screen.getByRole("button").querySelector("[data-state]");
    expect(dot?.getAttribute("data-state")).toBe("stale");
    expect(dot?.className).toContain("inset");
  });
});
