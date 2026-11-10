import { useCallback, useEffect, useState } from "react";

/** How long a tooltip outlives its trigger, so the pointer can cross the gap to it (WCAG 1.4.13 hoverable). */
export const HOLD_MS = 400;

export interface HeldHover<T> {
  /** What to show: the trigger's value, or the last one while the pointer travels to or rests on the tooltip. */
  readonly shown: T | null;
  /** The pointer is over the tooltip itself: it stays until the pointer leaves or the user dismisses it. */
  enter(): void;
  leave(): void;
  dismiss(): void;
}

export function useHeldHover<T>(value: T | null, holdMs: number = HOLD_MS): HeldHover<T> {
  const [held, setHeld] = useState<T | null>(value);
  const [over, setOver] = useState(false);
  useEffect(() => {
    if (value !== null) {
      setHeld(value);
      return;
    }
    if (over) return;
    const timer = setTimeout(() => setHeld(null), holdMs);
    return () => clearTimeout(timer);
  }, [value, over, holdMs]);
  const enter = useCallback(() => setOver(true), []);
  const leave = useCallback(() => setOver(false), []);
  const dismiss = useCallback(() => {
    setOver(false);
    setHeld(null);
  }, []);
  return { shown: value ?? held, enter, leave, dismiss };
}
