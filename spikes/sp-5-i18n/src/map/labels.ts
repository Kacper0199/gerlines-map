import { currentLocale, subscribeLocale } from "@gerlines/i18n";
import type { ExpressionSpecification, Map as MapLibreMap } from "maplibre-gl";

const NAME_FIELD = "name";
const LATIN_FIELD = "name:latin";

export function labelExpression(language: string): ExpressionSpecification {
  return [
    "coalesce",
    ["get", `${NAME_FIELD}:${language}`],
    ["get", LATIN_FIELD],
    ["get", NAME_FIELD],
  ];
}

export function isNameLabel(textField: unknown): boolean {
  return JSON.stringify(textField ?? null).includes(`["get","${NAME_FIELD}"]`);
}

export function nameLabelLayerIds(map: MapLibreMap): string[] {
  const layers = map.getStyle().layers ?? [];
  return layers
    .filter((layer) => layer.type === "symbol" && isNameLabel(layer.layout?.["text-field"]))
    .map((layer) => layer.id);
}

export function bindLabelLanguage(map: MapLibreMap): () => void {
  let layerIds: string[] = [];

  const apply = () => {
    const expression = labelExpression(currentLocale());
    for (const id of layerIds) {
      map.setLayoutProperty(id, "text-field", expression);
    }
  };
  const onStyleLoad = () => {
    layerIds = nameLabelLayerIds(map);
    apply();
  };

  map.on("style.load", onStyleLoad);
  if (map.isStyleLoaded()) {
    onStyleLoad();
  }
  const unsubscribe = subscribeLocale(apply);
  return () => {
    map.off("style.load", onStyleLoad);
    unsubscribe();
  };
}
