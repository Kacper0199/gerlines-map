import type { Layer, UpdateParameters } from "@deck.gl/core";
import { SimpleMeshLayer } from "@deck.gl/mesh-layers";
import type { BufferLayout } from "@luma.gl/core";
import { Geometry, Model } from "@luma.gl/engine";
import { SharedUniforms } from "./shared-uniforms.ts";

/** A mesh as deck.gl and luma.gl take it. */
export interface DeckMesh {
  readonly attributes: {
    readonly positions: { readonly value: Float32Array; readonly size: 3 };
    readonly normals: { readonly value: Float32Array; readonly size: 3 };
    readonly texCoords: { readonly value: Float32Array; readonly size: 2 };
  };
  readonly indices: { readonly value: Uint32Array; readonly size: 1 };
}

/** SimpleMeshLayer, typed as the plain layer it is: its model and texture members are private in its typings. */
interface PlainLayer {
  updateState(params: UpdateParameters<Layer>): void;
  draw(): void;
  _setModelAttributes(model: Model, changed: object, layoutChanged: boolean): void;
  setTexture(texture: unknown): void;
  setShaderModuleProps(...props: object[]): void;
  finalizeState(context: unknown): void;
}
const MeshLayer = SimpleMeshLayer as unknown as {
  new (props: object): PlainLayer;
  prototype: PlainLayer;
};

/** One mesh to draw: its geometry and the slice of the fleet's instance arrays that uses it. */
export interface FleetDraw {
  readonly id: string;
  readonly mesh: DeckMesh;
  readonly start: number;
  readonly count: number;
}

interface Entry {
  readonly draw: FleetDraw;
  readonly model: Model;
  start: number;
}

/**
 * What each vertex array has bound per shader attribute, so an unchanged buffer is not bound again.
 * Keyed on the vertex array, not the model: luma builds a new one whenever the buffer layout changes
 * (a slice that moved), and the new one holds none of the instance buffers yet.
 */
const bound = new WeakMap<object, Map<string, unknown>>();

interface AttributeLike {
  getValue(): Record<string, unknown>;
}

/** The attributes of `changed` that hold a buffer or constant the model does not have bound yet. */
export function unboundAttributes(model: Model, changed: Record<string, AttributeLike>): object {
  const owner = (model as unknown as { vertexArray?: object }).vertexArray ?? model;
  let have = bound.get(owner);
  if (!have) {
    have = new Map();
    bound.set(owner, have);
  }
  const stale: Record<string, AttributeLike> = {};
  for (const name in changed) {
    const attribute = changed[name] as AttributeLike;
    const values = attribute.getValue();
    let differs = false;
    for (const shaderName in values) {
      if (have.get(shaderName) !== values[shaderName]) {
        have.set(shaderName, values[shaderName]);
        differs = true;
      }
    }
    if (differs) stale[name] = attribute;
  }
  return stale;
}

interface FleetState {
  entries: Map<string, Entry>;
  models: Model[];
  shared?: SharedUniforms | undefined;
  emptyTexture: { delete(): void };
  hasNormals: boolean;
}

interface Internals {
  getAttributeManager(): {
    getBufferLayouts(model: unknown): BufferLayout[];
    getAttributes(): object;
  };
  getShaders(): Record<string, unknown>;
  getTextureProps(texture: unknown): Record<string, unknown>;
  _setModelAttributes(model: Model, changed: object, layoutChanged: boolean): void;
  setState(state: Partial<FleetState>): void;
  state: FleetState;
  context: {
    device: ConstructorParameters<typeof Model>[0];
    viewport: unknown;
    renderPass: Parameters<Model["draw"]>[0];
  };
  props: {
    id: string;
    texture: unknown;
    fleet: readonly FleetDraw[];
    sizeScale: number;
    coordinateSystem: string;
    _instanced: boolean;
  };
}

/** The buffer layouts with every attribute starting `first` instances into its buffer. */
export function shiftedLayouts(layouts: BufferLayout[], first: number): BufferLayout[] {
  if (first === 0) return layouts;
  return layouts.map((layout) => {
    const skip = first * (layout.byteStride ?? 0);
    return {
      ...layout,
      attributes: layout.attributes?.map((attribute) => ({
        ...attribute,
        byteOffset: (attribute.byteOffset ?? 0) + skip,
      })),
    } as BufferLayout;
  });
}

function shouldCompose(viewport: unknown, coordinateSystem: string): boolean {
  return (
    coordinateSystem === "cartesian" ||
    coordinateSystem === "meter-offsets" ||
    (coordinateSystem === "default" && !(viewport as { isGeospatial: boolean }).isGeospatial)
  );
}

function geometryOf(mesh: DeckMesh): Geometry {
  const { positions, normals, texCoords } = mesh.attributes;
  const vertices = positions.value.length / 3;
  return new Geometry({
    topology: "triangle-list",
    attributes: {
      positions,
      colors: { size: 3, value: new Float32Array(vertices * 3).fill(1) },
      normals,
      texCoords,
    },
    indices: mesh.indices,
  });
}

/**
 * Every car of a frame in one deck layer. Instance attributes live in one buffer each, shared by all
 * meshes; every mesh gets its own model that reads its slice of those buffers (the vertex attribute
 * offset is moved to the slice) and draws it with one instanced call. deck.gl then updates and
 * draws one layer instead of one per mesh and level of detail, which is where the frame time went.
 */
export class CarFleetLayer extends MeshLayer {
  static layerName = "CarFleetLayer";
  static defaultProps = {
    fleet: { type: "object", value: [], compare: false },
  };

  override updateState(params: UpdateParameters<Layer>): void {
    super.updateState(params);
    const self = this as unknown as Internals;
    if (!self.state.entries) {
      self.setState({ entries: new Map(), models: [], hasNormals: true });
    }
    this.syncModels(Boolean(params.changeFlags.extensionsChanged));
  }

  private syncModels(rebuild: boolean): void {
    const self = this as unknown as Internals;
    const { entries } = self.state;
    const draws = self.props.fleet;
    const wanted = new Set(draws.map((draw) => draw.id));
    let changed = false;
    for (const [id, entry] of entries) {
      if (rebuild || !wanted.has(id)) {
        entry.model.destroy();
        entries.delete(id);
        changed = true;
      }
    }
    if (entries.size === 0 && self.state.shared) {
      self.state.shared.destroy();
      self.setState({ shared: undefined });
    }
    const manager = self.getAttributeManager();
    for (const draw of draws) {
      const known = entries.get(draw.id);
      if (known && known.draw.mesh === draw.mesh) {
        known.model.setInstanceCount(draw.count);
        if (known.start !== draw.start) {
          known.start = draw.start;
          this.relayout(known.model, draw.start);
          self._setModelAttributes(known.model, manager.getAttributes(), false);
        }
        continue;
      }
      known?.model.destroy();
      const model = this.createModel(draw);
      model.setInstanceCount(draw.count);
      self._setModelAttributes(model, manager.getAttributes(), false);
      entries.set(draw.id, { draw, model, start: draw.start });
      changed = true;
    }
    if (changed) self.setState({ models: [...entries.values()].map((entry) => entry.model) });
  }

  private relayout(model: Model, start: number): void {
    const self = this as unknown as Internals;
    const before = (model as unknown as { vertexArray: { destroy(): void } }).vertexArray;
    model.setBufferLayout(
      shiftedLayouts(self.getAttributeManager().getBufferLayouts(model), start),
    );
    const after = (model as unknown as { vertexArray: { destroy(): void } }).vertexArray;
    if (before !== after) before.destroy();
  }

  private createModel(draw: FleetDraw): Model {
    const self = this as unknown as Internals;
    const { shared } = self.state;
    const model = new Model(self.context.device, {
      ...self.getShaders(),
      id: `${self.props.id}-${draw.id}`,
      bufferLayout: shiftedLayouts(
        self.getAttributeManager().getBufferLayouts({ isInstanced: true }),
        draw.start,
      ),
      geometry: geometryOf(draw.mesh),
      isInstanced: true,
      ...(shared ? { shaderInputs: shared.inputs } : {}),
    } as never);
    if (shared) {
      shared.join(model);
    } else {
      model.shaderInputs.setProps({ simpleMesh: self.getTextureProps(self.props.texture) });
      self.setState({ shared: SharedUniforms.adopt(model) });
    }
    return model;
  }

  override _setModelAttributes(model: Model, changed: object, layoutChanged: boolean): void {
    const self = this as unknown as Internals;
    const start = [...self.state.entries.values()].find((entry) => entry.model === model)?.start;
    let attributes = changed;
    if (layoutChanged) {
      this.relayout(model, start ?? 0);
      attributes = self.getAttributeManager().getAttributes();
    }
    attributes = unboundAttributes(model, attributes as Record<string, AttributeLike>);
    (MeshLayer.prototype as unknown as Internals)._setModelAttributes.call(
      this,
      model,
      attributes,
      false,
    );
  }

  override setTexture(texture: unknown): void {
    const self = this as unknown as Internals;
    self.state.shared?.inputs.setProps({ simpleMesh: self.getTextureProps(texture) } as never);
  }

  /** The models share their shader inputs, so the props are set once instead of once per model. */
  override setShaderModuleProps(...props: object[]): void {
    const self = this as unknown as Internals;
    self.state.shared?.inputs.setProps(...(props as [never]));
  }

  override finalizeState(context: unknown): void {
    const self = this as unknown as Internals;
    super.finalizeState(context);
    self.state.shared?.destroy();
  }

  override draw(): void {
    const self = this as unknown as Internals;
    const { models } = self.state;
    if (!models?.length) return;
    const { viewport, renderPass } = self.context;
    const { sizeScale, coordinateSystem, _instanced } = self.props;
    const simpleMesh = {
      sizeScale,
      composeModelMatrix: !_instanced || shouldCompose(viewport, coordinateSystem),
      flatShading: false,
    };
    const { shared } = self.state;
    shared?.inputs.setProps({ simpleMesh } as never);
    const { device } = self.context;
    shared?.update(device.type === "webgpu" ? undefined : device.commandEncoder);
    for (const model of models) model.draw(renderPass);
  }
}

export function fleetLayer(props: object): Layer {
  return new CarFleetLayer(props) as unknown as Layer;
}
