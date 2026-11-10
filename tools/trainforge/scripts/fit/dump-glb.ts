import { readFileSync, writeFileSync } from "node:fs";
import { type Mesh, NodeIO } from "@gltf-transform/core";
import { EXTMeshoptCompression, KHRMeshQuantization } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";

/** Triangle corners of one mesh in the car frame (x forward, y left, z up), nine values each. */
function corners(mesh: Mesh, out: number[]) {
  const p = [0, 0, 0];
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute("POSITION");
    if (!pos) continue;
    const idx = prim.getIndices();
    const count = idx ? idx.getCount() : pos.getCount();
    for (let i = 0; i < count; i++) {
      pos.getElement(idx ? idx.getScalar(i) : i, p);
      out.push(p[0] as number, -(p[2] as number), p[1] as number);
    }
  }
}

/**
 * Writes the triangles of one car body GLB as float32 values for the silhouette fit in fit_glb.py.
 * usage: node scripts/fit/dump-glb.ts <body.glb> <out.f32>
 */
async function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error("usage: dump-glb.ts <body.glb> <out.f32>");
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
    .registerDependencies({ "meshopt.decoder": MeshoptDecoder });
  const doc = await io.readBinary(new Uint8Array(readFileSync(input)));
  const out: number[] = [];
  for (const mesh of doc.getRoot().listMeshes()) corners(mesh, out);
  writeFileSync(output, new Float32Array(out));
  process.stdout.write(`${out.length / 9} triangles\n`);
}

await main();
