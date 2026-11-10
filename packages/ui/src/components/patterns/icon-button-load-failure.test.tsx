// @vitest-environment happy-dom
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { IconButton } from "./icon-button.tsx";

vi.mock("./icon-button-tooltip.tsx", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

describe("IconButton when the tooltip chunk does not load", () => {
  it("stays on the page without a tooltip", async () => {
    const user = userEvent.setup();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <IconButton label="Statistics" tooltip>
        i
      </IconButton>,
    );
    await user.hover(screen.getByRole("button", { name: "Statistics" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    expect(screen.getByRole("button", { name: "Statistics" })).toBeTruthy();
    expect(document.querySelector("[data-slot=tooltip-content]")).toBeNull();
    errors.mockRestore();
  });
});
