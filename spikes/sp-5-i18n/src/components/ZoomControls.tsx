import { useCopy } from "@gerlines/i18n/react";
import { currentMap } from "../map/registry.ts";

export function ZoomControls() {
  const copy = useCopy();
  return (
    <fieldset className="card zoom" aria-label={copy.map.zoomGroup}>
      <button
        type="button"
        aria-label={copy.map.zoomIn}
        onClick={() => {
          currentMap()?.zoomIn();
        }}
      >
        +
      </button>
      <button
        type="button"
        aria-label={copy.map.zoomOut}
        onClick={() => {
          currentMap()?.zoomOut();
        }}
      >
        &minus;
      </button>
    </fieldset>
  );
}
