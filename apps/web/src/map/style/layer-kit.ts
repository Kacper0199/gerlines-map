import type { LayerSpecification } from "maplibre-gl";

export type Json = ReadonlyArray<unknown> | string | number | boolean;

export const FONT_REGULAR = ["Noto Sans Regular"];
export const LABEL_KIND = "gerlines:label";

export type LabelKind = "name" | "geo";

export const isPolygon: Json = [
  "match",
  ["geometry-type"],
  ["MultiPolygon", "Polygon"],
  true,
  false,
];
export const isLine: Json = [
  "match",
  ["geometry-type"],
  ["LineString", "MultiLineString"],
  true,
  false,
];
export const isPoint: Json = ["match", ["geometry-type"], ["MultiPoint", "Point"], true, false];

/**
 * Round joins on the long, finely digitised lines of the tiles (borders, coasts, paths, roads, rails) add triangles at
 * every vertex, and below zoom 10 these lines are about two pixels wide at most with several vertices per pixel, so a
 * round join is not told apart from a mitred one. Software GL pays for the triangles on every frame (SwiftShader,
 * national view: 127 ms against 78 ms per frame); from the zoom where lines get wide enough to show a corner the join
 * is round.
 */
export const THIN_LINE_JOIN: Json = ["step", ["zoom"], "miter", 10, "round"];

export function layer(spec: Record<string, unknown>): LayerSpecification {
  return spec as unknown as LayerSpecification;
}

export function classIs(...classes: string[]): Json {
  return ["match", ["get", "class"], classes, true, false];
}

export function zoomRamp(base: number, ...stops: number[]): Json {
  return ["interpolate", ["exponential", base], ["zoom"], ...stops];
}

export function linearRamp(...stops: number[]): Json {
  return ["interpolate", ["linear"], ["zoom"], ...stops];
}

const NAME_PART_SEPARATORS = [" - ", " / ", "/"] as const;

export const NAME_CLASHES: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  pl: [
    ["Görlitz", "Zgorzelec"],
    ["Guben", "Gubin"],
    ["Aurith", "Urad"],
    ["Günthersdorf", "Lindow"],
    ["Lauta Dorf", "Lauta"],
    ["Raszyn", "Stara Woda"],
    ["Drzewce", "Drzewce-Kolonia"],
  ],
};

function isNamePart(part: Json, whole: Json): Json {
  return [
    "any",
    ...NAME_PART_SEPARATORS.map((separator) => [
      "in",
      ["concat", separator, part, separator],
      ["concat", separator, whole, separator],
    ]),
  ];
}

function germanText(): Json {
  return [
    "let",
    "local",
    ["coalesce", ["get", "name:latin"], ["get", "name"], ""],
    "german",
    ["coalesce", ["get", "name:de"], ""],
    [
      "case",
      ["all", ["!=", ["var", "german"], ""], isNamePart(["var", "german"], ["var", "local"])],
      ["var", "german"],
      ["var", "local"],
    ],
  ];
}

export function nameText(language: string): Json {
  if (language === "de") {
    return germanText();
  }
  const translated: Json = [
    "coalesce",
    ["get", `name:${language}`],
    ["get", "name:latin"],
    ["get", "name"],
  ];
  const clashes = NAME_CLASHES[language] ?? [];
  if (clashes.length === 0) {
    return translated;
  }
  return [
    "let",
    "label",
    translated,
    [
      "match",
      ["concat", ["get", "name"], "|", ["var", "label"]],
      clashes.map(([name, clash]) => `${name}|${clash}`),
      ["coalesce", ["get", "name:latin"], ["get", "name"]],
      ["var", "label"],
    ],
  ];
}

export function routeRefText(): Json {
  return [
    "let",
    "ref",
    ["to-string", ["get", "ref"]],
    [
      "let",
      "cut",
      ["index-of", ";", ["var", "ref"]],
      [
        "case",
        [">=", ["var", "cut"], 0],
        ["slice", ["var", "ref"], 0, ["var", "cut"]],
        ["var", "ref"],
      ],
    ],
  ];
}

export function geoText(language: string): Json {
  return ["get", `name_${language}`];
}

export function labelText(kind: LabelKind, language: string): Json {
  return kind === "geo" ? geoText(language) : nameText(language);
}

export function labelKindOf(spec: { metadata?: unknown }): LabelKind | undefined {
  const metadata = spec.metadata as Record<string, unknown> | undefined;
  const kind = metadata?.[LABEL_KIND];
  return kind === "name" || kind === "geo" ? kind : undefined;
}

export function fillLayer(
  id: string,
  sourceLayer: string,
  color: Json,
  extra: Record<string, unknown> = {},
  paint: Record<string, unknown> = {},
): LayerSpecification {
  return layer({
    id,
    type: "fill",
    source: "openmaptiles",
    "source-layer": sourceLayer,
    paint: { "fill-color": color, ...paint },
    ...extra,
  });
}

export function lineLayer(
  id: string,
  color: string,
  width: Json,
  extra: Record<string, unknown> = {},
  layout: Record<string, unknown> = { "line-cap": "round", "line-join": THIN_LINE_JOIN },
  paint: Record<string, unknown> = {},
): LayerSpecification {
  return layer({
    id,
    type: "line",
    source: "openmaptiles",
    "source-layer": "transportation",
    layout,
    paint: { "line-color": color, "line-width": width, ...paint },
    ...extra,
  });
}

export function symbolLayer(
  id: string,
  source: { readonly source: string; readonly sourceLayer?: string },
  kind: LabelKind | undefined,
  filter: Json | undefined,
  layout: Record<string, unknown>,
  paint: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): LayerSpecification {
  return layer({
    id,
    type: "symbol",
    source: source.source,
    ...(source.sourceLayer ? { "source-layer": source.sourceLayer } : {}),
    ...(filter === undefined ? {} : { filter }),
    ...(kind ? { metadata: { [LABEL_KIND]: kind } } : {}),
    layout: { "text-font": FONT_REGULAR, "text-letter-spacing": 0, ...layout },
    paint,
    ...extra,
  });
}
