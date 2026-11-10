import { useEffect, useState } from "react";

/** True from a refusal until the instant it asked to wait for (epoch milliseconds) has passed. */
export function useRetryWait(retryAt: number | undefined): boolean {
  const [passed, setPassed] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (retryAt === undefined) return;
    const timer = setTimeout(() => setPassed(retryAt), Math.max(0, retryAt - Date.now()));
    return () => clearTimeout(timer);
  }, [retryAt]);
  return retryAt !== undefined && passed !== retryAt && retryAt > Date.now();
}
