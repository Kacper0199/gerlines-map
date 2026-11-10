// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SearchField } from "../patterns/search-field.tsx";
import { Button } from "./button.tsx";
import { Separator } from "./separator.tsx";

describe("Separator", () => {
  it("sets the orientation attribute that its height and width classes select on", () => {
    const horizontal = render(<Separator />);
    const element = horizontal.container.firstElementChild;
    expect(element?.getAttribute("data-orientation")).toBe("horizontal");
    expect(element?.className).toContain("data-[orientation=horizontal]:h-px");
    expect(element?.className).not.toContain("data-horizontal:");
    horizontal.unmount();
    const vertical = render(<Separator orientation="vertical" />);
    expect(vertical.container.firstElementChild?.getAttribute("data-orientation")).toBe("vertical");
    expect(vertical.container.firstElementChild?.className).toContain(
      "data-[orientation=vertical]:w-px",
    );
  });
});

describe("Button loading", () => {
  it("marks the button so its spinner replaces the leading icon", () => {
    render(
      <Button loading>
        <svg data-testid="icon" aria-hidden="true" />
        Copy link
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Copy link" });
    expect(button.hasAttribute("data-loading")).toBe(true);
    expect(button.querySelector("[data-spinner]")).not.toBeNull();
    expect(button.className).toContain("data-loading:[&>svg:not([data-spinner])]:hidden");
  });
});

describe("SearchField", () => {
  it("moves focus back to the input after clearing and links the error text", async () => {
    const user = userEvent.setup();
    render(
      <SearchField
        label="Search"
        clearLabel="Clear"
        defaultValue="ICE"
        invalid
        describedBy="why"
      />,
    );
    const input = screen.getByRole("searchbox");
    expect(input.getAttribute("aria-describedby")).toBe("why");
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(document.activeElement).toBe(input);
  });
});
