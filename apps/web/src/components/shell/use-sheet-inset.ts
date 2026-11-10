import { type RefObject, useLayoutEffect } from "react";

const GAP_PX = 8;

/**
 * Publishes the bottom edge of the cards at the top of the phone screen as `--gl-sheet-inset`, so
 * an expanded bottom sheet stops below them instead of lying over the search card.
 */
export function useSheetInset(top: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const element = top.current;
    if (element === null) return;
    const root = document.documentElement;
    const apply = () => {
      const bottom = Math.ceil(element.getBoundingClientRect().bottom);
      root.style.setProperty("--gl-sheet-inset", `${bottom + GAP_PX}px`);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--gl-sheet-inset");
    };
  }, [top]);
}
