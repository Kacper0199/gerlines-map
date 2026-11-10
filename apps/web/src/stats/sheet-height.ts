import { type RefObject, useLayoutEffect } from "react";
import { setSheetPeek } from "../map/view-padding.ts";

/** Publishes the phone sheet's height for the attribution above it and the camera padding. */
export function useSheetHeight(body: RefObject<HTMLElement | null>, phone: boolean): void {
  useLayoutEffect(() => {
    const sheet = body.current?.closest<HTMLElement>("[data-slot=bottom-sheet]");
    if (!(phone && sheet)) return;
    const root = document.documentElement;
    const apply = () => {
      const height = Math.round(sheet.getBoundingClientRect().height);
      setSheetPeek(height);
      root.style.setProperty("--gl-sheet-peek", `${height}px`);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(sheet);
    return () => {
      observer.disconnect();
      setSheetPeek(null);
      root.style.removeProperty("--gl-sheet-peek");
    };
  }, [body, phone]);
}
