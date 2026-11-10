import { useEffect, useState } from "react";

const TICK_MS = 1000;

/**
 * Whole seconds still to wait after a refusal that named a wait. A new `token` (a new refusal)
 * starts the count again, also when it asks for the same seconds.
 */
export function useCooldown(seconds: number | undefined, token: unknown): number {
  const [left, setLeft] = useState(seconds ?? 0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the token only restarts the count
  useEffect(() => {
    if (seconds === undefined || seconds <= 0) {
      setLeft(0);
      return;
    }
    const end = Date.now() + seconds * TICK_MS;
    setLeft(seconds);
    const timer = setInterval(() => {
      const rest = Math.max(0, Math.ceil((end - Date.now()) / TICK_MS));
      setLeft(rest);
      if (rest === 0) clearInterval(timer);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [seconds, token]);
  return left;
}
