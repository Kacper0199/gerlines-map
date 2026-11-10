import { type RefObject, useLayoutEffect, useRef, useState } from "react";

const SUBPIXEL = 1;
const PINNING_ATTRIBUTE = "data-fit-pin";
const OPEN_PIN = `[${PINNING_ATTRIBUTE}][aria-expanded="true"]`;

export function overflows(box: { scrollHeight: number; clientHeight: number }): boolean {
  return box.scrollHeight > box.clientHeight + SUBPIXEL;
}

export function nextStep(walk: {
  index: number;
  last: number;
  overflowing: boolean;
  pinAt: number;
  pinned: boolean;
}): number {
  const ceiling = walk.pinned ? Math.min(walk.last, walk.pinAt) : walk.last;
  return walk.overflowing && walk.index < ceiling ? walk.index + 1 : walk.index;
}

function useBoxMetrics(box: RefObject<HTMLElement | null>): { height: number; content: number } {
  const [height, setHeight] = useState(0);
  const [content, setContent] = useState(0);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element || typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const observer = new ResizeObserver(() => {
      setHeight(element.clientHeight);
      setContent(element.scrollHeight);
    });
    observer.observe(element);
    for (const child of Array.from(element.children)) {
      observer.observe(child);
    }
    return () => observer.disconnect();
  }, [box]);
  return { height, content };
}

/**
 * Walks down `steps` until the content of `box` stops overflowing. The walk restarts at the first
 * step whenever the box changes height or `signature` changes, so a taller window opens it again.
 * It also continues from where it stands whenever the content grows, which the box and its
 * children report. While a control marked with `data-fit-pin` is expanded inside the box the walk
 * stops at `pinAt` and the box scrolls instead, so the control is never folded away under the user;
 * when the last such control closes, the walk starts again from the first step.
 */
export function useOverflowLadder<Step extends string>(
  box: RefObject<HTMLElement | null>,
  steps: readonly [Step, ...Step[]],
  signature: string,
  pinAt: Step,
): Step {
  const { height, content } = useBoxMetrics(box);
  const key = `${signature}|${height}`;
  const [walk, setWalk] = useState({ key, index: 0 });
  if (walk.key !== key) {
    setWalk({ key, index: 0 });
  }
  const index = walk.key === key ? walk.index : 0;
  const wasPinned = useRef(false);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) {
      return;
    }
    const pinned = element.querySelector(OPEN_PIN) !== null;
    const released = wasPinned.current && !pinned;
    wasPinned.current = pinned;
    if (released) {
      setWalk({ key, index: 0 });
      return;
    }
    const next = nextStep({
      index,
      last: steps.length - 1,
      overflowing: overflows(element),
      pinAt: steps.indexOf(pinAt),
      pinned,
    });
    if (next !== index) {
      setWalk({ key, index: next });
    }
  }, [box, steps, pinAt, key, index, content]);
  return steps[index] ?? steps[0];
}
