import type { MotionFleet } from "@gerlines/geo";
import { drawnHeight, type Elevation, FLAT } from "../map/terrain/elevation.ts";
import type { ColourMode } from "../modes/colour-mode.ts";
import type { DelayClass } from "../modes/delay.ts";
import { hasNeutralMark, NEUTRAL_GROUP_SIZE } from "../modes/operator-colours.ts";
import type { OperatorGroup } from "../modes/operator-groups.ts";
import type { CategoryKey } from "../motion/categories.ts";
import { type FrameGroup, type Palette, POSITION_STRIDE, type Rgb } from "../motion/frame.ts";
import { bearingOf, latOf, lonOf } from "./geometry.ts";
import { liveTrainId } from "./train-ids.ts";

export interface DrawnTrain {
  readonly key: number;
  readonly slot: number;
  readonly category: CategoryKey;
  readonly delayClass: DelayClass;
  readonly operatorGroup: OperatorGroup;
  readonly label: string;
}

const OPAQUE = 255;
const FOREIGN_OPACITY = 0.7;
const HIGH_SPEED_SIZE = 1.25;
const FOREIGN_SIZE = 0.8;

function sizeOf(entry: DrawnTrain, mode: ColourMode): number {
  if (entry.category === "foreign") return FOREIGN_SIZE;
  const size = entry.category === "hsr" ? HIGH_SPEED_SIZE : 1;
  return mode === "operator" && hasNeutralMark(entry.operatorGroup)
    ? size * NEUTRAL_GROUP_SIZE
    : size;
}

/** The colour of a train in the chosen mode: its category, or its delay class or operator group when the palette has them. */
export function fillColour(entry: DrawnTrain, palette: Palette, mode: ColourMode): Rgb {
  if (mode === "delay" && palette.delay) return palette.delay[entry.delayClass];
  if (mode === "operator" && palette.operator) return palette.operator[entry.operatorGroup];
  return palette.fill[entry.category];
}

function writeColor(target: Uint8Array, index: number, rgb: Rgb, alpha: number): void {
  target[4 * index] = rgb[0];
  target[4 * index + 1] = rgb[1];
  target[4 * index + 2] = rgb[2];
  target[4 * index + 3] = alpha;
}

/**
 * One draw group as typed arrays for the layers: position as longitude, latitude (Float64, so a
 * train keeps its centimetres) and height on the relief (`elevation`), angle, size and the two colours (a hollow group swaps them). Ids are
 * written only when the caller asks (they change rarely).
 */
export function writeGroup(
  entries: readonly DrawnTrain[],
  hollow: boolean,
  includeIds: boolean,
  fleet: MotionFleet,
  palette: Palette,
  carTier?: ReadonlyMap<number, number>,
  mode: ColourMode = "category",
  includeLabels = false,
  elevation: Elevation = FLAT,
  opacity = 1,
): FrameGroup {
  const count = entries.length;
  const positions = new Float64Array(POSITION_STRIDE * count);
  const iconAngles = new Float32Array(count);
  const sizes = new Float32Array(count);
  const fillColors = new Uint8Array(4 * count);
  const lineColors = new Uint8Array(4 * count);
  for (let index = 0; index < count; index++) {
    const entry = entries[index] as DrawnTrain;
    const slot = entry.slot;
    positions[POSITION_STRIDE * index] = lonOf(fleet.x[slot] as number);
    positions[POSITION_STRIDE * index + 1] = latOf(fleet.y[slot] as number);
    positions[POSITION_STRIDE * index + 2] = drawnHeight(fleet.z[slot] as number, elevation);
    iconAngles[index] = -bearingOf(fleet.tangentX[slot] as number, fleet.tangentY[slot] as number);
    sizes[index] = sizeOf(entry, mode);
    const foreign = entry.category === "foreign";
    const alpha = Math.round(
      OPAQUE *
        (fleet.alive[slot] ? (fleet.alpha[slot] as number) : 0) *
        (foreign ? FOREIGN_OPACITY : 1) *
        (1 - (carTier?.get(entry.key) ?? 0)) *
        opacity,
    );
    const trainColor = fillColour(entry, palette, mode);
    writeColor(fillColors, index, hollow ? palette.land : trainColor, alpha);
    writeColor(lineColors, index, hollow ? trainColor : palette.land, alpha);
  }
  return {
    hollow,
    count,
    positions,
    iconAngles,
    sizes,
    fillColors,
    lineColors,
    ids: includeIds ? entries.map((entry) => liveTrainId(entry.key)) : undefined,
    labels: includeIds && includeLabels ? entries.map((entry) => entry.label) : undefined,
  };
}
