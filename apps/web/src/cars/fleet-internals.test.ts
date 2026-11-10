import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Layer } from "@deck.gl/core";
import { SimpleMeshLayer } from "@deck.gl/mesh-layers";
import { UniformStore } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import { describe, expect, it } from "vitest";

const DECK = "9.4.1";
const LUMA = "9.4.2";
const PACKAGES = [
  ["@deck.gl/core", DECK],
  ["@deck.gl/layers", DECK],
  ["@deck.gl/maplibre", DECK],
  ["@deck.gl/mesh-layers", DECK],
  ["@luma.gl/core", LUMA],
  ["@luma.gl/engine", LUMA],
] as const;

function read(url: string): string {
  return readFileSync(fileURLToPath(new URL(url, import.meta.url)), "utf8");
}

function source(fn: unknown): string {
  return String(fn);
}

/**
 * CarFleetLayer reaches into deck.gl and luma.gl members that are not public API. A
 * version bump has to come with a re-run of the running-clock frame probe and a look at picking and
 * the casing in the browser, so these tests fail on any other version and on any renamed member.
 */
describe("deck.gl and luma.gl internals the fleet layer relies on", () => {
  it("pins the catalog to exactly the versions the layer was written and probed against", () => {
    const catalog = read("../../../../pnpm-workspace.yaml");
    for (const [name, version] of PACKAGES) {
      expect(catalog).toContain(`"${name}": ${version}\n`);
    }
  });

  it("runs on exactly those installed versions", () => {
    for (const [name, version] of PACKAGES) {
      const installed = JSON.parse(read(`../../node_modules/${name}/package.json`)) as {
        version: string;
      };
      expect(installed.version, name).toBe(version);
    }
  });

  it("finds the members it overrides and calls on SimpleMeshLayer", () => {
    const proto = SimpleMeshLayer.prototype as unknown as Record<string, unknown>;
    for (const member of [
      "updateState",
      "draw",
      "setTexture",
      "getTextureProps",
      "getShaders",
      "getAttributeManager",
      "_setModelAttributes",
    ]) {
      expect(typeof proto[member], member).toBe("function");
    }
  });

  it("finds the members it calls on luma's Model", () => {
    const proto = Model.prototype as unknown as Record<string, unknown>;
    for (const member of [
      "setBufferLayout",
      "setAttributes",
      "setConstantAttributes",
      "setInstanceCount",
      "draw",
      "destroy",
    ]) {
      expect(typeof proto[member], member).toBe("function");
    }
  });

  it("still gets a new vertex array from luma when the buffer layout changes", () => {
    expect(source(Model.prototype.setBufferLayout)).toContain("this.vertexArray = ");
    expect(source(Model.prototype.setBufferLayout)).toContain("createVertexArray");
  });

  it("keeps the vertex array when the geometry is replaced, so only a layout change needs the rebind", () => {
    expect(source(Model.prototype.setGeometry)).not.toContain("createVertexArray");
    expect(source(Model.prototype.setGeometry)).not.toContain("this.vertexArray = ");
  });

  it("still draws SimpleMeshLayer with the uniforms the fleet layer copies", () => {
    const proto = SimpleMeshLayer.prototype as unknown as Record<string, unknown>;
    const draw = source(SimpleMeshLayer.prototype.draw);
    for (const word of ["sizeScale", "composeModelMatrix", "flatShading", "simpleMesh"]) {
      expect(draw, word).toContain(word);
    }
    expect(source(proto.setTexture)).toContain("simpleMesh");
  });

  it("still takes its models from state.models and applies attributes per model", () => {
    const layer = Layer.prototype as unknown as Record<string, (...args: never[]) => unknown>;
    expect(source(layer.getModels)).toContain("state.models");
    expect(source(layer.updateAttributes)).toContain("_setModelAttributes");
    expect(source(layer._setModelAttributes)).toContain("setAttributes");
    expect(source(layer._setModelAttributes)).toContain("setConstantAttributes");
  });

  it("still writes uniforms through the model's own store, which the fleet shares and silences", () => {
    expect(source(Model.prototype.setShaderInputs)).toContain(
      "this._uniformStore = new UniformStore",
    );
    expect(source(Model.prototype.setShaderInputs)).toContain("getManagedUniformBuffer");
    expect(source(Model.prototype.setShaderInputs)).toContain("Uniforms`");
    expect(source(Model.prototype.updateShaderInputs)).toContain("this._uniformStore.setUniforms");
    expect(source(Model.prototype.updateShaderInputs)).toContain("getUniformValues");
    expect(source(Model.prototype.destroy)).toContain("this._uniformStore.destroy");
  });

  it("still sets module props on each model's shader inputs, which the fleet does once for all", () => {
    const layer = Layer.prototype as unknown as Record<string, (...args: never[]) => unknown>;
    expect(source(layer.setShaderModuleProps)).toContain("shaderInputs.setProps");
    expect(source(layer.finalizeState)).toContain("model.destroy");
  });

  it("still keeps the shader inputs a model is given, as the same object", () => {
    expect(source(Model)).toContain("props.shaderInputs ||");
    expect(source(Model)).toContain("this.setShaderInputs(shaderInputs)");
  });

  it("still adds plugin modules to given shader inputs, which would change the shared ones", () => {
    expect(source(Model)).toContain("shaderInputs.addModules(");
    expect(source(Model)).toContain("resolvedPlugins.modules.length > 0");
  });

  it("still writes the uniforms of a draw only in predraw, through updateShaderInputs", () => {
    expect(source(Model.prototype.predraw)).toContain("this.updateShaderInputs(");
    expect(source(Model.prototype.draw)).toContain("this.predraw(");
  });

  it("still builds the uniform store from public fields, which the silent view inherits", () => {
    const store = source(UniformStore);
    expect(store).not.toContain("#uniformBlocks");
    expect(store).not.toContain("#uniformBuffers");
    expect(store).toContain("uniformBuffers = new Map()");
    expect(store).toContain("uniformBlocks = new Map()");
  });
});
