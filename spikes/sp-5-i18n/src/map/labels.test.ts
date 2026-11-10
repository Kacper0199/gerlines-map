import { changeLocale, currentLocale } from "@gerlines/i18n";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import type { Map as MapLibreMap } from "maplibre-gl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindLabelLanguage, isNameLabel, labelExpression } from "./labels.ts";

const OPENFREEMAP_PLACE = [
  "case",
  ["has", "name:nonlatin"],
  ["concat", ["get", "name:latin"], "\n", ["get", "name:nonlatin"]],
  ["coalesce", ["get", "name_en"], ["get", "name"]],
];
const SHIELD = ["to-string", ["get", "ref"]];

interface FakeLayer {
  readonly id: string;
  readonly type: string;
  readonly layout?: Record<string, unknown>;
}

function fakeMap(layers: FakeLayer[], styleLoaded = false) {
  const handlers = new Map<string, () => void>();
  const setLayoutProperty = vi.fn();
  const map = {
    getStyle: () => ({ layers }),
    isStyleLoaded: () => styleLoaded,
    setLayoutProperty,
    on: (event: string, handler: () => void) => {
      handlers.set(event, handler);
    },
    off: (event: string) => {
      handlers.delete(event);
    },
  } as unknown as MapLibreMap;
  return { map, setLayoutProperty, fire: (event: string) => handlers.get(event)?.() };
}

describe("labelExpression", () => {
  it("prefers the language, then the Latin name, then the local name", () => {
    for (const language of ["en", "de", "pl"]) {
      expect(labelExpression(language)).toEqual([
        "coalesce",
        ["get", `name:${language}`],
        ["get", "name:latin"],
        ["get", "name"],
      ]);
    }
  });

  it.each(["en", "de", "pl"])("is a valid text-field expression for %s", (language) => {
    const problems = validateStyleMin({
      version: 8,
      sources: { s: { type: "geojson", data: { type: "FeatureCollection", features: [] } } },
      layers: [
        {
          id: "label",
          type: "symbol",
          source: "s",
          layout: { "text-field": labelExpression(language) },
        },
      ],
    });
    expect(problems).toEqual([]);
  });
});

describe("isNameLabel", () => {
  it("recognises the OpenFreeMap name expression and our own", () => {
    expect(isNameLabel(OPENFREEMAP_PLACE)).toBe(true);
    expect(isNameLabel(labelExpression("pl"))).toBe(true);
  });

  it("leaves road shields and layers without text alone", () => {
    expect(isNameLabel(SHIELD)).toBe(false);
    expect(isNameLabel(undefined)).toBe(false);
  });
});

describe("bindLabelLanguage", () => {
  afterEach(async () => {
    await changeLocale("en");
  });

  it("writes the expression into every name layer when the style loads and when the locale changes", async () => {
    const { map, setLayoutProperty, fire } = fakeMap([
      { id: "place", type: "symbol", layout: { "text-field": OPENFREEMAP_PLACE } },
      { id: "shield", type: "symbol", layout: { "text-field": SHIELD } },
      { id: "water", type: "fill" },
      { id: "road", type: "symbol", layout: { "text-field": OPENFREEMAP_PLACE } },
    ]);
    const unbind = bindLabelLanguage(map);

    fire("style.load");
    expect(setLayoutProperty.mock.calls.map((call) => call[0])).toEqual(["place", "road"]);

    setLayoutProperty.mockClear();
    await changeLocale("pl");
    expect(currentLocale()).toBe("pl");
    expect(setLayoutProperty).toHaveBeenCalledTimes(2);
    expect(setLayoutProperty).toHaveBeenCalledWith("place", "text-field", labelExpression("pl"));
    expect(setLayoutProperty).toHaveBeenCalledWith("road", "text-field", labelExpression("pl"));

    unbind();
    setLayoutProperty.mockClear();
    await changeLocale("de");
    expect(setLayoutProperty).not.toHaveBeenCalled();
  });

  it("applies the language at once when the style is already loaded", () => {
    const { map, setLayoutProperty } = fakeMap(
      [{ id: "place", type: "symbol", layout: { "text-field": OPENFREEMAP_PLACE } }],
      true,
    );
    const unbind = bindLabelLanguage(map);
    expect(setLayoutProperty).toHaveBeenCalledWith(
      "place",
      "text-field",
      labelExpression(currentLocale()),
    );
    unbind();
  });

  it("waits for the style when it is still loading", () => {
    const { map, setLayoutProperty } = fakeMap([
      { id: "place", type: "symbol", layout: { "text-field": OPENFREEMAP_PLACE } },
    ]);
    const unbind = bindLabelLanguage(map);
    expect(setLayoutProperty).not.toHaveBeenCalled();
    unbind();
  });
});
