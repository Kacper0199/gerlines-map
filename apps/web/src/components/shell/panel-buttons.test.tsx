// @vitest-environment happy-dom
import { changeLocale } from "@gerlines/i18n";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetPanelStore } from "../../state/panel-store.ts";
import { LayersPopover } from "./LayersPopover.tsx";
import { PanelButtons } from "./PanelButtons.tsx";

beforeEach(async () => {
  await changeLocale("en", { persist: false });
  resetPanelStore();
});
afterEach(() => {
  cleanup();
  resetPanelStore();
});

describe("panel buttons in the search row", () => {
  it("are a pair of the same form with their names", () => {
    render(<PanelButtons />);
    const plan = screen.getByRole("button", { name: "Plan a journey" });
    const stats = screen.getByRole("button", { name: "Statistics" });
    expect(stats.className).toBe(plan.className);
    expect(stats.textContent).toBe("");
    expect(plan.parentElement).toBe(stats.parentElement);
  });

  it("press one at a time", async () => {
    const user = userEvent.setup();
    render(<PanelButtons />);
    const plan = screen.getByRole("button", { name: "Plan a journey" });
    const stats = screen.getByRole("button", { name: "Statistics" });
    await user.click(stats);
    expect([plan.getAttribute("aria-pressed"), stats.getAttribute("aria-pressed")]).toEqual([
      "false",
      "true",
    ]);
    await user.click(plan);
    expect([plan.getAttribute("aria-pressed"), stats.getAttribute("aria-pressed")]).toEqual([
      "true",
      "false",
    ]);
    await user.click(plan);
    expect([plan.getAttribute("aria-pressed"), stats.getAttribute("aria-pressed")]).toEqual([
      "false",
      "false",
    ]);
  });

  it("show their names below the buttons, clear of the tagline above them", async () => {
    const user = userEvent.setup();
    render(<PanelButtons />);
    await user.hover(screen.getByRole("button", { name: "Statistics" }));
    const tip = await screen.findByText("Statistics", { selector: "[data-slot=tooltip-content]" });
    expect(tip.closest("[data-side]")?.getAttribute("data-side")).toBe("bottom");

    await user.unhover(screen.getByRole("button", { name: "Statistics" }));
    await user.hover(screen.getByRole("button", { name: "Plan a journey" }));
    const planTip = await screen.findByText("Plan a journey", {
      selector: "[data-slot=tooltip-content]",
    });
    expect(planTip.closest("[data-side]")?.getAttribute("data-side")).toBe("bottom");
  });

  it("leave the layers sheet without a statistics entry", async () => {
    const user = userEvent.setup();
    render(<LayersPopover />);
    await user.click(screen.getByRole("button", { name: /layers/i }));
    await screen.findByRole("dialog");
    expect(screen.queryByRole("button", { name: "Statistics" })).toBeNull();
  });

  it("closes the layers sheet with a second press of its button and keeps the button", async () => {
    const user = userEvent.setup();
    render(<LayersPopover />);
    const button = screen.getByRole("button", { name: /layers/i });
    await user.click(button);
    await screen.findByRole("dialog");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    await user.click(button);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await user.click(button);
    await screen.findByRole("dialog");
  });

  it("keeps the layers sheet inside the screen: its height follows the room the positioner leaves", async () => {
    const user = userEvent.setup();
    render(<LayersPopover />);
    await user.click(screen.getByRole("button", { name: /layers/i }));
    await screen.findByRole("dialog");
    const classes = document.querySelector("[data-slot=popover-content]")?.className.split(" ");
    expect(classes).toContain("max-h-(--available-height)");
    expect(classes).toContain("overflow-y-auto");
  });
});
