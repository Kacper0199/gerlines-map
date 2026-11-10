import { UniformStore } from "@luma.gl/core";
import { type Model, ShaderInputs } from "@luma.gl/engine";
import { describe, expect, it } from "vitest";
import { SharedUniforms } from "./shared-uniforms.ts";

const MODULES = {
  project: { name: "project", uniformTypes: { scale: "f32", offset: "vec2<f32>" } },
  layer: { name: "layer", uniformTypes: { opacity: "f32" } },
} as const;

interface FakeBuffer {
  readonly name: string;
  writes: number;
  last: Uint8Array | undefined;
  destroyed: boolean;
  write(data: Uint8Array): void;
  destroy(): void;
}

class FakeDevice {
  readonly type = "webgl";
  readonly buffers: FakeBuffer[] = [];
  commandEncoder = {};

  createBuffer(): FakeBuffer {
    const buffer: FakeBuffer = {
      name: `buffer-${this.buffers.length}`,
      writes: 0,
      last: undefined,
      destroyed: false,
      write(data) {
        buffer.writes += 1;
        buffer.last = Uint8Array.from(data);
      },
      destroy() {
        buffer.destroyed = true;
      },
    };
    this.buffers.push(buffer);
    return buffer;
  }

  writeBufferViaCommandEncoder(_encoder: object, buffer: FakeBuffer, data: Uint8Array): void {
    buffer.write(data);
  }
}

/** A model as luma builds it: its own shader inputs (or shared ones), its own uniform store and uniform buffer bindings. */
class FakeModel {
  readonly shaderInputs: ShaderInputs;
  _uniformStore: UniformStore;
  readonly bindings: Record<string, unknown> = { sampler: "palette" };
  readonly uniformBuffers: Record<string, unknown>;
  destroyed = false;

  constructor(device: FakeDevice, shared?: ShaderInputs) {
    this.shaderInputs = shared ?? new ShaderInputs({ ...MODULES } as never);
    this._uniformStore = new UniformStore(device as never, this.shaderInputs.modules as never);
    for (const name of Object.keys(MODULES)) {
      this.bindings[`${name}Uniforms`] = this._uniformStore.getManagedUniformBuffer(name);
    }
    this.uniformBuffers = { ...this.bindings };
  }

  updateShaderInputs(commandEncoder: object): void {
    this._uniformStore.setUniforms(
      this.shaderInputs.getUniformValues() as never,
      commandEncoder as never,
    );
  }

  setBindings(): void {}

  destroy(): void {
    this.destroyed = true;
    this._uniformStore.destroy();
  }
}

function frame(models: FakeModel[], shared: SharedUniforms | undefined, scale: number): void {
  const props = { project: { scale, offset: [scale, 1] }, layer: { opacity: 0.5 } };
  if (shared) {
    shared.inputs.setProps(props as never);
    shared.update({});
  } else {
    for (const model of models) model.shaderInputs.setProps(props as never);
  }
  for (const model of models) model.updateShaderInputs({});
}

function fleet(count: number, device: FakeDevice, share: boolean) {
  const first = new FakeModel(device);
  const shared = share ? SharedUniforms.adopt(first as unknown as Model) : undefined;
  const models = [first];
  for (let i = 1; i < count; i++) {
    const model = new FakeModel(device, shared?.inputs);
    shared?.join(model as unknown as Model);
    models.push(model);
  }
  return { models, shared };
}

function writesOf(device: FakeDevice): number {
  return device.buffers.reduce((sum, buffer) => sum + buffer.writes, 0);
}

describe("SharedUniforms", () => {
  it("writes each uniform block once per frame for the whole fleet, not once per model", () => {
    const own = new FakeDevice();
    const separate = fleet(19, own, false);
    frame(separate.models, undefined, 1);
    const perModel = writesOf(own);

    const device = new FakeDevice();
    const { models, shared } = fleet(19, device, true);
    const before = writesOf(device);
    frame(models, shared, 1);
    expect(writesOf(device) - before).toBe(Object.keys(MODULES).length);
    expect(perModel).toBe(19 * Object.keys(MODULES).length);
  });

  it("gives every model the lead's uniform buffers and leaves other bindings alone", () => {
    const { models } = fleet(4, new FakeDevice(), true);
    const lead = models[0] as FakeModel;
    for (const model of models) {
      expect(model.bindings.projectUniforms).toBe(lead.uniformBuffers.projectUniforms);
      expect(model.bindings.layerUniforms).toBe(lead.uniformBuffers.layerUniforms);
      expect(model.bindings.sampler).toBe("palette");
    }
  });

  it("releases the buffers a joining model allocated for itself", () => {
    const device = new FakeDevice();
    const { models } = fleet(3, device, true);
    const lead = models[0] as FakeModel;
    const kept = new Set([lead.uniformBuffers.projectUniforms, lead.uniformBuffers.layerUniforms]);
    for (const buffer of device.buffers) {
      expect(buffer.destroyed, buffer.name).toBe(!kept.has(buffer));
    }
  });

  it("carries the new values to the shared buffers on every frame, and nothing when they repeat", () => {
    const device = new FakeDevice();
    const { models, shared } = fleet(5, device, true);
    frame(models, shared, 1);
    const afterFirst = writesOf(device);
    frame(models, shared, 1);
    expect(writesOf(device)).toBe(afterFirst);
    frame(models, shared, 2);
    expect(writesOf(device)).toBe(afterFirst + 1);
    const lead = models[0] as FakeModel;
    const buffer = lead.bindings.projectUniforms as FakeBuffer;
    expect(new Float32Array(buffer.last?.buffer ?? new ArrayBuffer(0))[0]).toBe(2);
  });

  it("keeps the shared buffers alive while models come and go, and frees them with the fleet", () => {
    const device = new FakeDevice();
    const { models, shared } = fleet(3, device, true);
    const lead = models[0] as FakeModel;
    lead.destroy();
    models[1]?.destroy();
    const live = [
      lead.uniformBuffers.projectUniforms,
      lead.uniformBuffers.layerUniforms,
    ] as FakeBuffer[];
    expect(live.every((buffer) => !buffer.destroyed)).toBe(true);
    shared?.destroy();
    expect(live.every((buffer) => buffer.destroyed)).toBe(true);
  });

  it("lets a model that joins later use the same buffers", () => {
    const device = new FakeDevice();
    const { models, shared } = fleet(2, device, true);
    frame(models, shared, 3);
    const late = new FakeModel(device, shared?.inputs);
    shared?.join(late as unknown as Model);
    expect(late.bindings.projectUniforms).toBe((models[0] as FakeModel).bindings.projectUniforms);
    const before = writesOf(device);
    frame([...models, late], shared, 3);
    expect(writesOf(device)).toBe(before);
  });
});
