import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { type BuildResult, buildAll } from "../src/build.ts";
import { readCatalog } from "../src/catalog.ts";
import { buildBody } from "../src/geometry/car-body.ts";
import { LODS } from "../src/geometry/lod.ts";
import { writeGlb } from "../src/gltf.ts";
import { atlasPng, neutralRow } from "../src/palette.ts";
import { resolveCar } from "../src/spec.ts";
import { validateGlb } from "../src/validate.ts";

const catalog = readCatalog(resolve(import.meta.dirname, "../../../catalog"));

let built: BuildResult;
beforeAll(async () => {
  built = await buildAll(catalog);
});

describe("Khronos glTF validator", () => {
  it("reports no error on any shipping GLB", async () => {
    const failed: string[] = [];
    for (const [path, bytes] of built.files) {
      if (!path.endsWith(".glb")) continue;
      const report = await validateGlb(bytes, path);
      if (report.errors > 0) failed.push(`${path}: ${report.codes.join(", ")}`);
    }
    expect(failed).toEqual([]);
  });

  it("declares KHR_mesh_quantization as required for the quantized attributes", async () => {
    const path = [...built.files.keys()].find((p) => p.endsWith(".lod0.glb")) as string;
    const json = glbJson(built.files.get(path) as Uint8Array);
    expect(json.extensionsUsed).toContain("KHR_mesh_quantization");
    expect(json.extensionsRequired).toContain("KHR_mesh_quantization");
  });

  it("validates the accessor data of uncompressed files of every level of detail", async () => {
    const model = catalog.vehicles.find((m) => m.model_id === "db-423");
    const car = model?.car_types[0];
    if (!model || !car) throw new Error("db-423 missing from the catalogue");
    const spec = resolveCar(model, car);
    const png = atlasPng([neutralRow()]);
    for (const lod of LODS) {
      const file = await writeGlb(buildBody(spec, lod), png, "check", {}, { compress: false });
      const report = await validateGlb(file.glb, `db-423-end.lod${lod.level}.glb`);
      expect(report.codes.filter((c) => c.startsWith("E:"))).toEqual([]);
      expect(report.errors).toBe(0);
    }
  });

  it("embeds the model licence and its attribution", () => {
    const path = [...built.files.keys()].find((p) => p.endsWith(".lod2.glb")) as string;
    const json = glbJson(built.files.get(path) as Uint8Array);
    expect(json.asset.copyright).toMatch(/CC BY-SA 4\.0/);
    expect(json.asset.copyright).toMatch(/Wikipedia contributors/);
  });
});

function glbJson(glb: Uint8Array): {
  asset: { copyright?: string };
  extensionsUsed?: string[];
  extensionsRequired?: string[];
} {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const length = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + length)));
}
