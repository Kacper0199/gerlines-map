import type { UniformStore } from "@luma.gl/core";
import type { Model, ShaderInputs } from "@luma.gl/engine";

/** The members of luma's Model that the fleet's models share their uniforms through. */
interface Shareable {
  shaderInputs: ShaderInputs;
  _uniformStore: UniformStore;
  bindings: Record<string, unknown>;
}

/** A view of the store that models write through and destroy without effect: the fleet writes and frees it. */
function quietView(store: UniformStore): UniformStore {
  return Object.create(store, {
    setUniforms: { value: () => undefined },
    destroy: { value: () => undefined },
  }) as UniformStore;
}

/**
 * One set of shader inputs and one uniform store (one GPU buffer per uniform block) for all models
 * of the fleet layer. Every model draws with the same projection, picking, layer and texture values,
 * so deck.gl and luma.gl packing and uploading them once per model is the same work 19 times. The
 * first model is adopted, later models are built with `inputs` and join; each frame the layer sets
 * the module props on `inputs` once and calls `update`, and the models' own updates do nothing.
 */
export class SharedUniforms {
  readonly inputs: ShaderInputs;
  private readonly store: UniformStore;

  private constructor(inputs: ShaderInputs, store: UniformStore) {
    this.inputs = inputs;
    this.store = store;
  }

  /** Takes over the inputs and the uniform store of the first model. */
  static adopt(model: Model): SharedUniforms {
    const lead = model as unknown as Shareable;
    const shared = new SharedUniforms(lead.shaderInputs, lead._uniformStore);
    lead._uniformStore = quietView(shared.store);
    return shared;
  }

  /** Points a model built with `inputs` at the shared uniform buffers and frees the ones it made. */
  join(model: Model): void {
    const member = model as unknown as Shareable;
    for (const name of Object.keys(this.inputs.modules)) {
      const binding = `${name}Uniforms`;
      if (binding in member.bindings) {
        member.bindings[binding] = this.store.getManagedUniformBuffer(name);
      }
    }
    member._uniformStore.destroy();
    member._uniformStore = quietView(this.store);
  }

  /** Writes the blocks whose values changed since the last frame. */
  update(commandEncoder: object | undefined): void {
    this.store.setUniforms(this.inputs.getUniformValues() as never, commandEncoder as never);
  }

  destroy(): void {
    this.store.destroy();
  }
}
