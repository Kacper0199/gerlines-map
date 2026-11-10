// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { IconButton } from "./icon-button.tsx";

const TIP = { selector: "[data-slot=tooltip-content]" };

describe("IconButton tooltip", () => {
  it("renders the plain button and loads no tooltip until the pointer comes or focus arrives", () => {
    render(
      <IconButton label="Statistics" tooltip>
        i
      </IconButton>,
    );
    expect(screen.getByRole("button", { name: "Statistics" })).toBeTruthy();
    expect(document.querySelector("[data-slot=tooltip-content]")).toBeNull();
  });

  it("shows the name on hover below or above the button and hides it when the pointer leaves", async () => {
    const user = userEvent.setup();
    render(
      <IconButton label="Statistics" tooltip tooltipSide="bottom">
        i
      </IconButton>,
    );
    const button = screen.getByRole("button", { name: "Statistics" });
    await user.hover(button);
    const tip = await screen.findByText("Statistics", TIP);
    expect(tip.closest("[data-side]")?.getAttribute("data-side")).toBe("bottom");
    await user.unhover(button);
    await waitFor(() => expect(document.querySelector("[data-slot=tooltip-content]")).toBeNull());
  });

  it("shows on keyboard focus, closes on Escape and keeps the same button element", async () => {
    const user = userEvent.setup();
    render(
      <IconButton label="Plan a journey" tooltip>
        i
      </IconButton>,
    );
    const before = screen.getByRole("button", { name: "Plan a journey" });
    await user.tab();
    expect(document.activeElement).toBe(before);
    await screen.findByText("Plan a journey", TIP);
    expect(screen.getByRole("button", { name: "Plan a journey" })).toBe(before);
    await user.keyboard("{Escape}");
    expect(document.querySelector("[data-slot=tooltip-content]")).toBeNull();
    expect(document.activeElement).toBe(before);
  });

  it("closes on press and leaves the button's own handlers working", async () => {
    const user = userEvent.setup();
    let clicks = 0;
    let entered = 0;
    render(
      <IconButton
        label="Statistics"
        tooltip
        onClick={() => {
          clicks += 1;
        }}
        onPointerEnter={() => {
          entered += 1;
        }}
      >
        i
      </IconButton>,
    );
    const button = screen.getByRole("button", { name: "Statistics" });
    await user.hover(button);
    await screen.findByText("Statistics", TIP);
    await user.click(button);
    expect(clicks).toBe(1);
    expect(entered).toBeGreaterThan(0);
    await waitFor(() => expect(document.querySelector("[data-slot=tooltip-content]")).toBeNull());
  });

  it("stays silent for a touch pointer", async () => {
    render(
      <IconButton label="Statistics" tooltip>
        i
      </IconButton>,
    );
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Statistics" }), {
      pointerType: "touch",
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });
    expect(document.querySelector("[data-slot=tooltip-content]")).toBeNull();
  });

  it("adds nothing without the tooltip prop", async () => {
    const user = userEvent.setup();
    render(<IconButton label="Close">x</IconButton>);
    await user.hover(screen.getByRole("button", { name: "Close" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(document.querySelector("[data-slot=tooltip-content]")).toBeNull();
  });

  it("stays open while the pointer crosses from the button onto the tooltip, and closes after it leaves", async () => {
    const user = userEvent.setup();
    render(
      <IconButton label="Statistics" tooltip>
        i
      </IconButton>,
    );
    const button = screen.getByRole("button", { name: "Statistics" });
    await user.hover(button);
    const tip = await screen.findByText("Statistics", TIP);
    await user.unhover(button);
    await user.hover(tip);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(document.querySelector("[data-slot=tooltip-content]")).not.toBeNull();
    await user.unhover(tip);
    await waitFor(() => expect(document.querySelector("[data-slot=tooltip-content]")).toBeNull());
  });

  it("closes on Escape pressed anywhere while a hover opened it", async () => {
    const user = userEvent.setup();
    render(
      <IconButton label="Statistics" tooltip>
        i
      </IconButton>,
    );
    await user.hover(screen.getByRole("button", { name: "Statistics" }));
    await screen.findByText("Statistics", TIP);
    expect(document.activeElement).toBe(document.body);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.querySelector("[data-slot=tooltip-content]")).toBeNull());
  });

  it("keeps a caller's ref and still shows the tooltip", async () => {
    const user = userEvent.setup();
    const seen: (HTMLElement | null)[] = [];
    render(
      <IconButton label="Statistics" tooltip ref={(node) => void seen.push(node)}>
        i
      </IconButton>,
    );
    const button = screen.getByRole("button", { name: "Statistics" });
    expect(seen).toContain(button);
    await user.hover(button);
    await screen.findByText("Statistics", TIP);
  });
});
