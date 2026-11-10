// @vitest-environment happy-dom
import { changeLocale } from "@gerlines/i18n";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialState, useAppStore } from "../../state/store.ts";
import { ColourKey } from "./ColourKey.tsx";

beforeEach(async () => {
  await changeLocale("en", { persist: false });
  useAppStore.setState(initialState());
});
afterEach(() => {
  cleanup();
  for (const name of ["scrollWidth", "clientWidth", "scrollLeft"]) {
    Reflect.deleteProperty(HTMLElement.prototype, name);
  }
});

function shown(group: HTMLElement): string[] {
  return within(group)
    .getAllByRole("listitem")
    .map((item) => item.querySelector("[aria-hidden=true]:not(svg)")?.textContent ?? "");
}

function named(group: HTMLElement): string[] {
  return within(group)
    .getAllByRole("listitem")
    .map((item) => item.querySelector(".sr-only")?.textContent ?? "");
}

function measure(box: { scrollWidth: number; clientWidth: number; scrollLeft?: number }) {
  for (const [name, value] of Object.entries({ scrollLeft: 0, ...box })) {
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      writable: true,
      value,
    });
  }
}

describe("ColourKey", () => {
  it("shows one swatch per category in legend order, before any data has arrived", () => {
    render(<ColourKey />);
    const group = screen.getByRole("group", { name: "Colour key, train categories" });
    expect(shown(group)).toEqual(["ICE", "IC", "Night", "RE", "RB", "S-Bahn", "Foreign"]);
    const marks = [...group.querySelectorAll("svg[data-category]")].map((svg) =>
      svg.getAttribute("data-category"),
    );
    expect(marks).toEqual(["hsr", "ld", "night", "rfast", "reg", "sbahn", "foreign"]);
  });

  it("names every swatch by its full legend label, so ICE is not read as ICE alone", () => {
    render(<ColourKey />);
    expect(named(screen.getByRole("group"))).toEqual([
      "ICE and high speed",
      "IC, EC, FLX",
      "Night trains",
      "RE, IRE, MEX",
      "RB",
      "S-Bahn",
      "Foreign trains",
    ]);
  });

  it("follows the colour mode: delay classes with foreign trains, then operator groups", () => {
    useAppStore.setState({ colourMode: "delay" });
    const view = render(<ColourKey />);
    const delay = screen.getByRole("group", { name: "Colour key, delay in minutes" });
    expect(shown(delay)).toEqual([
      "Under 3 min",
      "3 to 5",
      "6 to 14",
      "15 plus",
      "No data",
      "Foreign",
    ]);
    expect(named(delay)).toContain("Foreign trains");
    expect(named(delay)[0]).toMatch(/^On time, under 3\s+min$/);
    view.unmount();
    useAppStore.setState({ colourMode: "operator" });
    render(<ColourKey />);
    const operator = screen.getByRole("group", { name: "Colour key, operator groups" });
    expect(shown(operator)).toEqual([
      "DB",
      "Transdev",
      "Netinera",
      "KVVH",
      "HLB",
      "SWEG",
      "Other",
      "Unknown",
    ]);
    expect(named(operator).slice(0, 2)).toEqual(["Deutsche Bahn", "Transdev"]);
    expect(named(operator)[4]).toBe("Hessische Landesbahn");
    expect(named(operator).slice(6)).toEqual(["Other operators", "Operator unknown"]);
  });

  it("takes its swatch colours from the same tokens as the map and the legend", () => {
    useAppStore.setState({ colourMode: "delay" });
    render(<ColourKey />);
    const fills = [...screen.getByRole("group").querySelectorAll("circle")].map((circle) =>
      circle.getAttribute("fill"),
    );
    expect(fills).toEqual([
      "var(--gl-delay-ok)",
      "var(--gl-delay-minor)",
      "var(--gl-delay-major)",
      "var(--gl-delay-severe)",
      "var(--gl-cat-foreign)",
      "var(--gl-cat-foreign)",
    ]);
  });

  it("dims and names a hidden category", () => {
    useAppStore.setState({ hiddenCategories: ["hsr", "foreign"] });
    render(<ColourKey />);
    const items = within(screen.getByRole("group")).getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-hidden"))).toEqual([
      "true",
      "false",
      "false",
      "false",
      "false",
      "false",
      "true",
    ]);
    expect(items[0]?.className).toContain("opacity-40");
    expect(items[0]?.querySelector(".sr-only")?.textContent).toBe("ICE and high speed, hidden");
    expect(items[1]?.querySelector(".sr-only")?.textContent).toBe("IC, EC, FLX");
  });

  it("dims and names a hidden operator group, and the hidden foreign trains in the delay key", () => {
    useAppStore.setState({ colourMode: "operator", hiddenOperatorGroups: ["transdev", "unknown"] });
    const view = render(<ColourKey />);
    const hidden = within(screen.getByRole("group"))
      .getAllByRole("listitem")
      .filter((item) => item.getAttribute("data-hidden") === "true")
      .map((item) => item.querySelector(".sr-only")?.textContent);
    expect(hidden).toEqual(["Transdev, hidden", "Operator unknown, hidden"]);
    view.unmount();
    useAppStore.setState({ colourMode: "delay", hiddenCategories: ["foreign"] });
    render(<ColourKey />);
    const items = within(screen.getByRole("group")).getAllByRole("listitem");
    expect(items.at(-1)?.getAttribute("data-hidden")).toBe("true");
    expect(items[0]?.getAttribute("data-hidden")).toBe("false");
  });

  it("is worded in German and Polish", async () => {
    await changeLocale("de", { persist: false });
    const view = render(<ColourKey />);
    expect(shown(screen.getByRole("group", { name: "Farbschlüssel, Zugkategorien" }))).toEqual([
      "ICE",
      "IC",
      "Nacht",
      "RE",
      "RB",
      "S-Bahn",
      "Ausland",
    ]);
    view.unmount();
    await changeLocale("pl", { persist: false });
    useAppStore.setState({ colourMode: "delay" });
    render(<ColourKey />);
    const group = screen.getByRole("group", { name: "Legenda kolorów, opóźnienie w minutach" });
    expect(shown(group)[0]).toBe("Poniżej 3 min");
    expect(shown(group)[3]).toBe("Od 15");
  });

  it("names the Polish abbreviation in full for a screen reader", async () => {
    await changeLocale("pl", { persist: false });
    render(<ColourKey />);
    const group = screen.getByRole("group");
    expect(shown(group).at(-1)).toBe("Zagran.");
    expect(named(group).at(-1)).toBe("Pociągi zagraniczne");
  });

  describe("when the row holds fewer colours than the mode has", () => {
    it("is not focusable and has no fade while everything fits", () => {
      measure({ scrollWidth: 300, clientWidth: 300 });
      render(<ColourKey />);
      expect(screen.getByRole("group").getAttribute("tabindex")).toBeNull();
      expect(document.querySelector("[data-slot=colour-key-fade]")).toBeNull();
    });

    it("takes focus and shows the fade at the start, keeping the focus ring off the faded box", () => {
      measure({ scrollWidth: 470, clientWidth: 364 });
      render(<ColourKey />);
      const group = screen.getByRole("group");
      expect(group.getAttribute("tabindex")).toBe("0");
      expect(group.className).toContain("focus-ring");
      expect(group.className).not.toContain("mask");
      expect(document.querySelector("[data-slot=colour-key-fade]")).toBeTruthy();
    });

    it("drops the fade once it is scrolled to the end and brings it back on the way", () => {
      measure({ scrollWidth: 470, clientWidth: 364 });
      render(<ColourKey />);
      const group = screen.getByRole("group");
      act(() => {
        Object.defineProperty(HTMLElement.prototype, "scrollLeft", {
          configurable: true,
          writable: true,
          value: 106,
        });
        fireEvent.scroll(group);
      });
      expect(document.querySelector("[data-slot=colour-key-fade]")).toBeNull();
      expect(group.getAttribute("tabindex")).toBe("0");
      act(() => {
        Object.defineProperty(HTMLElement.prototype, "scrollLeft", {
          configurable: true,
          writable: true,
          value: 40,
        });
        fireEvent.scroll(group);
      });
      expect(document.querySelector("[data-slot=colour-key-fade]")).toBeTruthy();
    });

    it("changes with the mode: the same row measured again lists the other colours", () => {
      measure({ scrollWidth: 470, clientWidth: 364 });
      render(<ColourKey />);
      act(() => useAppStore.setState({ colourMode: "operator" }));
      expect(screen.getByRole("group", { name: "Colour key, operator groups" })).toBeTruthy();
      expect(within(screen.getByRole("group")).getAllByRole("listitem").length).toBe(8);
    });
  });
});
