// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BottomSheet, SheetMore } from "./bottom-sheet.tsx";

function sheet(props: Partial<React.ComponentProps<typeof BottomSheet>> = {}) {
  return render(
    <BottomSheet
      label="Selected train"
      expandLabel="Show more"
      collapseLabel="Show less"
      {...props}
    >
      <button type="button">Follow</button>
      <SheetMore>
        <button type="button">Below the peek</button>
      </SheetMore>
    </BottomSheet>,
  );
}

async function drag(
  user: ReturnType<typeof userEvent.setup>,
  handle: HTMLElement,
  from: number,
  to: number,
) {
  await user.pointer([
    { keys: "[MouseLeft>]", target: handle, coords: { clientY: from } },
    { coords: { clientY: to } },
    { keys: "[/MouseLeft]", target: handle, coords: { clientY: to } },
  ]);
}

describe("BottomSheet drag", () => {
  it("ends expanded after an upward mouse drag, the click that follows does not toggle it back", async () => {
    const user = userEvent.setup();
    sheet();
    const handle = screen.getByRole("button", { name: "Show more" });
    await drag(user, handle, 400, 320);
    expect(screen.getByRole("region").dataset.state).toBe("expanded");
  });

  it("collapses after a downward drag and a click still toggles afterwards", async () => {
    const user = userEvent.setup();
    sheet({ defaultExpanded: true });
    await drag(user, screen.getByRole("button", { name: "Show less" }), 300, 380);
    expect(screen.getByRole("region").dataset.state).toBe("peek");
    await user.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByRole("region").dataset.state).toBe("expanded");
  });

  it("treats a short movement as a click", async () => {
    const user = userEvent.setup();
    sheet();
    await drag(user, screen.getByRole("button", { name: "Show more" }), 400, 390);
    expect(screen.getByRole("region").dataset.state).toBe("expanded");
  });

  it("forgets a drag that was cancelled", () => {
    const onExpandedChange = vi.fn();
    sheet({ onExpandedChange });
    const handle = screen.getByRole("button", { name: "Show more" });
    fireEvent.pointerDown(handle, { clientY: 400, pointerId: 1 });
    fireEvent.pointerCancel(handle, { pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 300, pointerId: 1 });
    expect(onExpandedChange).not.toHaveBeenCalled();
  });
});

describe("BottomSheet focus", () => {
  it("makes the content below the peek inert while collapsed", async () => {
    const user = userEvent.setup();
    sheet();
    const region = screen.getByText("Below the peek").closest("[inert]");
    expect(region).not.toBeNull();
    expect(region?.getAttribute("aria-hidden")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByText("Below the peek").closest("[inert]")).toBeNull();
  });

  it("returns focus to the handle when escape collapses the sheet", async () => {
    const user = userEvent.setup();
    sheet({ defaultExpanded: true });
    screen.getByRole("button", { name: "Below the peek" }).focus();
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show more" }));
  });

  it("marks the escape key as handled so a surrounding listener can leave the card open", () => {
    sheet({ defaultExpanded: true });
    const handled = fireEvent.keyDown(screen.getByRole("button", { name: "Below the peek" }), {
      key: "Escape",
    });
    expect(handled).toBe(false);
  });

  it("leaves escape alone when it does not collapse, so the surrounding panel can close the sheet", async () => {
    const user = userEvent.setup();
    sheet({ defaultExpanded: true, collapseOnEscape: false });
    const below = screen.getByRole("button", { name: "Below the peek" });
    below.focus();
    const handled = fireEvent.keyDown(below, { key: "Escape" });
    expect(handled).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  it("does not mark escape as handled while collapsed", () => {
    sheet();
    const handled = fireEvent.keyDown(screen.getByRole("button", { name: "Show more" }), {
      key: "Escape",
    });
    expect(handled).toBe(true);
  });

  it("renders the handle and the trailing part in their own head row", () => {
    sheet({ trailing: <button type="button">Close</button> });
    const head = screen.getByText("Close").closest("[data-slot=bottom-sheet-head]");
    expect(head?.querySelector("button[aria-label='Show more']")).not.toBeNull();
    expect(head?.textContent).toContain("Close");
  });

  it("puts the leading part left of the handle and the trailing part right of it", () => {
    sheet({ leading: <span>High speed</span>, trailing: <button type="button">Close</button> });
    const head = screen.getByText("High speed").closest("[data-slot=bottom-sheet-head]");
    const text = head?.textContent ?? "";
    expect(text.indexOf("High speed")).toBeLessThan(text.indexOf("Close"));
    expect(head?.firstElementChild?.textContent).toBe("High speed");
  });

  it("takes a taller peek when asked", () => {
    sheet({ peekHeight: 340 });
    expect(screen.getByRole("region").style.height).toBe("340px");
  });
});

describe("BottomSheet expanded height", () => {
  it("stops below whatever the shell publishes as its top inset, 120 px without one", () => {
    sheet({ defaultExpanded: true });
    const style = screen.getByRole("region").getAttribute("style") ?? "";
    expect(style).toContain("100dvh - var(--gl-sheet-inset, 120px)");
  });

  it("holds a content-sized sheet to the same inset", () => {
    sheet({ defaultExpanded: true, expandedFit: "content" });
    const style = screen.getByRole("region").getAttribute("style") ?? "";
    expect(style).toContain("max-height: calc(100dvh - var(--gl-sheet-inset, 120px))");
  });
});

describe("BottomSheet without more to show", () => {
  it("has no handle and sizes itself to its content", () => {
    sheet({ expandable: false, peekHeight: 300 });

    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
    const root = screen.getByRole("region", { name: "Selected train" });
    expect(root.getAttribute("data-state")).toBe("peek");
    expect(root.style.height).toBe("auto");
  });

  it("keeps the handle and the peek height by default", () => {
    sheet({ peekHeight: 300 });

    expect(screen.getByRole("button", { name: "Show more" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Selected train" }).style.height).toBe("300px");
  });
});
