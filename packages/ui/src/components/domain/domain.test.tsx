// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CategoryMark } from "./category-mark.tsx";
import {
  CATEGORY_ATLAS_ICONS,
  CHEVRON_PATH,
  CHEVRON_POINTS,
  drawCategoryAtlas,
  type PathContext,
  SHAPE_CELL,
} from "./category-shapes.ts";
import { type DelayLabels, DelayValue, delayParts } from "./delay-value.tsx";
import { Num } from "./num.tsx";
import { ClockText, TimePair } from "./time-pair.tsx";

const LABELS: DelayLabels = {
  onTime: "On time",
  noData: "No data",
  minutes: "min",
  early: "min early",
};

describe("Num", () => {
  it("narrows the group separator in English", () => {
    const { container } = render(<Num value={2665} />);
    expect(container.textContent).toBe("2,665");
    expect(container.querySelectorAll(".punct")).toHaveLength(1);
  });

  it("narrows the German group separators but not the decimal comma", () => {
    const { container } = render(
      <Num value={1234567.5} locale="de" options={{ maximumFractionDigits: 1 }} />,
    );
    expect(container.textContent).toBe("1.234.567,5");
    expect(container.querySelectorAll(".punct")).toHaveLength(2);
  });

  it("groups four digit Polish numbers with a no-break space (D-022)", () => {
    const small = render(<Num value={2665} locale="pl" />);
    expect(small.container.textContent).toBe("2\u00a0665");
    expect(small.container.querySelectorAll(".punct")).toHaveLength(1);
    small.unmount();
    const large = render(<Num value={1234567} locale="pl" />);
    expect(large.container.querySelectorAll(".punct")).toHaveLength(2);
  });

  it("uses the mono face with tabular figures", () => {
    const { container } = render(<Num value={7} className="extra" />);
    expect(container.firstElementChild?.className).toBe("num extra");
  });
});

describe("ClockText and TimePair", () => {
  it("narrows the colon", () => {
    const { container } = render(<ClockText text="21:35" />);
    expect(container.textContent).toBe("21:35");
    expect(container.querySelector(".punct")?.textContent).toBe(":");
  });

  it("leaves text that is not a clock time unchanged", () => {
    const { container } = render(<ClockText text="2135" />);
    expect(container.textContent).toBe("2135");
    expect(container.querySelector(".punct")).toBeNull();
  });

  it("strikes the scheduled time only when it differs", () => {
    const { container, rerender } = render(<TimePair predicted="21:35" scheduled="20:44" />);
    expect(container.querySelector("s")?.textContent).toBe("20:44");
    rerender(<TimePair predicted="21:35" scheduled="21:35" />);
    expect(container.querySelector("s")).toBeNull();
    rerender(<TimePair predicted="21:35" />);
    expect(container.querySelector("s")).toBeNull();
  });

  it("names both times for assistive technology when labels are given", () => {
    render(
      <TimePair
        predicted="21:35"
        scheduled="20:44"
        predictedLabel="Predicted"
        scheduledLabel="Scheduled"
      />,
    );
    expect(screen.getByText("Predicted")).toBeTruthy();
    expect(screen.getByText("Scheduled")).toBeTruthy();
  });
});

describe("delayParts and DelayValue", () => {
  it("formats late, early, on time and missing values", () => {
    expect(delayParts(51, LABELS)).toEqual({ value: "+51", unit: "min", numeric: true });
    expect(delayParts(-2, LABELS)).toEqual({ value: "2", unit: "min early", numeric: true });
    expect(delayParts(0, LABELS)).toEqual({ value: "On time", unit: undefined, numeric: false });
    expect(delayParts(null, LABELS)).toEqual({ value: "No data", unit: undefined, numeric: false });
  });

  it("uses the mono face for numbers and the text face for words", () => {
    const late = render(<DelayValue minutes={6} labels={LABELS} />);
    expect(late.container.querySelector(".num")?.textContent).toBe("+6");
    late.unmount();
    const word = render(<DelayValue minutes={0} labels={LABELS} />);
    expect(word.container.querySelector(".num")).toBeNull();
    expect(word.container.textContent).toBe("On time");
  });
});

describe("CategoryMark", () => {
  it("draws a filled dot for a regular category", () => {
    const { container } = render(<CategoryMark category="sbahn" />);
    const circle = container.querySelector("circle");
    expect(circle?.getAttribute("fill")).toBe("var(--gl-cat-sbahn)");
    expect(circle?.getAttribute("stroke")).toBe("none");
  });

  it("draws night trains hollow in the high speed colour", () => {
    const { container } = render(<CategoryMark category="night" />);
    const circle = container.querySelector("circle");
    expect(circle?.getAttribute("fill")).toBe("none");
    expect(circle?.getAttribute("stroke")).toBe("var(--gl-cat-hsr)");
  });

  it("mutes foreign trains and rotates chevrons by their heading", () => {
    const { container } = render(<CategoryMark category="foreign" shape="chevron" heading={90} />);
    expect(container.querySelector("svg")?.style.opacity).toBe("0.7");
    expect(container.querySelector("path")?.getAttribute("transform")).toBe("rotate(90 32 32)");
  });

  it("is hidden from assistive technology unless it has a title", () => {
    const hidden = render(<CategoryMark category="hsr" />);
    expect(hidden.container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    hidden.unmount();
    render(<CategoryMark category="hsr" title="ICE and high speed" />);
    expect(screen.getByRole("img", { name: "ICE and high speed" })).toBeTruthy();
  });
});

describe("category atlas", () => {
  it("shares the chevron outline of the first light atlas", () => {
    expect(CHEVRON_POINTS).toEqual([
      [32, 5],
      [55, 58],
      [32, 46],
      [9, 58],
    ]);
    expect(CHEVRON_PATH).toBe("M32 5L55 58L32 46L9 58Z");
    expect(CATEGORY_ATLAS_ICONS["chevron-hollow"].x).toBe(SHAPE_CELL);
  });

  it("draws a filled chevron in the first cell and a stroked one in the second", () => {
    const calls: string[] = [];
    const context: PathContext = {
      beginPath: () => calls.push("begin"),
      moveTo: (x, y) => calls.push(`move ${x} ${y}`),
      lineTo: (x, y) => calls.push(`line ${x} ${y}`),
      closePath: () => calls.push("close"),
      fill: () => calls.push("fill"),
      stroke: () => calls.push("stroke"),
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 0,
      lineJoin: "miter",
    };
    drawCategoryAtlas(context);
    expect(calls[1]).toBe("move 32 5");
    expect(calls).toContain("fill");
    expect(calls).toContain(`move ${SHAPE_CELL + 32} 5`);
    expect(calls.at(-1)).toBe("stroke");
    expect(context.lineWidth).toBe(7);
  });
});
