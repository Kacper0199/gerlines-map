// @vitest-environment happy-dom
import { changeLocale } from "@gerlines/i18n";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axeViolations } from "../../../test/helpers/axe.ts";
import type { DataStatus } from "../../motion/protocol.ts";
import { initialState, useAppStore } from "../../state/store.ts";
import { RightColumn } from "./RightColumn.tsx";
import { overflows } from "./use-overflow-ladder.ts";

const STATUS: DataStatus = {
  state: "live",
  dataTimeMs: Date.parse("2026-10-23T19:34:00Z"),
  trips: 2665,
  realtime: 2234,
  untracked: 37,
  counts: { hsr: 151, ld: 40, night: 3, rfast: 463, reg: 610, sbahn: 621, foreign: 777 },
  error: undefined,
};

type Contents = Readonly<Record<"full" | "styleFolded" | "folded" | "collapsed", number>>;

let columnHeight = 726;
let contents: Contents = { full: 500, styleFolded: 450, folded: 400, collapsed: 300 };
let resizeCallbacks: Array<(entries: unknown[]) => void> = [];

function fitOf(element: Element): keyof Contents {
  return element.getAttribute("data-legend-fit") as keyof Contents;
}

beforeEach(async () => {
  columnHeight = 726;
  resizeCallbacks = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: (entries: unknown[]) => void) {
        resizeCallbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => columnHeight,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute("data-legend-fit") ? contents[fitOf(this)] : 0;
    },
  });
  await changeLocale("en");
  useAppStore.setState({ ...initialState(), status: STATUS });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
});

function column(): HTMLElement {
  return document.querySelector("[data-legend-fit]") as HTMLElement;
}

describe("overflows", () => {
  it("ignores a sub-pixel difference and reports a real one", () => {
    expect(overflows({ scrollHeight: 727, clientHeight: 726 })).toBe(false);
    expect(overflows({ scrollHeight: 728, clientHeight: 726 })).toBe(true);
  });
});

describe("RightColumn fit", () => {
  it("keeps the legend open with the label control inline while everything fits", () => {
    contents = { full: 726, styleFolded: 696, folded: 666, collapsed: 300 };
    render(<RightColumn compact={false} />);

    expect(fitOf(column())).toBe("full");
    const legend = screen.getByRole("region", { name: "Trains on the map" });
    expect(within(legend).getByRole("radio", { name: "Off" })).toBeTruthy();
    expect(within(legend).queryByRole("button", { name: /Train labels/ })).toBeNull();
  });

  it("folds the label control into a disclosure when only that makes the column fit", async () => {
    contents = { full: 803, styleFolded: 761, folded: 720, collapsed: 300 };
    render(<RightColumn compact={false} />);

    expect(fitOf(column())).toBe("folded");
    const legend = screen.getByRole("region", { name: "Trains on the map" });
    const labels = within(legend).getByRole("button", { name: /Train labels/ });
    expect(labels.getAttribute("aria-expanded")).toBe("false");
    expect(labels.textContent).toContain("Off");
    expect(within(legend).getByRole("checkbox", { name: /RB/ })).toBeTruthy();
    await userEvent.click(labels);
    expect(labels.getAttribute("aria-expanded")).toBe("true");
    expect(within(legend).getByRole("radio", { name: "Line" })).toBeTruthy();
  });

  it("collapses the legend to its header when the folded legend still overflows", () => {
    contents = { full: 853, styleFolded: 821, folded: 790, collapsed: 300 };
    render(<RightColumn compact={false} />);

    expect(fitOf(column())).toBe("collapsed");
    const legend = screen.getByRole("region", { name: "Trains on the map" });
    const header = within(legend).getByRole("button", { name: /^Trains(?! in view)/ });
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  it("decides again for each colour mode", () => {
    contents = { full: 780, styleFolded: 740, folded: 700, collapsed: 300 };
    render(<RightColumn compact={false} />);
    expect(fitOf(column())).toBe("folded");

    contents = { full: 700, styleFolded: 670, folded: 640, collapsed: 300 };
    act(() => {
      useAppStore.getState().setColourMode("delay");
    });
    expect(fitOf(column())).toBe("full");
  });

  it("opens the legend again when the window grows", () => {
    contents = { full: 803, styleFolded: 796, folded: 790, collapsed: 300 };
    render(<RightColumn compact={false} />);
    expect(fitOf(column())).toBe("collapsed");

    columnHeight = 900;
    act(() => {
      for (const callback of resizeCallbacks) {
        callback([]);
      }
    });
    expect(fitOf(column())).toBe("full");
    expect(screen.getByRole("radio", { name: "Off" })).toBeTruthy();
  });

  it("keeps a legend the user opened open when the window height changes", async () => {
    contents = { full: 853, styleFolded: 821, folded: 790, collapsed: 300 };
    render(<RightColumn compact={false} />);
    const header = () =>
      within(screen.getByRole("region", { name: "Trains on the map" })).getByRole("button", {
        name: /^Trains(?! in view)/,
      });
    await userEvent.click(header());
    expect(header().getAttribute("aria-expanded")).toBe("true");

    columnHeight = 700;
    act(() => {
      for (const callback of resizeCallbacks) {
        callback([]);
      }
    });
    expect(fitOf(column())).toBe("collapsed");
    expect(header().getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps an opened label disclosure open when the window height changes", async () => {
    contents = { full: 803, styleFolded: 761, folded: 720, collapsed: 300 };
    render(<RightColumn compact={false} />);
    const labels = () => screen.getByRole("button", { name: /Train labels/ });
    await userEvent.click(labels());
    expect(labels().getAttribute("aria-expanded")).toBe("true");

    columnHeight = 722;
    act(() => {
      for (const callback of resizeCallbacks) {
        callback([]);
      }
    });
    expect(fitOf(column())).toBe("folded");
    expect(labels().getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the zoom hint announced while the label disclosure is closed", () => {
    contents = { full: 803, styleFolded: 761, folded: 720, collapsed: 300 };
    useAppStore.setState({ labelMode: "line", zoom: 6 });
    render(<RightColumn compact={false} />);

    const labels = screen.getByRole("button", { name: /Train labels/ });
    expect(labels.getAttribute("aria-expanded")).toBe("false");
    const hint = screen.getAllByRole("status").find((node) => /zoom/i.test(node.textContent ?? ""));
    expect(hint).toBeTruthy();
    expect(hint?.closest("[hidden]")).toBeNull();
  });

  it("pads the scroller by the reach of a card shadow and cancels it with the margin, never past the screen edge", () => {
    render(<RightColumn compact={false} />);
    const classes = column().className.split(" ");
    expect(classes).toContain("overflow-y-auto");
    const pairs = [
      ["-mt-4", "pt-4"],
      ["-mr-4", "pr-4"],
      ["-mb-8", "pb-8"],
      ["-ml-6", "pl-6"],
    ];
    for (const [margin, padding] of pairs) {
      expect(classes).toContain(margin);
      expect(classes).toContain(padding);
    }
    expect(classes).toContain("w-66");
    expect(classes).not.toContain("-m-6");
  });

  it("reserves the zoom hint line only while a label mode is on", () => {
    contents = { full: 400, styleFolded: 350, folded: 300, collapsed: 200 };
    useAppStore.setState({ labelMode: "off", zoom: 6 });
    const { unmount } = render(<RightColumn compact={false} />);
    const hintOf = () =>
      within(screen.getByTestId("label-mode")).getByRole("status") as HTMLElement;
    expect(hintOf().className).not.toContain("min-h-");
    expect(hintOf().className).toContain("sr-only");
    unmount();

    useAppStore.setState({ labelMode: "line", zoom: 12 });
    render(<RightColumn compact={false} />);
    expect(hintOf().className).toContain("min-h-");
    expect(hintOf().className).not.toContain("sr-only");
  });

  it("never walks past the last step when even the header overflows", () => {
    contents = { full: 900, styleFolded: 900, folded: 900, collapsed: 900 };
    render(<RightColumn compact={false} />);

    expect(fitOf(column())).toBe("collapsed");
  });

  it("has no accessibility violations in any step", async () => {
    contents = { full: 803, styleFolded: 761, folded: 720, collapsed: 300 };
    const { container, unmount } = render(<RightColumn compact={false} />);
    expect(await axeViolations(container)).toEqual([]);
    unmount();

    contents = { full: 853, styleFolded: 821, folded: 790, collapsed: 300 };
    const collapsed = render(<RightColumn compact={false} />);
    expect(await axeViolations(collapsed.container)).toEqual([]);
  });
});

function fireResize(): void {
  act(() => {
    for (const callback of resizeCallbacks) {
      callback([]);
    }
  });
}

describe("RightColumn after the first walk", () => {
  it("walks again when the content grows after the walk has settled", () => {
    contents = { full: 700, styleFolded: 650, folded: 600, collapsed: 300 };
    render(<RightColumn compact={false} />);
    expect(fitOf(column())).toBe("full");

    contents = { full: 742, styleFolded: 720, folded: 690, collapsed: 300 };
    fireResize();
    expect(fitOf(column())).toBe("styleFolded");

    contents = { full: 790, styleFolded: 760, folded: 720, collapsed: 300 };
    fireResize();
    expect(fitOf(column())).toBe("folded");
  });

  it("pins the walk at folded while the user has Show on the map open", async () => {
    useAppStore.getState().setColourMode("delay");
    contents = { full: 700, styleFolded: 650, folded: 600, collapsed: 300 };
    render(<RightColumn compact={false} />);
    expect(fitOf(column())).toBe("full");
    const show = () => screen.getByRole("button", { name: "Show on the map" });
    await userEvent.click(show());

    contents = { full: 966, styleFolded: 814, folded: 754, collapsed: 300 };
    fireResize();

    expect(fitOf(column())).toBe("folded");
    expect(show().getAttribute("aria-expanded")).toBe("true");
    expect(
      within(screen.getByRole("region", { name: "Trains on the map" })).getAllByRole("checkbox")
        .length,
    ).toBeGreaterThan(0);
  });

  it("does not restart the walk when the status arrives", () => {
    contents = { full: 780, styleFolded: 700, folded: 650, collapsed: 300 };
    useAppStore.setState({ status: { ...STATUS, untracked: 0 } });
    render(<RightColumn compact={false} />);
    expect(fitOf(column())).toBe("styleFolded");

    contents = { full: 700, styleFolded: 640, folded: 600, collapsed: 300 };
    act(() => {
      useAppStore.setState({ status: STATUS });
    });
    expect(fitOf(column())).toBe("styleFolded");
  });

  it("walks back to full once the user closes the disclosure that pinned it", async () => {
    useAppStore.getState().setColourMode("delay");
    contents = { full: 700, styleFolded: 650, folded: 600, collapsed: 300 };
    render(<RightColumn compact={false} />);
    const show = () => screen.getByRole("button", { name: "Show on the map" });
    await userEvent.click(show());
    contents = { full: 966, styleFolded: 814, folded: 754, collapsed: 300 };
    fireResize();
    expect(fitOf(column())).toBe("folded");

    await userEvent.click(show());
    contents = { full: 700, styleFolded: 650, folded: 600, collapsed: 300 };
    fireResize();

    expect(fitOf(column())).toBe("full");
  });

  it("keeps a disclosure the user opened open when the status arrives", async () => {
    useAppStore.getState().setColourMode("delay");
    useAppStore.setState({ status: { ...STATUS, untracked: 0 } });
    contents = { full: 700, styleFolded: 650, folded: 600, collapsed: 300 };
    render(<RightColumn compact={false} />);
    const show = () => screen.getByRole("button", { name: "Show on the map" });
    await userEvent.click(show());
    contents = { full: 966, styleFolded: 814, folded: 754, collapsed: 300 };
    fireResize();

    act(() => {
      useAppStore.setState({ status: STATUS });
    });

    expect(fitOf(column())).toBe("folded");
    expect(show().getAttribute("aria-expanded")).toBe("true");
  });
});

describe("RightColumn style card", () => {
  it("shows the four styles inline until the walk folds the card", () => {
    contents = { full: 700, styleFolded: 650, folded: 600, collapsed: 300 };
    render(<RightColumn compact={false} />);
    const card = screen.getByRole("group", { name: "Map style" });
    expect(within(card).getAllByRole("button", { pressed: false }).length).toBe(3);
  });

  it("folds the card to one row that opens the styles in a popover", async () => {
    contents = { full: 780, styleFolded: 700, folded: 650, collapsed: 300 };
    render(<RightColumn compact={false} />);
    expect(fitOf(column())).toBe("styleFolded");
    const card = screen.getByRole("group", { name: "Map style" });
    const row = within(card).getByRole("button", { name: /Map style/ });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(row.textContent).toContain("Dark");
    expect(within(card).queryByRole("button", { name: "Satellite" })).toBeNull();

    await userEvent.click(row);
    await userEvent.click(await screen.findByRole("button", { name: "Satellite" }));
    expect(useAppStore.getState().mapStyle).toBe("satellite");
  });

  it("keeps the tilt, terrain and buildings switches under the folded row, not beside it", async () => {
    useAppStore.setState({ mapStyle: "terrain", terrain3d: true });
    contents = { full: 780, styleFolded: 700, folded: 650, collapsed: 300 };
    render(<RightColumn compact={false} />);
    expect(fitOf(column())).toBe("styleFolded");
    const card = screen.getByRole("group", { name: "Map style" });
    expect(within(card).queryAllByRole("switch")).toHaveLength(0);

    await userEvent.click(within(card).getByRole("button", { name: /Map style/ }));

    expect(await screen.findAllByRole("switch")).toHaveLength(4);
    expect(screen.getByRole("switch", { name: "Keyboard shortcuts" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Tilt on selection" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "3D terrain" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "3D buildings" })).toBeTruthy();
  });

  it("keeps the switches inline while the card shows its thumbnails", () => {
    contents = { full: 700, styleFolded: 650, folded: 600, collapsed: 300 };
    render(<RightColumn compact={false} />);
    const card = screen.getByRole("group", { name: "Map style" });
    expect(within(card).getByRole("switch", { name: "Tilt on selection" })).toBeTruthy();
  });

  it("keeps the styles popover open while the walk restarts and the card folds again", async () => {
    contents = { full: 780, styleFolded: 700, folded: 650, collapsed: 300 };
    render(<RightColumn compact={false} />);
    await userEvent.click(screen.getByRole("button", { name: /Map style/ }));
    await screen.findByRole("button", { name: "Satellite" });

    columnHeight = 725;
    fireResize();

    expect(fitOf(column())).toBe("styleFolded");
    expect(screen.getByRole("button", { name: "Satellite" })).toBeTruthy();
  });

  it("folds the style card from the start on a compact screen, where the column must stay short", () => {
    contents = { full: 500, styleFolded: 450, folded: 400, collapsed: 300 };
    render(<RightColumn compact />);
    const card = screen.getByRole("group", { name: "Map style" });
    expect(within(card).getByRole("button", { name: /Map style/ })).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Satellite" })).toBeNull();
    expect(within(card).queryAllByRole("switch")).toHaveLength(0);
  });
});
