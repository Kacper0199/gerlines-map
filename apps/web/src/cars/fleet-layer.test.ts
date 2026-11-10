import { Buffer } from "@luma.gl/core";
import { beforeEach, describe, expect, it } from "vitest";
import { CarFleetLayer, type FleetDraw, shiftedLayouts } from "./fleet-layer.ts";

const INSTANCE_ATTRIBUTES = [
  { name: "instancePositions", stride: 12, dynamic: true },
  { name: "instanceModelMatrix", stride: 48, dynamic: true },
  { name: "instanceColors", stride: 4, dynamic: false },
  { name: "instanceLiveryRow", stride: 4, dynamic: false },
  { name: "instanceFleetIndex", stride: 4, dynamic: false },
] as const;

const GEOMETRY = "geometry";

interface FakeVertexArray {
  buffers: Record<string, unknown>;
  destroyed: boolean;
  destroy(): void;
}

const liveVertexArrays = new Set<FakeVertexArray>();

function newVertexArray(): FakeVertexArray {
  const vertexArray: FakeVertexArray = {
    buffers: { positions: GEOMETRY },
    destroyed: false,
    destroy() {
      vertexArray.destroyed = true;
      liveVertexArrays.delete(vertexArray);
    },
  };
  liveVertexArrays.add(vertexArray);
  return vertexArray;
}

class FakeModel {
  vertexArray: FakeVertexArray = newVertexArray();
  bufferLayout: unknown;
  instanceCount = 0;
  userData = {};
  bindCalls = 0;
  destroyed = false;

  constructor(layout: unknown) {
    this.bufferLayout = layout;
  }

  setBufferLayout(layout: unknown): void {
    if (JSON.stringify(layout) === JSON.stringify(this.bufferLayout)) return;
    this.bufferLayout = layout;
    this.vertexArray = newVertexArray();
  }

  setAttributes(buffers: Record<string, unknown>): void {
    if (Object.keys(buffers).length > 0) this.bindCalls += 1;
    Object.assign(this.vertexArray.buffers, buffers);
  }

  setConstantAttributes(): void {}
  setIndexBuffer(): void {}
  setInstanceCount(count: number): void {
    this.instanceCount = count;
  }
  destroy(): void {
    this.destroyed = true;
    this.vertexArray.destroy();
  }
}

function newBuffer(): Buffer {
  return Object.create(Buffer.prototype) as Buffer;
}

/** A CarFleetLayer without a GL device: fake models, a fake attribute manager, deck's own binding code. */
class Harness {
  readonly layer: CarFleetLayer;
  readonly buffers = new Map<string, Buffer>();
  readonly created: FakeModel[] = [];
  capacity = 0;
  private readonly meshes = new Map<number, object>();

  constructor(capacity = 1) {
    const layer = Object.create(CarFleetLayer.prototype) as CarFleetLayer;
    const host = layer as unknown as Record<string, unknown>;
    host.state = { entries: new Map(), models: [], hasNormals: true };
    host.props = { id: "cars", fleet: [] };
    host.setState = (next: object) => Object.assign(host.state as object, next);
    host.getAttributeManager = () => this.manager();
    host.createModel = (draw: FleetDraw) => {
      const model = new FakeModel(shiftedLayouts(this.layouts(), draw.start));
      this.created.push(model);
      return model;
    };
    this.layer = layer;
    this.grow(capacity);
  }

  private layouts() {
    return INSTANCE_ATTRIBUTES.map(({ name, stride }) => ({
      name,
      stepMode: "instance" as const,
      byteStride: stride,
      attributes: [{ attribute: name, format: "float32" as const, byteOffset: 0 }],
    }));
  }

  private attributes() {
    return Object.fromEntries(
      INSTANCE_ATTRIBUTES.map(({ name }) => [
        name,
        {
          settings: { isIndexed: false },
          getValue: () => ({ [name]: this.buffers.get(name) }),
        },
      ]),
    );
  }

  private manager() {
    return {
      hasBufferGroups: () => false,
      getBufferLayouts: () => this.layouts(),
      getAttributes: () => this.attributes(),
    };
  }

  private grow(capacity: number): void {
    this.capacity = capacity;
    for (const { name } of INSTANCE_ATTRIBUTES) this.buffers.set(name, newBuffer());
  }

  /** The layout change deck reports when an attribute's layout changed (`_setModelAttributes(model, changed, true)`). */
  relayoutAll(): void {
    const host = this.layer as unknown as {
      state: { models: FakeModel[] };
      _setModelAttributes(model: FakeModel, changed: object, layoutChanged: boolean): void;
    };
    for (const model of host.state.models) host._setModelAttributes(model, this.attributes(), true);
  }

  /** What deck does for one frame: the layer syncs its models, then updates the attributes it must. */
  frame(counts: readonly number[]): void {
    const host = this.layer as unknown as {
      props: { fleet: FleetDraw[] };
      state: { entries: Map<string, { model: FakeModel; start: number }>; models: FakeModel[] };
      syncModels(rebuild: boolean): void;
      _setModelAttributes(model: FakeModel, changed: object, layoutChanged: boolean): void;
    };
    let start = 0;
    const fleet: FleetDraw[] = [];
    counts.forEach((count, i) => {
      if (count === 0) return;
      const mesh = this.meshes.get(i) ?? { id: i };
      this.meshes.set(i, mesh);
      fleet.push({ id: `mesh-${i}`, mesh: mesh as never, start, count });
      start += count;
    });
    host.props.fleet = fleet;
    host.syncModels(false);
    const grown = start > this.capacity;
    let changed = this.attributes();
    if (grown) {
      this.grow(Math.max(start, this.capacity * 2));
      changed = this.attributes();
    } else {
      changed = Object.fromEntries(
        Object.entries(this.attributes()).filter(
          ([name]) => INSTANCE_ATTRIBUTES.find((a) => a.name === name)?.dynamic,
        ),
      );
    }
    for (const model of host.state.models) host._setModelAttributes(model, changed, false);
  }

  /** Every drawn model reads the current buffers of every attribute, from its own slice. */
  missing(): string[] {
    const host = this.layer as unknown as {
      state: { entries: Map<string, { model: FakeModel; start: number }> };
    };
    const problems: string[] = [];
    for (const [id, entry] of host.state.entries) {
      const model = entry.model;
      for (const { name, stride } of INSTANCE_ATTRIBUTES) {
        if (model.vertexArray.buffers[name] !== this.buffers.get(name)) {
          problems.push(`${id} has no current buffer for ${name}`);
        }
        const layout = (
          model.bufferLayout as { name: string; attributes: { byteOffset: number }[] }[]
        ).find((l) => l.name === name);
        if (layout?.attributes[0]?.byteOffset !== entry.start * stride) {
          problems.push(`${id} reads ${name} from the wrong offset`);
        }
      }
    }
    return problems;
  }
}

function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

beforeEach(() => liveVertexArrays.clear());

describe("CarFleetLayer with a running clock", () => {
  it("rebinds every instance buffer of a model whose slice moved", () => {
    const harness = new Harness(100);
    harness.frame([3, 4, 2]);
    expect(harness.missing()).toEqual([]);
    harness.frame([5, 4, 2]);
    expect(harness.missing()).toEqual([]);
  });

  it("rebinds a model whose earlier meshes lose all their trains", () => {
    const harness = new Harness(100);
    harness.frame([3, 4, 2]);
    harness.frame([0, 4, 2]);
    expect(harness.missing()).toEqual([]);
    harness.frame([0, 0, 2]);
    expect(harness.missing()).toEqual([]);
  });

  it("keeps every model bound through hundreds of frames of trains entering, leaving and buffers growing", () => {
    const harness = new Harness();
    const random = lcg(52);
    let counts = [4, 9, 0, 3, 6, 1];
    for (let frame = 0; frame < 400; frame++) {
      counts = counts.map((count) => {
        const r = random();
        if (r < 0.15) return Math.max(0, count - 1 - Math.floor(random() * 3));
        if (r < 0.3) return count + 1 + Math.floor(random() * 3);
        return count;
      });
      harness.frame(counts);
      expect(harness.missing(), `frame ${frame} counts ${counts}`).toEqual([]);
    }
  });

  it("does not bind anything on a frame in which no slice moved and no buffer grew", () => {
    const harness = new Harness(100);
    harness.frame([3, 4, 2]);
    const before = harness.created.reduce((sum, model) => sum + model.bindCalls, 0);
    for (let i = 0; i < 5; i++) harness.frame([3, 4, 2]);
    expect(harness.created.reduce((sum, model) => sum + model.bindCalls, 0)).toBe(before);
    expect(harness.missing()).toEqual([]);
  });

  it("binds a new model once even though deck updates the same buffers again", () => {
    const harness = new Harness(100);
    harness.frame([3]);
    harness.frame([3, 2]);
    const added = harness.created[1] as FakeModel;
    expect(added.bindCalls).toBe(1);
    expect(harness.missing()).toEqual([]);
  });

  it("leaves no extra live vertex array when a slice moves and luma replaces the vertex array", () => {
    const harness = new Harness(100);
    harness.frame([3, 4, 2]);
    expect(liveVertexArrays.size).toBe(3);
    for (let i = 0; i < 20; i++) {
      harness.frame([3 + (i % 5), 4, 2]);
      expect(liveVertexArrays.size, `frame ${i}`).toBe(3);
    }
    expect(harness.missing()).toEqual([]);
  });

  it("keeps a vertex array that luma did not replace", () => {
    const harness = new Harness(100);
    harness.frame([3, 4, 2]);
    const before = harness.created.map((model) => model.vertexArray);
    harness.frame([3, 4, 2]);
    expect(harness.created.map((model) => model.vertexArray)).toEqual(before);
    expect(before.every((vertexArray) => !vertexArray.destroyed)).toBe(true);
  });

  it("rebuilds every model's offsets and buffers on a layout change from deck", () => {
    const harness = new Harness(100);
    harness.frame([3, 4, 2]);
    const staleOffsets = harness.created.map((model) => model.bufferLayout);
    harness.relayoutAll();
    expect(harness.missing()).toEqual([]);
    expect(harness.created.map((model) => model.bufferLayout)).toEqual(staleOffsets);
    expect(liveVertexArrays.size).toBe(3);
  });

  it("applies the slice offsets and binds every buffer after a layout change that moved a slice", () => {
    const harness = new Harness(100);
    harness.frame([3, 4, 2]);
    const host = harness.layer as unknown as {
      state: { entries: Map<string, { start: number }> };
    };
    for (const [id, start] of [
      ["mesh-1", 7],
      ["mesh-2", 1],
    ] as const) {
      const entry = host.state.entries.get(id);
      if (entry) entry.start = start;
    }
    harness.relayoutAll();
    const offsets = (id: string, name: string) => {
      const model = harness.created[Number(id.slice(-1))] as FakeModel;
      const layout = (
        model.bufferLayout as { name: string; attributes: { byteOffset: number }[] }[]
      ).find((l) => l.name === name);
      return layout?.attributes[0]?.byteOffset;
    };
    expect(offsets("mesh-1", "instanceModelMatrix")).toBe(7 * 48);
    expect(offsets("mesh-2", "instancePositions")).toBe(1 * 12);
    expect(harness.missing()).toEqual([]);
    expect(liveVertexArrays.size).toBe(3);
  });
});
