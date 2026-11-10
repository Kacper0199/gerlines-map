import { useCopy } from "@gerlines/i18n/react";
import { Map as MapLibreMap, setWorkerUrl } from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { useEffect, useRef } from "react";
import { bindLabelLanguage } from "../map/labels.ts";
import { registerMap } from "../map/registry.ts";

setWorkerUrl(maplibreWorkerUrl);

const STYLE_URL = "https://tiles.openfreemap.org/styles/dark";
const GERMANY_CENTER: [number, number] = [10.45, 51.1];
const NATIONAL_ZOOM = 5.4;

export function MapView() {
  const copy = useCopy();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    const map = new MapLibreMap({
      container,
      style: STYLE_URL,
      center: GERMANY_CENTER,
      zoom: NATIONAL_ZOOM,
      attributionControl: false,
      canvasContextAttributes: { antialias: true },
    });
    const unbindLabels = bindLabelLanguage(map);
    const unregister = registerMap(map);
    return () => {
      unregister();
      unbindLabels();
      map.remove();
    };
  }, []);

  return <section ref={containerRef} className="map" aria-label={copy.map.label} />;
}
