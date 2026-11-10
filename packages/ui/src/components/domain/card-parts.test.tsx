// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Notice } from "../patterns/notice.tsx";
import { DelayChip, delayChipText } from "./delay-chip.tsx";
import { RailSegment, StopMarker } from "./route-rail.tsx";

describe("DelayChip", () => {
  it("writes late, on time and early minutes with a sign", () => {
    expect(delayChipText(6)).toBe("+6");
    expect(delayChipText(0)).toBe("+0");
    expect(delayChipText(-2)).toBe("−2");
    expect(delayChipText(null)).toBeNull();
  });

  it("renders nothing when there is no realtime value for the stop", () => {
    const { container } = render(<DelayChip minutes={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("uses the mono face in muted ink, never a red", () => {
    const { container } = render(<DelayChip minutes={39} />);
    const chip = container.querySelector("[data-slot=delay-chip]");
    expect(chip?.className).toContain("num");
    expect(chip?.className).toContain("text-ink-muted");
    expect(chip?.className).not.toMatch(/error|delay-major/);
  });

  it("names the value for assistive technology", () => {
    render(<DelayChip minutes={4} label="Delay" />);
    expect(screen.getByText("Delay")).toBeTruthy();
  });
});

describe("StopMarker and RailSegment", () => {
  it("draws the next stop as the large amber ring", () => {
    const { container } = render(<StopMarker kind="next" />);
    const marker = container.querySelector("[data-slot=stop-marker]");
    expect(marker?.getAttribute("data-kind")).toBe("next");
    expect(marker?.className).toContain("size-5");
    expect(marker?.className).toContain("--gl-primary-text");
    expect(marker?.getAttribute("aria-hidden")).toBe("true");
  });

  it("draws a cancelled stop with the error colour on the ring only", () => {
    const { container } = render(<StopMarker kind="cancelled" />);
    expect(container.querySelector("[data-slot=stop-marker]")?.className).toContain("--gl-error");
  });

  it("colours the passed and the ahead parts of the line and can draw itself", () => {
    const { container } = render(
      <>
        <RailSegment tone="passed" span="upper" />
        <RailSegment tone="ahead" span="lower" draw />
      </>,
    );
    const [passed, ahead] = container.querySelectorAll("[data-slot=rail]");
    expect(passed?.className).toContain("bg-passed");
    expect(passed?.className).not.toContain("rail-draw");
    expect(ahead?.className).toContain("bg-selection-text");
    expect(ahead?.className).toContain("rail-draw");
  });
});

describe("Notice", () => {
  it("keeps the text in ink and marks errors with the border and icon", () => {
    const { container } = render(
      <Notice tone="error" role="alert" icon={<svg />}>
        Could not load
      </Notice>,
    );
    const notice = screen.getByRole("alert");
    expect(notice.className).toContain("border-error");
    expect(notice.className).toContain("text-ink");
    expect(container.querySelector("[aria-hidden=true]")?.className).toContain("text-error");
  });

  it("renders an action beside the text", () => {
    render(<Notice action={<button type="button">Try again</button>}>Text</Notice>);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
