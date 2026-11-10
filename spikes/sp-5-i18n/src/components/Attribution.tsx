import { useCopy } from "@gerlines/i18n/react";

export function Attribution() {
  const copy = useCopy();
  const { attribution } = copy;
  return (
    <aside className="attribution" aria-label={attribution.label}>
      {attribution.mapData}: {attribution.openStreetMap}, {attribution.openFreeMap},{" "}
      {attribution.openMapTiles}. {attribution.trains}: {attribution.delfi}.
    </aside>
  );
}
