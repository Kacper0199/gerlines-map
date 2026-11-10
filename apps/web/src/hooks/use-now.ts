import { useEffect, useState } from "react";

export function useNow(intervalMs = 15_000, frozenMs?: number): number {
  const [now, setNow] = useState(() => frozenMs ?? Date.now());
  useEffect(() => {
    if (frozenMs !== undefined) {
      setNow(frozenMs);
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, frozenMs]);
  return now;
}
