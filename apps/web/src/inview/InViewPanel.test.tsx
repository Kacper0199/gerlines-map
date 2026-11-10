// @vitest-environment happy-dom
import { changeLocale } from "@gerlines/i18n";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axeViolations } from "../../test/helpers/axe.ts";
import { takeCardFocus } from "../a11y/card-focus.ts";
import { SkipLink } from "../a11y/SkipLink.tsx";
import { DesktopShell } from "../components/shell/DesktopShell.tsx";
import { LayersPopover } from "../components/shell/LayersPopover.tsx";
import { LegendCard } from "../components/shell/LegendCard.tsx";
import { PhoneShell } from "../components/shell/PhoneShell.tsx";
import type { NearTrain } from "../motion/protocol.ts";
import { resetPanelStore, usePanelStore } from "../state/panel-store.ts";
import { initialState, useAppStore } from "../state/store.ts";
import { InViewButton } from "./InViewEntry.tsx";
import InViewPanel from "./InViewPanel.tsx";
import { type NearestAnswer, resetInViewStore, useInViewStore } from "./store.ts";

function train(key: number, extra: Partial<NearTrain> = {}): NearTrain {
  return {
    key,
    id: `live:${key}`,
    line: "RE 1",
    trainNumber: 4000 + key,
    category: "rfast",
    foreign: false,
    delaySeconds: 300,
    lon: 8.01,
    lat: 50.01,
    distanceM: 1500,
    ...extra,
  };
}

const CENTRE = { lon: 8, lat: 50 };

function answer(trains: readonly NearTrain[], inView = trains.length): NearestAnswer {
  return { centre: CENTRE, result: { inView, trains } };
}

function attach(next: NearestAnswer) {
  useInViewStore.getState().attach(async () => next);
}

beforeEach(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 404 })),
  );
  await changeLocale("en");
  useAppStore.setState(initialState());
  resetPanelStore();
  resetInViewStore();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("trains in view panel", () => {
  it("lists the trains by distance with line, kind, place and delay", async () => {
    attach(
      answer([
        train(1, { distanceM: 30, line: null, trainNumber: 17437, delaySeconds: null }),
        train(2, { line: "S 11", category: "sbahn", distanceM: 2300, delaySeconds: 0 }),
        train(3, { line: "ICE 5", category: "hsr", distanceM: 460, delaySeconds: -120 }),
      ]),
    );
    render(<InViewPanel phone={false} />);
    const list = await screen.findByRole("list", { name: "Trains in view" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]?.textContent).toContain("Train 17437");
    expect(items[0]?.textContent).toContain("in the middle");
    expect(items[0]?.textContent).toContain("No data");
    expect(items[1]?.textContent).toContain("S 11");
    expect(items[1]?.textContent).toContain("Train 4002");
    expect(items[1]?.textContent).toContain("2.3 km to the north-east");
    expect(items[1]?.textContent).toContain("On time");
    expect(items[2]?.textContent).toContain("ICE 4003");
    expect(items[2]?.textContent).toContain("Line ICE 5");
    expect(items[2]?.textContent).toContain("460 m to the north-east");
    expect(items[2]?.textContent).toContain("2min early");
  });

  it("opens the card of the train that is picked", async () => {
    attach(answer([train(7), train(8)]));
    const user = userEvent.setup();
    render(<InViewPanel phone={false} />);
    const list = await screen.findByRole("list", { name: "Trains in view" });
    await user.click(within(list).getAllByRole("button")[1] as HTMLElement);
    expect(useAppStore.getState().selectedId).toBe("live:8");
  });

  it("asks the card of the picked train to take the focus", async () => {
    attach(answer([train(7)]));
    takeCardFocus();
    const user = userEvent.setup();
    render(<InViewPanel phone={false} />);
    const list = await screen.findByRole("list", { name: "Trains in view" });
    await user.click(within(list).getAllByRole("button")[0] as HTMLElement);
    expect(takeCardFocus()).toBe(true);
  });

  it("never titles a row with a bare number and puts the line in the caption", async () => {
    attach(
      answer([
        train(1, { line: "26", trainNumber: 1576, category: "hsr" }),
        train(2, { line: "22", trainNumber: 578, category: "ld" }),
        train(3, { line: "11", trainNumber: 4711, category: "reg" }),
        train(4, { line: null, trainNumber: null, category: "reg" }),
        train(5, { line: "19", trainNumber: null, category: "hsr" }),
      ]),
    );
    render(<InViewPanel phone={false} />);
    const list = await screen.findByRole("list", { name: "Trains in view" });
    const titles = within(list)
      .getAllByRole("button")
      .map((button) => button.querySelector(".type-body-strong")?.textContent);
    expect(titles).toEqual(["Train 1576", "Train 578", "Line 11", "Train", "Line 19"]);
    const items = within(list).getAllByRole("listitem");
    expect(items[0]?.textContent).toContain("Line 26");
    expect(items[2]?.textContent).toContain("Train 4711");
  });

  it("says when no train is near the middle and while it is still looking", async () => {
    attach(answer([], 0));
    render(<InViewPanel phone={false} />);
    expect(screen.getByRole("status").textContent).toBe("Looking for trains");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("No trains near the middle of the map."),
    );
  });

  it("moves the focus to its heading when it opens on a desktop", async () => {
    attach(answer([train(1)]));
    render(<InViewPanel phone={false} />);
    await waitFor(() => expect(document.activeElement?.tagName).toBe("H2"));
    expect(document.activeElement?.textContent).toBe("Trains in view");
  });

  it("names the handle of the phone sheet for the list and closes the sheet with Escape", async () => {
    attach(answer([train(1)]));
    const user = userEvent.setup();
    usePanelStore.getState().open("inview");
    render(<InViewPanel phone />);
    await screen.findByRole("list");
    const handle = screen.getByRole("button", { name: "Show less of the list" });
    expect(handle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("button", { name: /this train/i })).toBeNull();
    await user.keyboard("{Escape}");
    expect(usePanelStore.getState().active).toBeNull();
  });

  it("closes with Escape and with its close button", async () => {
    attach(answer([train(1)]));
    const user = userEvent.setup();
    usePanelStore.getState().open("inview");
    render(<InViewPanel phone={false} />);
    await screen.findByRole("list");
    await user.keyboard("{Escape}");
    expect(usePanelStore.getState().active).toBeNull();
    usePanelStore.getState().open("inview");
    await user.click(screen.getByRole("button", { name: "Close the trains in view" }));
    expect(usePanelStore.getState().active).toBeNull();
  });

  it("asks again after the user moved the map", async () => {
    const ask = vi.fn(async () => answer([train(1)]));
    useInViewStore.getState().attach(ask);
    render(<InViewPanel phone={false} />);
    await screen.findByRole("list");
    const before = ask.mock.calls.length;
    act(() => useInViewStore.getState().userMoved());
    await waitFor(() => expect(ask.mock.calls.length).toBeGreaterThan(before));
  });

  it("reads in German and Polish", async () => {
    attach(answer([train(1, { distanceM: 2300 })]));
    await changeLocale("de");
    render(<InViewPanel phone={false} />);
    const list = await screen.findByRole("list", { name: "Züge im Ausschnitt" });
    expect(list.textContent).toContain("2,3 km nordöstlich");
    cleanup();
    await changeLocale("pl");
    render(<InViewPanel phone={false} />);
    const polish = await screen.findByRole("list", { name: "Pociągi w widoku" });
    expect(polish.textContent).toContain("2,3 km na północny wschód");
  });

  it("has no axe violations, on a desktop and as a phone sheet, with trains and without", async () => {
    attach(answer([train(1), train(2, { line: null }), train(3, { delaySeconds: null })]));
    const desktop = render(<InViewPanel phone={false} />);
    await screen.findByRole("list");
    expect(await axeViolations(desktop.container)).toEqual([]);
    cleanup();
    const phone = render(<InViewPanel phone />);
    await screen.findByRole("list");
    expect(await axeViolations(phone.container)).toEqual([]);
    cleanup();
    attach(answer([], 0));
    const empty = render(<InViewPanel phone={false} />);
    await screen.findByText("No trains near the middle of the map.");
    expect(await axeViolations(empty.container)).toEqual([]);
  });
});

describe("entry points", () => {
  it("opens from the legend button, which shows pressed while the list holds the slot", async () => {
    attach(answer([train(1)]));
    const user = userEvent.setup();
    render(<InViewButton />);
    const button = screen.getByRole("button", { name: "Trains in view" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    await user.click(button);
    expect(usePanelStore.getState().active).toBe("inview");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    await user.click(button);
    expect(usePanelStore.getState().active).toBeNull();
  });

  it("is in the legend header, next to the totals", () => {
    render(<LegendCard />);
    const legend = screen.getByRole("region", { name: "Trains on the map" });
    expect(within(legend).getByRole("button", { name: "Trains in view" })).toBeTruthy();
  });

  it("opens from the second skip link and moves the focus to the list heading", async () => {
    attach(answer([train(1)]));
    const user = userEvent.setup();
    render(
      <>
        <SkipLink />
        <DesktopShell onZoom={() => undefined} />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Skip to trains in view" }));
    await waitFor(() => expect(usePanelStore.getState().active).toBe("inview"));
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Trains in view"));
    expect(document.activeElement?.tagName).toBe("H2");
  });

  it("puts the list in the card slot of the desktop and the phone shell", async () => {
    attach(answer([train(1)]));
    usePanelStore.getState().open("inview");
    render(<DesktopShell onZoom={() => undefined} />);
    expect(await screen.findByRole("article", { name: "Trains in view" })).toBeTruthy();
    cleanup();
    render(<PhoneShell />);
    expect(await screen.findByRole("list", { name: "Trains in view" })).toBeTruthy();
  });

  it("closes the layers popover of the phone when the list opens from its legend", async () => {
    attach(answer([train(1)]));
    const user = userEvent.setup();
    render(<LayersPopover />);
    await user.click(screen.getByRole("button", { name: "Map layers" }));
    await user.click(await screen.findByRole("button", { name: "Trains in view" }));
    expect(usePanelStore.getState().active).toBe("inview");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Trains in view" })).toBeNull(),
    );
  });

  it("sends the focus back to the Layers button when the popover closes with the list open", async () => {
    attach(answer([train(1)]));
    const user = userEvent.setup();
    usePanelStore.getState().open("inview");
    render(
      <>
        <LayersPopover />
        <InViewPanel phone />
      </>,
    );
    await screen.findByRole("list");
    const trigger = screen.getByRole("button", { name: "Map layers" });
    await user.click(trigger);
    await screen.findByRole("group", { name: "Language" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("is the two skip links, search first", () => {
    render(<SkipLink />);
    const names = screen.getAllByRole("button").map((button) => button.textContent);
    expect(names).toEqual(["Skip to search", "Skip to trains in view"]);
  });
});
