import { useA11yCopy } from "@gerlines/i18n/a11y";
import { type RefObject, useEffect, useState } from "react";
import type { TrainMap } from "../map/train-map.ts";
import { createAnnouncer, SUMMARY_GAP_MS } from "./announcer.ts";
import { IN_VIEW_COUNT, useInViewStore } from "./store.ts";

function isEditing(element: Element | null): boolean {
  return (
    element instanceof HTMLElement &&
    (element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName))
  );
}

/**
 * Connects the map to the trains in view list and keeps the one sentence summary of the view in a polite region.
 * The summary changes only after the user moved the map and at most every ten seconds.
 */
export function InViewHost({ handle }: { handle: RefObject<TrainMap | null> }) {
  const copy = useA11yCopy();
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    const attach = useInViewStore.getState().attach;
    attach(async () => {
      const map = handle.current;
      if (map === null) throw new Error("the map is not ready");
      return map.nearestTrains(IN_VIEW_COUNT);
    });
    return () => attach(null);
  }, [handle]);
  useEffect(() => {
    const announcer = createAnnouncer({
      gapMs: SUMMARY_GAP_MS,
      now: () => Date.now(),
      setTimer: (run, ms) => window.setTimeout(run, ms),
      clearTimer: (id) => window.clearTimeout(id),
      announce: () => {
        if (isEditing(document.activeElement)) return;
        void useInViewStore
          .getState()
          .refresh()
          .then((answer) => {
            if (answer !== null && !isEditing(document.activeElement)) {
              setCount(answer.result.inView);
            }
          });
      },
    });
    let seen = useInViewStore.getState().moves;
    const stop = useInViewStore.subscribe((state) => {
      if (state.moves === seen) return;
      seen = state.moves;
      announcer.moved();
    });
    return () => {
      stop();
      announcer.dispose();
    };
  }, []);
  return (
    <p role="status" data-slot="view-summary" className="sr-only">
      {count === null ? "" : copy.viewSummary(count)}
    </p>
  );
}
