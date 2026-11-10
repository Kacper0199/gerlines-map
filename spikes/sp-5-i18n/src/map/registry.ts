import type { Map as MapLibreMap } from "maplibre-gl";

export const registryStats = { created: 0, removed: 0 };

let current: MapLibreMap | null = null;

export function currentMap(): MapLibreMap | null {
  return current;
}

export function registerMap(map: MapLibreMap): () => void {
  current = map;
  registryStats.created += 1;
  return () => {
    registryStats.removed += 1;
    if (current === map) {
      current = null;
    }
  };
}
