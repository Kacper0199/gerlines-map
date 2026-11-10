// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSheetInset } from "./use-sheet-inset.ts";

let notify: () => void = () => undefined;

class FakeObserver {
  constructor(callback: () => void) {
    notify = callback;
  }
  observe(): void {}
  disconnect(): void {}
}

function Holder({ bottom }: { bottom: { value: number } }) {
  const ref = useRef<HTMLDivElement>(null);
  useSheetInset(ref);
  return (
    <div
      ref={(node) => {
        ref.current = node;
        if (node) node.getBoundingClientRect = () => ({ bottom: bottom.value }) as DOMRect;
      }}
    />
  );
}

beforeEach(() => vi.stubGlobal("ResizeObserver", FakeObserver));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty("--gl-sheet-inset");
});

const inset = () => document.documentElement.style.getPropertyValue("--gl-sheet-inset");

describe("useSheetInset", () => {
  it("publishes the bottom edge of the top cards plus a gap, and follows their height", () => {
    const bottom = { value: 168 };
    render(<Holder bottom={bottom} />);
    expect(inset()).toBe("176px");
    bottom.value = 214.4;
    notify();
    expect(inset()).toBe("223px");
  });

  it("removes the property when the shell goes away, so the fallback applies again", () => {
    const view = render(<Holder bottom={{ value: 150 }} />);
    expect(inset()).toBe("158px");
    view.unmount();
    expect(inset()).toBe("");
  });
});
