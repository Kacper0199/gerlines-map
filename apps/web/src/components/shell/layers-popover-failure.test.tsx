// @vitest-environment happy-dom
import { changeLocale } from "@gerlines/i18n";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LayersPopover } from "./LayersPopover.tsx";

vi.mock("./LayersPopoverBody.tsx", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

beforeEach(async () => {
  await changeLocale("en");
});
afterEach(cleanup);

describe("LayersPopover when its popup chunk does not load", () => {
  it("keeps the button, shows no popup and does not take the page down", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const user = userEvent.setup();
    render(<LayersPopover />);
    const button = screen.getByRole("button", { name: "Map layers" });
    await user.click(button);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(screen.getByRole("button", { name: "Map layers" })).toBe(button);
    expect(document.querySelector("[data-slot=popover-content]")).toBeNull();
    errors.mockRestore();
  });
});
