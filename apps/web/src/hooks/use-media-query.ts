import { useSyncExternalStore } from "react";

export const PHONE_QUERY = "(max-width: 640px)";
export const NARROW_DESKTOP_QUERY = "(width < 1280px)";
export const COMPACT_QUERY = "(max-width: 1100px), (max-height: 860px)";

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", notify);
      return () => list.removeEventListener("change", notify);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
