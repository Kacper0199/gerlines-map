import { type RefObject, useLayoutEffect, useState } from "react";

export const LIVE_BAR_HEIGHT_VAR = "--gl-live-bar-h";

/**
 * Publishes the measured height of the live bar as `--gl-live-bar-h` on `root`, so the left column
 * can end above the bar however many rows it wraps into. Returns the callback ref for the bar's
 * root element; the border box is observed, so padding changes count.
 */
export function useLiveBarHeight(
  root: RefObject<HTMLElement | null>,
): (bar: HTMLElement | null) => void {
  const [bar, setBar] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const container = root.current;
    if (!container || !bar) return;
    const apply = () => {
      const height = Math.ceil(bar.getBoundingClientRect().height);
      container.style.setProperty(LIVE_BAR_HEIGHT_VAR, `${height}px`);
    };
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(apply);
    observer.observe(bar, { box: "border-box" });
    return () => {
      observer.disconnect();
      container.style.removeProperty(LIVE_BAR_HEIGHT_VAR);
    };
  }, [root, bar]);
  return setBar;
}
