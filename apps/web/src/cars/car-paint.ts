import { type Layer, LayerExtension } from "@deck.gl/core";
import type { PaletteLayout } from "./catalog.ts";

/** Brightness of a lit lamp lens before lighting, so it reads as a light at map distance. */
const LIT = 1.7;
const UNLIT_WHITE = 0.42;
/**
 * A lamp with `tail_mode: combined` (one cluster for white and red) samples the light cell at a
 * quarter, a plain lens at its centre: a lens left of this fraction of the cell lights red at the
 * trailing end.
 */
export const COMBINED_TAIL_BELOW = 0.4;

/**
 * How far in normalised clip depth (4e-6, about 2e-6 of window depth, 33 steps of a 24 bit buffer)
 * the selected train's cars move towards the camera: far above the rounding of the depth buffer, so a
 * second train on the same track, whose roof lies in the same plane, never fights the selection's roof
 * band, and still only centimetres of ground at car zoom. The picking pass moves it the other way, so a
 * click on two trains that overlap reaches the one that is not selected, and each can be picked
 * from the other.
 */
export const SELECTED_DEPTH_BIAS = 0.000004;

function float(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

function hidesLogo(palette: PaletteLayout): boolean {
  return palette.logoColumns.length > 0 && palette.logoRows.some((shown) => !shown);
}

/** The palette rows that show the DB logo, as a constant the vertex shader indexes with the livery row. */
function logoDeclaration(palette: PaletteLayout): string {
  if (!hidesLogo(palette)) return "";
  const flags = palette.logoRows.map((shown) => (shown ? "1.0" : "0.0")).join(", ");
  return `const float LOGO_SHOWN[${palette.rows}] = float[${palette.rows}](${flags});
`;
}

/**
 * Moves every vertex of a logo triangle (its texture cell is a logo column) out of the clip volume
 * when the instance's livery row has no logo: per vertex, so the order of the forge's triangles does
 * not matter, and no fragment shader has to discard (which would turn off early depth testing for
 * every car fragment).
 */
function logoCull(palette: PaletteLayout): string {
  if (!hidesLogo(palette)) return "";
  const test = palette.logoColumns.map((c) => `logoCell == ${float(c)}`).join(" || ");
  return `float logoCell = floor(texCoords.x * ${float(palette.columns)});
if ((${test}) && LOGO_SHOWN[int(instanceLiveryRows + 0.5)] < 0.5) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
`;
}

/**
 * Paints forge cars from the shared palette atlas per instance: the livery row picks the atlas row,
 * the mode slot takes the instance's colour mode colour (D-039), lamp lenses light by
 * direction (D-053: white at the leading end, red at the trailing end), and the instance alpha
 * carries the train's crossfade. Every mode band is shaded like the body paint, except the selected
 * train's, which is written after deck's lighting so it shows its exact colour (the selected amber
 * must read as the route's amber). Picking colours pass untouched.
 * The triangles of the DB logo are culled in the vertex shader for a livery row that shows none: a
 * livery that is not a DB operator's draws no DB logo.
 */
export function carPaintShaders(palette: PaletteLayout): Record<string, string> {
  return {
    "vs:#decl": `
in float instanceLiveryRows;
in vec2 instanceLamps;
in float instanceSelected;
in float instanceFleetIndex;
flat out float vCarSelected;
flat out float vCarLamp;
flat out vec4 vCarMode;
${logoDeclaration(palette)}`,
    "vs:#main-end": `
picking_setPickingColor(picking_getPickingColorFromIndex(instanceFleetIndex));
vTexCoord.y = (instanceLiveryRows + 0.5) / ${float(palette.rows)};
vCarLamp = positions.x > 0.0 ? instanceLamps.x : instanceLamps.y;
vCarMode = instanceColors;
vCarSelected = instanceSelected;
if (instanceSelected > 0.5) gl_Position.z += (picking.isActive > 0.5 ? 1.0 : -1.0) * ${float(SELECTED_DEPTH_BIAS)} * gl_Position.w;
${logoCull(palette)}`,
    "fs:#decl": `
flat in float vCarLamp;
flat in vec4 vCarMode;
flat in float vCarSelected;
float carBand = 0.0;
`,
    "fs:DECKGL_FILTER_COLOR": `
float column = floor(geometry.uv.x * ${float(palette.columns)});
if (picking.isActive < 0.5) {
  if (column == ${float(palette.modeColumn)}) {
    color.rgb = vCarMode.rgb;
    carBand = vCarSelected;
  } else if (column == ${float(palette.lightColumn)}) {
    bool combined = fract(geometry.uv.x * ${float(palette.columns)}) < ${COMBINED_TAIL_BELOW};
    if (vCarLamp == 1.0) color.rgb = vec3(${float(LIT)});
    else if (vCarLamp == 2.0) color.rgb = combined ? vec3(${float(LIT)}, 0.1, 0.06) : color.rgb * ${float(UNLIT_WHITE)};
  } else if (column == ${float(palette.tailColumn)} && vCarLamp == 2.0) {
    color.rgb = vec3(${float(LIT)}, 0.1, 0.06);
  }
  color.a *= vCarMode.a;
}
`,
    "fs:#main-end": `
if (picking.isActive < 0.5 && carBand > 0.5) fragColor.rgb = vCarMode.rgb;
`,
  };
}

interface CarPaintProps {
  getLiveryRow?: unknown;
  getLamps?: unknown;
  getSelected?: unknown;
  getFleetIndex?: unknown;
}

export class CarPaintExtension extends LayerExtension<PaletteLayout> {
  static override extensionName = "CarPaintExtension";
  static override defaultProps = {
    getLiveryRow: { type: "accessor", value: 0 },
    getLamps: { type: "accessor", value: [0, 0] },
    getSelected: { type: "accessor", value: 0 },
    getFleetIndex: { type: "accessor", value: 0 },
  };

  override getShaders(this: Layer<CarPaintProps>, extension: this): unknown {
    return { inject: carPaintShaders(extension.opts) };
  }

  override initializeState(this: Layer<CarPaintProps>): void {
    this.getAttributeManager()?.addInstanced({
      instanceLiveryRows: { size: 1, accessor: "getLiveryRow", defaultValue: 0 },
      instanceLamps: { size: 2, accessor: "getLamps", defaultValue: [0, 0] },
      instanceSelected: { size: 1, accessor: "getSelected", defaultValue: 0 },
      instanceFleetIndex: { size: 1, accessor: "getFleetIndex", defaultValue: 0 },
    });
  }
}

/** Dark soft casing under the cars (satellite imagery): flat colour, translucent. */
export class CarOutlineExtension extends LayerExtension {
  static override extensionName = "CarOutlineExtension";

  override getShaders(): unknown {
    return {
      inject: {
        "fs:DECKGL_FILTER_COLOR": `
if (picking.isActive < 0.5) {
  color = vec4(0.02, 0.03, 0.04, color.a * 0.6);
}
`,
      },
    };
  }
}
