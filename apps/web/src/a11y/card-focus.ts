import { type RefObject, useEffect, useLayoutEffect } from "react";
import { useAppStore } from "../state/store.ts";

let pending: string | null = null;
let stop: (() => void) | null = null;

function lapse(): void {
  pending = null;
  stop?.();
  stop = null;
}

/**
 * A pick from the trains in view list asks the card of that train to take the focus when it appears:
 * the list unmounts with the pick, so the focus would otherwise fall back to the page.
 */
export function requestCardFocus(id: string): void {
  lapse();
  pending = id;
  stop = useAppStore.subscribe((state) => {
    if (state.selectedId !== id) lapse();
  });
}

/** True once for the card of the requested train; the request lapses when the selection moves on. */
export function takeCardFocus(): boolean {
  const mine = pending !== null && pending === useAppStore.getState().selectedId;
  lapse();
  return mine;
}

function focusIsFree(): boolean {
  return document.activeElement === null || document.activeElement === document.body;
}

/**
 * Gives the focus to a card heading (tabindex -1) when the list asked for it and the focus is free
 * (a user who moved on is never pulled back). When the heading that holds the focus unmounts while
 * the same train stays selected (a stand-in card replaced by the detail card), the request is made
 * again, so the next heading takes the focus instead of the page.
 */
export function useCardHeadingFocus(heading: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (takeCardFocus() && focusIsFree()) heading.current?.focus({ preventScroll: true });
  }, [heading]);
  useLayoutEffect(() => {
    const node = heading.current;
    return () => {
      const selected = useAppStore.getState().selectedId;
      if (node !== null && selected !== null && document.activeElement === node) {
        requestCardFocus(selected);
      }
    };
  }, [heading]);
}
