import { type RefObject, useEffect } from "react";
import { usePanelStore } from "../state/panel-store.ts";

/** Moves the focus to a panel's heading when the user opened the panel, never when it came back after a card closed. */
export function useFocusOnOpen(heading: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    if (enabled && !usePanelStore.getState().resumed) {
      heading.current?.focus({ preventScroll: true });
    }
  }, [heading, enabled]);
}
