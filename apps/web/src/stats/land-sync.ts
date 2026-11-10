import { useEffect, useRef } from "react";
import { useAppStore } from "../state/store.ts";
import { useStatsStore } from "./store.ts";

/**
 * Keeps the Land focus of the map and the Land of the statistics area one thing: picking a Land
 * in the panel focuses it on the map, clearing the focus (the chip) or focusing another Land
 * (search) moves the panel along, and leaving the Land tab shows all of Germany again.
 */
export function useLandSync(): void {
  const area = useStatsStore((state) => state.area);
  const kind = useStatsStore((state) => state.kind);
  const setArea = useStatsStore((state) => state.setArea);
  const setKind = useStatsStore((state) => state.setKind);
  const focusLand = useAppStore((state) => state.focusLand);
  const setFocusLand = useAppStore((state) => state.setFocusLand);
  const seenFocus = useRef<typeof focusLand>(null);
  const seenArea = useRef<string | null>(null);
  const wasLand = useRef(false);
  const areaLand = area?.kind === "land" ? area.code : null;

  useEffect(() => {
    if (seenFocus.current === focusLand) return;
    seenFocus.current = focusLand;
    if (focusLand !== null) {
      if (areaLand !== focusLand) setArea({ kind: "land", code: focusLand });
    } else if (areaLand !== null) {
      setKind("network");
    }
  }, [focusLand, areaLand, setArea, setKind]);

  useEffect(() => {
    const signature = `${kind}:${areaLand}`;
    if (seenArea.current === signature) return;
    seenArea.current = signature;
    if (areaLand !== null) {
      wasLand.current = true;
      if (focusLand !== areaLand) setFocusLand(areaLand);
      return;
    }
    if (wasLand.current && kind !== "land") {
      wasLand.current = false;
      if (focusLand !== null) setFocusLand(null);
    }
  }, [areaLand, kind, focusLand, setFocusLand]);
}
