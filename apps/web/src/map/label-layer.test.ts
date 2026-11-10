import { describe, expect, it } from "vitest";
import type { FrameGroup } from "../motion/frame.ts";
import { buildLabelLayer, labelItems, placeLabels, splitSelectedLabel } from "./label-layer.ts";

function group(positions: number[], alphas: number[] = positions.map(() => 255)): FrameGroup {
  const count = positions.length / 2;
  const spaced = Array.from({ length: count }, (_, i) => [
    positions[2 * i] as number,
    positions[2 * i + 1] as number,
    0,
  ]).flat();
  const fillColors = new Uint8Array(4 * count);
  alphas.forEach((alpha, index) => {
    fillColors[4 * index + 3] = alpha;
  });
  return {
    hollow: false,
    count,
    positions: new Float64Array(spaced),
    iconAngles: new Float32Array(count),
    sizes: new Float32Array(count),
    fillColors,
    lineColors: new Uint8Array(4 * count),
    ids: undefined,
  };
}

interface Accessors {
  readonly getPosition: (item: unknown, info: { target: number[] }) => number[];
  readonly getColor: (item: unknown, info: { target: number[] }) => number[];
  readonly updateTriggers: Record<string, unknown>;
}

const SHOWN = new Uint8Array([0, 1]);

function accessors(items: ReturnType<typeof labelItems>, groups: FrameGroup[], tick: number) {
  return buildLabelLayer(items, { groups, tick }, SHOWN, "dark").props as unknown as Accessors;
}

const pixels = (lon: number, lat: number) => ({ x: lon, y: lat });

describe("labelItems", () => {
  it("lists the labelled trains of every group and skips empty texts", () => {
    const items = labelItems([["RE 1", "", "S 2"], ["ICE 5"]]);
    expect(items.map((item) => [item.group, item.index, item.text])).toEqual([
      [0, 0, "RE 1"],
      [0, 2, "S 2"],
      [1, 0, "ICE 5"],
    ]);
  });

  it("ranks a later train in the draw order above an earlier one, and the second group above the first", () => {
    const [first, second, night] = labelItems([["A", "B"], ["C"]]);
    expect((second?.priority ?? 0) > (first?.priority ?? 0)).toBe(true);
    expect((night?.priority ?? 0) > (second?.priority ?? 0)).toBe(true);
  });

  it("skips groups without labels", () => {
    expect(labelItems([undefined, undefined])).toEqual([]);
  });
});

describe("buildLabelLayer", () => {
  it("keeps one data array while the trains move and only asks for new positions", () => {
    const items = labelItems([["A", "B"]]);
    const first = buildLabelLayer(
      items,
      { groups: [group([11, 51, 12, 52])], tick: 1 },
      SHOWN,
      "dark",
    );
    const second = buildLabelLayer(
      items,
      { groups: [group([11.1, 51, 12, 52])], tick: 2 },
      SHOWN,
      "dark",
    );
    expect(first.props.data).toBe(second.props.data);
    const a = accessors(items, [group([11, 51, 12, 52])], 1).updateTriggers;
    const b = accessors(items, [group([11.1, 51, 12, 52])], 2).updateTriggers;
    expect(a.getPosition).not.toBe(b.getPosition);
    expect(a.getText).toBe(b.getText);
  });

  it("reads the position of a train from the frame it is given", () => {
    const items = labelItems([["A", "B"]]);
    const read = accessors(items, [group([11, 51, 12, 52])], 1);
    expect(read.getPosition(items[1], { target: [0, 0, 0] })).toEqual([12, 52, 0]);
  });

  it("draws only the labels placed", () => {
    const items = labelItems([["A", "B"]]);
    const read = accessors(items, [group([11, 51, 12, 52])], 1);
    expect(read.getColor(items[0], { target: [0, 0, 0, 0], index: 0 } as never)[3]).toBe(0);
    expect(read.getColor(items[1], { target: [0, 0, 0, 0], index: 1 } as never)[3]).toBe(255);
  });
});

describe("placeLabels", () => {
  const source = (positions: number[], alphas?: number[]) => ({
    groups: [group(positions, alphas)],
    tick: 0,
  });

  it("keeps the later train of two labels that touch, the earlier one when they are apart", () => {
    const items = labelItems([["+3", "+9", "+4"]]);
    const near = placeLabels(items, source([100, 100, 104, 102, 300, 300]), pixels, 800, 600);
    expect(Array.from(near)).toEqual([0, 1, 1]);
  });

  it("gives the place to the train drawn last, which is the worse delay", () => {
    const items = labelItems([["+3", "+20"]]);
    expect(Array.from(placeLabels(items, source([100, 100, 100, 100]), pixels, 800, 600))).toEqual([
      0, 1,
    ]);
  });

  it("skips trains that faded out and trains outside the view", () => {
    const items = labelItems([["A", "B", "C"]]);
    const shown = placeLabels(
      items,
      source([100, 100, 200, 200, 900, 900], [0, 255, 255]),
      pixels,
      800,
      600,
    );
    expect(Array.from(shown)).toEqual([0, 1, 0]);
  });
});

describe("splitSelectedLabel", () => {
  const items = labelItems([["A1", "B2", "C3"], ["N1"]]);
  const ids = [["a", "b", "c"], ["n"]];

  it("moves the label of the selected train from the shown set to a layer of its own", () => {
    const shown = new Uint8Array([1, 1, 0, 1]);
    const split = splitSelectedLabel(items, shown, ids, "b");
    expect(split.under).toEqual(new Uint8Array([1, 0, 0, 1]));
    expect(split.top?.item.text).toBe("B2");
  });

  it("finds a train of the second group", () => {
    const split = splitSelectedLabel(items, new Uint8Array([1, 1, 1, 1]), ids, "n");
    expect(split.top?.item.text).toBe("N1");
    expect(split.under).toEqual(new Uint8Array([1, 1, 1, 0]));
  });

  it("adds nothing when the selected label is not shown, there is none, or no train is selected", () => {
    const shown = new Uint8Array([1, 0, 1, 1]);
    expect(splitSelectedLabel(items, shown, ids, "b")).toEqual({ under: shown, top: null });
    expect(splitSelectedLabel(items, shown, ids, "zz")).toEqual({ under: shown, top: null });
    expect(splitSelectedLabel(items, shown, ids, null)).toEqual({ under: shown, top: null });
  });

  it("draws that label in the top group, after the marker, with the same position as its train", () => {
    const groups = [group([8, 50, 9, 51, 10, 52]), group([11, 53])];
    const split = splitSelectedLabel(items, new Uint8Array([1, 1, 1, 1]), ids, "c");
    const layer = buildLabelLayer(
      split.top ? [split.top.item] : [],
      { groups, tick: 1 },
      Uint8Array.of(1),
      "dark",
      { top: true },
    );
    const props = layer.props as unknown as Accessors & { beforeId?: string };
    expect(props.beforeId).toBeUndefined();
    expect(layer.id).toBe("train-label-selected");
    expect(props.getPosition(split.top?.item, { target: [0, 0, 0] })).toEqual([10, 52, 0]);
  });
});
