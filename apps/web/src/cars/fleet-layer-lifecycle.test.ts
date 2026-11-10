import { beforeEach, describe, expect, it, vi } from "vitest";

const world = vi.hoisted(() => ({
  stores: [] as { destroyed: number; writes: number; buffers: Map<string, object> }[],
  models: [] as unknown[],
}));

vi.mock("@luma.gl/engine", async (original) => {
  const actual = await original<typeof import("@luma.gl/engine")>();
  class FakeStore {
    destroyed = 0;
    writes = 0;
    buffers = new Map<string, object>();
    uniformBlocks = new Map();
    uniformBuffers = new Map();
    constructor() {
      world.stores.push(this);
    }
    getManagedUniformBuffer(name: string): object {
      let buffer = this.buffers.get(name);
      if (!buffer) {
        buffer = { name };
        this.buffers.set(name, buffer);
      }
      return buffer;
    }
    setUniforms(): void {
      this.writes += 1;
    }
    destroy(): void {
      this.destroyed += 1;
    }
  }
  class FakeInputs {
    modules = { project: {}, layer: {} };
    props: object[] = [];
    setProps(props: object): void {
      this.props.push(props);
    }
    getUniformValues(): object {
      return {};
    }
  }
  class FakeModel {
    shaderInputs: FakeInputs;
    _uniformStore = new FakeStore();
    bindings: Record<string, unknown>;
    vertexArray = { destroy() {} };
    instanceCount = 0;
    destroyed = false;
    draws = 0;
    updates = 0;
    constructor(_device: unknown, props: { shaderInputs?: FakeInputs }) {
      this.shaderInputs = props.shaderInputs ?? new FakeInputs();
      this.bindings = {
        projectUniforms: this._uniformStore.getManagedUniformBuffer("project"),
        layerUniforms: this._uniformStore.getManagedUniformBuffer("layer"),
        palette: "palette",
      };
      world.models.push(this);
    }
    setInstanceCount(count: number): void {
      this.instanceCount = count;
    }
    setBufferLayout(): void {}
    setAttributes(): void {}
    setConstantAttributes(): void {}
    updateShaderInputs(): void {
      this.updates += 1;
      this._uniformStore.setUniforms();
    }
    draw(): boolean {
      this.draws += 1;
      this.updateShaderInputs();
      return true;
    }
    destroy(): void {
      this.destroyed = true;
      this._uniformStore.destroy();
    }
  }
  class FakeGeometry {}
  return { ...actual, Model: FakeModel, Geometry: FakeGeometry };
});

const { CarFleetLayer } = await import("./fleet-layer.ts");

interface FakeStoreShape {
  destroyed: number;
  writes: number;
}
interface Host {
  state: Record<string, unknown>;
  props: Record<string, unknown>;
  context: Record<string, unknown>;
  [key: string]: unknown;
}

const MESH = { attributes: { positions: { value: new Float32Array(9), size: 3 } } };

function layer(deviceType = "webgl"): { host: Host; layer: InstanceType<typeof CarFleetLayer> } {
  const instance = Object.create(CarFleetLayer.prototype) as InstanceType<typeof CarFleetLayer>;
  const host = instance as unknown as Host;
  host.state = { entries: new Map(), models: [], hasNormals: true, emptyTexture: { delete() {} } };
  host.props = {
    id: "cars",
    fleet: [],
    texture: "palette",
    sizeScale: 1,
    coordinateSystem: "default",
    _instanced: true,
  };
  host.context = {
    device: { type: deviceType, commandEncoder: { encoder: true } },
    viewport: { isGeospatial: true },
    renderPass: { pass: true },
    resourceManager: { unsubscribe() {} },
  };
  host.setState = (next: object) => Object.assign(host.state, next);
  host.getShaders = () => ({});
  host.getTextureProps = (texture: unknown) => ({ sampler: texture });
  host.getAttributeManager = () => ({
    getBufferLayouts: () => [],
    getAttributes: () => ({}),
    finalize() {},
  });
  host.getModels = () => host.state.models;
  host.internalState = { uniformTransitions: { clear() {} }, finalize() {} };
  return { host, layer: instance };
}

function sync(host: Host, draws: { id: string; mesh?: object; start?: number; count: number }[]) {
  host.props.fleet = draws.map((draw, i) => ({
    id: draw.id,
    mesh: draw.mesh ?? MESH,
    start: draw.start ?? i * 10,
    count: draw.count,
  }));
  (host as unknown as { syncModels(rebuild: boolean): void }).syncModels(false);
}

const liveStores = () => world.stores.filter((store) => store.destroyed === 0);
const sharedOf = (host: Host) => host.state.shared as { inputs: { props: object[] } } | undefined;

beforeEach(() => {
  world.stores.length = 0;
  world.models.length = 0;
});

describe("CarFleetLayer shared uniforms over the life of the layer", () => {
  it("keeps one live store for any number of models and frees the ones the joining models made", () => {
    const { host } = layer();
    sync(host, [
      { id: "a", count: 3 },
      { id: "b", count: 2 },
      { id: "c", count: 1 },
    ]);
    expect(world.models.length).toBe(3);
    expect(liveStores().length).toBe(1);
    expect(world.stores.filter((store) => store.destroyed === 1).length).toBe(2);
    expect(world.stores.every((store) => store.destroyed <= 1)).toBe(true);
  });

  it("keeps the store when the lead model is replaced for a new mesh while the others stay", () => {
    const { host } = layer();
    sync(host, [
      { id: "a", count: 3 },
      { id: "b", count: 2 },
    ]);
    const store = liveStores()[0] as FakeStoreShape;
    sync(host, [
      { id: "a", count: 3, mesh: { ...MESH } },
      { id: "b", count: 2 },
    ]);
    expect((world.models[0] as { destroyed: boolean }).destroyed).toBe(true);
    expect(world.models.length).toBe(3);
    expect(liveStores()).toEqual([store]);
    expect(store.destroyed).toBe(0);
  });

  it("destroys the store once when every model is gone and makes a new one for the next model", () => {
    const { host } = layer();
    sync(host, [
      { id: "a", count: 3 },
      { id: "b", count: 2 },
    ]);
    const first = liveStores()[0] as FakeStoreShape;
    sync(host, []);
    expect(first.destroyed).toBe(1);
    expect(host.state.shared).toBeUndefined();
    sync(host, [{ id: "c", count: 1 }]);
    const second = liveStores()[0] as FakeStoreShape;
    expect(second).not.toBe(first);
    expect(first.destroyed).toBe(1);
    expect(liveStores().length).toBe(1);
  });

  it("finalizes without freeing a store twice, whether or not the models were cleared first", () => {
    const first = layer();
    sync(first.host, [{ id: "a", count: 3 }]);
    const live = liveStores()[0] as FakeStoreShape;
    first.layer.finalizeState({});
    expect(live.destroyed).toBe(1);

    const cleared = layer();
    sync(cleared.host, [{ id: "a", count: 3 }]);
    const other = liveStores().filter((store) => store !== live)[0] as FakeStoreShape;
    sync(cleared.host, []);
    expect(other.destroyed).toBe(1);
    cleared.layer.finalizeState({});
    expect(other.destroyed).toBe(1);
  });

  it("sets the module props once for all models and writes the shared store once per frame", () => {
    const { host, layer: instance } = layer();
    sync(host, [
      { id: "a", count: 3 },
      { id: "b", count: 2 },
      { id: "c", count: 1 },
    ]);
    const store = liveStores()[0] as FakeStoreShape;
    const inputs = sharedOf(host)?.inputs as { props: object[] };
    const before = inputs.props.length;
    instance.setShaderModuleProps({ project: { scale: 2 } });
    expect(inputs.props.length).toBe(before + 1);
    const writes = store.writes;
    instance.draw();
    expect(store.writes - writes).toBe(1 + 0);
    for (const model of world.models as { draws: number }[]) expect(model.draws).toBe(1);
  });

  it("gives the uniform write no command encoder on WebGPU and the device's encoder on WebGL", () => {
    for (const [type, expected] of [
      ["webgl", { encoder: true }],
      ["webgpu", undefined],
    ] as const) {
      const { host, layer: instance } = layer(type);
      sync(host, [{ id: "a", count: 1 }]);
      const shared = host.state.shared as { update(encoder: unknown): void };
      const update = vi.spyOn(shared, "update");
      instance.draw();
      expect(update).toHaveBeenCalledWith(expected);
    }
  });
});
