import { useCopy } from "@gerlines/i18n/react";
import { DelayValue } from "@gerlines/ui";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TrainCardModel } from "../model.ts";
import { trainTitle } from "./CardHead.tsx";

/** True once the title inside `head` has scrolled out of its scroller, so a bar can keep it in view. */
export function useScrolledAway(head: HTMLElement | null): boolean {
  const [away, setAway] = useState(false);
  useEffect(() => {
    if (!head || typeof IntersectionObserver === "undefined") {
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      const latest = entries[entries.length - 1];
      if (latest) {
        setAway(!latest.isIntersecting);
      }
    });
    observer.observe(head.querySelector("h2") ?? head);
    return () => {
      observer.disconnect();
      setAway(false);
    };
  }, [head]);
  return away;
}

/**
 * The title and the delay of the card, pinned at the top of its scroller while the card head is
 * scrolled away. It takes no room in the flow. The phone sheet has its own head with Close, so the
 * bar is then hidden from assistive technology, which reads the real heading; on a desktop the bar
 * carries Close (`closeSlot`) and only its title and delay are hidden.
 */
export function StuckTitle({
  model,
  closeSlot,
  onLeaveWithFocus,
}: {
  model: TrainCardModel;
  closeSlot?: ReactNode;
  /** Called as the bar goes away while the focus is inside it, so the focus does not fall to the page. */
  onLeaveWithFocus?: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const leave = useRef(onLeaveWithFocus);
  leave.current = onLeaveWithFocus;
  useLayoutEffect(() => {
    const node = root.current;
    return () => {
      if (node?.contains(document.activeElement)) leave.current?.();
    };
  }, []);
  const copy = useCopy();
  const title = trainTitle(model, copy.train, copy.card.train);
  const hidden = closeSlot === undefined;
  return (
    <div
      ref={root}
      data-slot="stuck-title"
      aria-hidden={hidden || undefined}
      className="pointer-events-none sticky top-0 z-30 -mb-3 h-0"
    >
      <div className="pointer-events-auto flex h-10 items-center justify-between gap-3 border-b border-hairline bg-surface px-4">
        <span
          aria-hidden={hidden ? undefined : "true"}
          className="type-body-strong min-w-0 truncate"
        >
          {title}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {model.cancelled ? (
            <span
              aria-hidden={hidden ? undefined : "true"}
              className="type-label shrink-0 text-error"
            >
              {copy.train.cancelled}
            </span>
          ) : (
            <span aria-hidden={hidden ? undefined : "true"}>
              <DelayValue
                minutes={model.delayMinutes}
                labels={copy.delay}
                size="inline"
                className={model.realtime ? "shrink-0" : "shrink-0 text-ink-muted"}
              />
            </span>
          )}
          {closeSlot}
        </span>
      </div>
    </div>
  );
}
