import type { Layer } from "@deck.gl/core";
import { TextLayer } from "@deck.gl/layers";
import { type FrameGroup, POSITION_STRIDE } from "../motion/frame.ts";
import { colorValue, hexToRgb, type ThemeName } from "../theme/tokens.ts";
import { TRAIN_ANCHOR_LAYER_ID } from "./style/build-style.ts";

const FONT_SIZE = 12;
const OUTLINE_PX = 3;
const OFFSET_ABOVE_PX = -15;
const GROUP_STRIDE = 1_000_000;
const GLYPH_WIDTH_PX = 7.4;
const BOX_PAD_PX = 3;
const BOX_HEIGHT_PX = 15;
const CELL_PX = 48;

/**
 * One labelled train: where its position sits in the frame groups and what to write. Built once
 * per id list, so the text layer keeps the same data array while the trains move.
 */
export interface LabelItem {
  readonly group: number;
  readonly index: number;
  readonly text: string;
  /** Later in the draw order wins a collision, so the worse delay keeps its label. */
  readonly priority: number;
}

export interface LabelSource {
  readonly groups: readonly FrameGroup[];
  readonly tick: number;
}

export function labelItems(labels: readonly (readonly string[] | undefined)[]): LabelItem[] {
  const items: LabelItem[] = [];
  labels.forEach((texts, group) => {
    texts?.forEach((text, index) => {
      if (text) items.push({ group, index, text, priority: group * GROUP_STRIDE + index });
    });
  });
  return items;
}

function visible(group: FrameGroup | undefined, index: number): group is FrameGroup {
  return (
    group !== undefined && index < group.count && (group.fillColors[4 * index + 3] as number) > 0
  );
}

export type Project = (lon: number, lat: number) => { readonly x: number; readonly y: number };

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function boxOf(item: LabelItem, x: number, y: number): Box {
  const half = (item.text.length * GLYPH_WIDTH_PX) / 2 + BOX_PAD_PX;
  return {
    left: x - half,
    right: x + half,
    top: y + OFFSET_ABOVE_PX - BOX_HEIGHT_PX,
    bottom: y + OFFSET_ABOVE_PX,
  };
}

function cellKeys(box: Box, columns: number): number[] {
  const keys: number[] = [];
  for (let cx = Math.floor(box.left / CELL_PX); cx <= Math.floor(box.right / CELL_PX); cx++) {
    for (let cy = Math.floor(box.top / CELL_PX); cy <= Math.floor(box.bottom / CELL_PX); cy++) {
      keys.push((cy + 1) * columns + cx + 1);
    }
  }
  return keys;
}

class BoxGrid {
  private readonly cells = new Map<number, Box[]>();
  private readonly columns: number;
  private readonly width: number;
  private readonly height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.columns = Math.ceil(width / CELL_PX) + 2;
  }

  inView(box: Box): boolean {
    return box.right >= 0 && box.left <= this.width && box.bottom >= 0 && box.top <= this.height;
  }

  /** Keeps the box and returns true unless it touches one kept before. */
  tryKeep(box: Box): boolean {
    const keys = cellKeys(box, this.columns);
    if (keys.some((key) => this.cells.get(key)?.some((other) => overlaps(box, other)))) {
      return false;
    }
    for (const key of keys) {
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(box);
      else this.cells.set(key, [box]);
    }
    return true;
  }
}

/**
 * Which labels get drawn: the visible ones in priority order, each kept only when its box does not
 * touch the box of a label already kept, so a crowd shows its worst delays and the rest stays quiet.
 */
export function placeLabels(
  items: readonly LabelItem[],
  source: LabelSource,
  project: Project,
  width: number,
  height: number,
): Uint8Array {
  const shown = new Uint8Array(items.length);
  const grid = new BoxGrid(width, height);
  for (let n = items.length - 1; n >= 0; n--) {
    const item = items[n] as LabelItem;
    const group = source.groups[item.group];
    if (!visible(group, item.index)) continue;
    const at = project(
      group.positions[POSITION_STRIDE * item.index] as number,
      group.positions[POSITION_STRIDE * item.index + 1] as number,
    );
    const box = boxOf(item, at.x, at.y);
    if (grid.inView(box) && grid.tryKeep(box)) shown[n] = 1;
  }
  return shown;
}

/**
 * The label of the selected train leaves the shown set for a layer of its own that draws in the top
 * group after the selection marker, so the ring never covers it. `ids` holds the train ids of each
 * frame group in frame order; null when the selected train has no label shown.
 */
export function splitSelectedLabel(
  items: readonly LabelItem[],
  shown: Uint8Array,
  ids: readonly (readonly string[] | undefined)[],
  selectedId: string | null,
): { readonly under: Uint8Array; readonly top: { readonly item: LabelItem } | null } {
  if (selectedId === null) return { under: shown, top: null };
  const group = ids.findIndex((list) => list?.includes(selectedId));
  if (group < 0) return { under: shown, top: null };
  const index = (ids[group] as readonly string[]).indexOf(selectedId);
  const n = items.findIndex((item) => item.group === group && item.index === index);
  if (n < 0 || !shown[n]) return { under: shown, top: null };
  const under = shown.slice();
  under[n] = 0;
  return { under, top: { item: items[n] as LabelItem } };
}

export function buildLabelLayer(
  items: readonly LabelItem[],
  source: LabelSource,
  shown: Uint8Array,
  theme: ThemeName,
  { top = false }: { readonly top?: boolean } = {},
): Layer {
  const [r, g, b] = hexToRgb(colorValue("ink", theme));
  const [lr, lg, lb] = hexToRgb(colorValue("map-land", theme));
  const position = (item: LabelItem, { target }: { target: number[] }): number[] => {
    const group = source.groups[item.group];
    if (group && item.index < group.count) {
      target[0] = group.positions[POSITION_STRIDE * item.index] as number;
      target[1] = group.positions[POSITION_STRIDE * item.index + 1] as number;
      target[2] = group.positions[POSITION_STRIDE * item.index + 2] as number;
    } else {
      target[0] = 0;
      target[1] = 0;
      target[2] = 0;
    }
    return target;
  };
  const colour = (
    _item: LabelItem,
    { target, index }: { target: number[]; index: number },
  ): number[] => {
    target[0] = r;
    target[1] = g;
    target[2] = b;
    target[3] = shown[index] ? 255 : 0;
    return target;
  };
  return new TextLayer<LabelItem>({
    id: top ? "train-label-selected" : "train-labels",
    data: items as LabelItem[],
    getPosition: position,
    getText: (item: LabelItem) => item.text,
    getSize: FONT_SIZE,
    sizeUnits: "pixels",
    getColor: colour,
    getPixelOffset: [0, OFFSET_ABOVE_PX],
    getTextAnchor: "middle",
    getAlignmentBaseline: "bottom",
    fontFamily: "Overpass Mono, ui-monospace, monospace",
    fontWeight: 600,
    characterSet: "auto",
    fontSettings: { sdf: true },
    outlineWidth: OUTLINE_PX,
    outlineColor: [lr, lg, lb, 255],
    pickable: false,
    ...(top ? {} : { beforeId: TRAIN_ANCHOR_LAYER_ID }),
    updateTriggers: {
      getPosition: source.tick,
      getColor: [source.tick, theme],
      getText: items,
    },
  } as never);
}
