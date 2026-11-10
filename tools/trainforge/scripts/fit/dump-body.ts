import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readCatalog } from "../../src/catalog.ts";
import { buildBody } from "../../src/geometry/car-body.ts";
import { LODS } from "../../src/geometry/lod.ts";
import { ATLAS_COLUMNS, SLOTS } from "../../src/palette.ts";
import { resolveCar } from "../../src/spec.ts";

/**
 * Writes one car body from the catalogue as a triangle list for fit_body.py: car frame x forward,
 * y left, z up, metres, one palette slot per triangle.
 * Usage: node scripts/fit/dump-body.ts <model_id> <car_type> <lod> <out.json> [catalog dir]
 */
const [modelId, carType, lodText, out, catalogDir] = process.argv.slice(2);
if (!modelId || !carType || !lodText || !out) {
  throw new Error("usage: dump-body.ts <model_id> <car_type> <lod> <out.json> [catalog dir]");
}
const catalog = readCatalog(catalogDir ?? join(import.meta.dirname, "../../../../catalog"));
const model = catalog.vehicles.find((v) => v.model_id === modelId);
const car = model?.car_types.find((c) => c.car_type === carType);
if (!model || !car) throw new Error(`no car ${carType} in ${modelId}`);
const spec = resolveCar(model, car);
const lod = LODS[Number(lodText)];
if (!lod) throw new Error(`no level of detail ${lodText}`);
const mesh = buildBody(spec, lod);
const slots: string[] = [];
for (let i = 0; i < mesh.uvs.length; i += 6) {
  const column = Math.floor((mesh.uvs[i] as number) * ATLAS_COLUMNS);
  slots.push(SLOTS[column] ?? "body");
}
writeFileSync(
  out,
  JSON.stringify({
    modelId,
    carType,
    lod: lod.level,
    length: spec.length,
    width: spec.width,
    height: spec.height,
    triangles: mesh.triangleCount,
    positions: mesh.positions.map((v) => Math.round(v * 1e4) / 1e4),
    slots,
  }),
);
