// @vitest-environment happy-dom
import { changeLocale } from "@gerlines/i18n";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { axeViolations } from "../../../test/helpers/axe.ts";
import { SHORTCUTS_STORAGE_KEY, useShortcutsStore } from "../../a11y/shortcuts.ts";
import { initialState, useAppStore } from "../../state/store.ts";
import { StylePicker } from "./StylePicker.tsx";

beforeEach(async () => {
  await changeLocale("en");
  useAppStore.setState(initialState());
  useShortcutsStore.getState().setEnabled(true);
});
afterEach(() => {
  cleanup();
  window.localStorage.removeItem(SHORTCUTS_STORAGE_KEY);
});

describe("keyboard shortcuts switch in the layers area", () => {
  it("is on by default, named and described", () => {
    render(<StylePicker />);
    const toggle = screen.getByRole("switch", { name: "Keyboard shortcuts" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.getAttribute("aria-describedby")).not.toBeNull();
    const description = document.getElementById(toggle.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toBe("The slash key jumps to the search.");
  });

  it("turns the shortcuts off and on again and remembers the choice", async () => {
    const user = userEvent.setup();
    render(<StylePicker />);
    const toggle = screen.getByRole("switch", { name: "Keyboard shortcuts" });
    await user.click(toggle);
    expect(useShortcutsStore.getState().enabled).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(window.localStorage.getItem(SHORTCUTS_STORAGE_KEY)).toBe("off");
    await user.click(toggle);
    expect(useShortcutsStore.getState().enabled).toBe(true);
    expect(window.localStorage.getItem(SHORTCUTS_STORAGE_KEY)).toBe("on");
  });

  it("has no axe violations and reads in German", async () => {
    const { container } = render(<StylePicker />);
    expect(await axeViolations(container)).toEqual([]);
    cleanup();
    await changeLocale("de");
    render(<StylePicker />);
    expect(screen.getByRole("switch", { name: "Tastenkürzel" })).toBeTruthy();
  });
});
