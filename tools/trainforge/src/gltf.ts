import { Document, type GLTF, Logger, NodeIO } from "@gltf-transform/core";
import { EXTMeshoptCompression, KHRMeshQuantization } from "@gltf-transform/extensions";
import { quantize, reorder, weld } from "@gltf-transform/functions";
import { MeshoptEncoder } from "meshoptimizer";
import type { MeshBuilder } from "./geometry/mesh.ts";

export interface GlbFile {
  /** Shipping file: welded, normals and UVs quantized (KHR_mesh_quantization), EXT_meshopt_compression. */
  readonly glb: Uint8Array;
  /** The same welded mesh without quantization or compression, for the size report. */
  readonly rawBytes: number;
  readonly triangles: number;
  readonly vertices: number;
}

export interface GlbOptions {
  /** EXT_meshopt_compression on the buffers; off only to validate accessor data. */
  readonly compress?: boolean;
}

/** Licence of every generated model, embedded in the asset. */
export const MODEL_COPYRIGHT =
  "CC BY-SA 4.0, GerLines contributors, dimensions from Wikipedia contributors (CC BY-SA 4.0), Wikidata (CC0) and measured Wikimedia Commons photos";

const NEAREST = 9728;
const CLAMP_TO_EDGE = 33071;

/** Car frame (x forward, y left, z up) to glTF (x forward, y up, z right). */
function toGltf(values: readonly number[]): Float32Array<ArrayBuffer> {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 3) {
    out[i] = values[i] as number;
    out[i + 1] = values[i + 2] as number;
    out[i + 2] = -(values[i + 1] as number);
  }
  return out;
}

let ioPromise: Promise<NodeIO> | undefined;

function io(): Promise<NodeIO> {
  ioPromise ??= MeshoptEncoder.ready.then(() =>
    new NodeIO()
      .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
      .registerDependencies({ "meshopt.encoder": MeshoptEncoder }),
  );
  return ioPromise;
}

function buildDocument(
  mesh: MeshBuilder,
  palettePng: Uint8Array,
  name: string,
  extras: object,
): Document {
  const doc = new Document().setLogger(new Logger(Logger.Verbosity.SILENT));
  const asset = doc.getRoot().getAsset();
  asset.generator = "GerLines trainforge";
  asset.copyright = MODEL_COPYRIGHT;
  const buffer = doc.createBuffer();
  const accessor = (array: Float32Array<ArrayBuffer>, type: "VEC2" | "VEC3") =>
    doc.createAccessor().setBuffer(buffer).setType(type).setArray(array);
  const texture = doc.createTexture("palette").setImage(palettePng).setMimeType("image/png");
  const material = doc
    .createMaterial("palette")
    .setBaseColorTexture(texture)
    .setMetallicFactor(0)
    .setRoughnessFactor(0.8);
  material
    .getBaseColorTextureInfo()
    ?.setMagFilter(NEAREST as GLTF.TextureMagFilter)
    .setMinFilter(NEAREST as GLTF.TextureMinFilter)
    .setWrapS(CLAMP_TO_EDGE as GLTF.TextureWrapMode)
    .setWrapT(CLAMP_TO_EDGE as GLTF.TextureWrapMode);
  const primitive = doc
    .createPrimitive()
    .setAttribute("POSITION", accessor(toGltf(mesh.positions), "VEC3"))
    .setAttribute("NORMAL", accessor(toGltf(mesh.normals), "VEC3"))
    .setAttribute("TEXCOORD_0", accessor(Float32Array.from(mesh.uvs), "VEC2"))
    .setMaterial(material);
  const node = doc
    .createNode(name)
    .setMesh(doc.createMesh(name).addPrimitive(primitive))
    .setExtras(extras as Record<string, unknown>);
  doc.getRoot().setDefaultScene(doc.createScene(name).addChild(node));
  return doc;
}

/** Writes one mesh as a GLB with a palette texture; same input, same bytes. */
export async function writeGlb(
  mesh: MeshBuilder,
  palettePng: Uint8Array,
  name: string,
  extras: object,
  options: GlbOptions = {},
): Promise<GlbFile> {
  const writer = await io();
  const doc = buildDocument(mesh, palettePng, name, extras);
  await doc.transform(weld());
  const primitive = doc.getRoot().listMeshes()[0]?.listPrimitives()[0];
  const vertices = primitive?.getAttribute("POSITION")?.getCount() ?? 0;
  const triangles = (primitive?.getIndices()?.getCount() ?? 0) / 3;
  const rawBytes = (await writer.writeBinary(doc)).byteLength;
  await doc.transform(
    reorder({ encoder: MeshoptEncoder, target: "size" }),
    quantize({ pattern: /^(NORMAL|TEXCOORD_0)$/, quantizeNormal: 8, quantizeTexcoord: 12 }),
  );
  doc.createExtension(KHRMeshQuantization).setRequired(true);
  if (options.compress ?? true) {
    doc
      .createExtension(EXTMeshoptCompression)
      .setRequired(true)
      .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  }
  const glb = await writer.writeBinary(doc);
  return { glb, rawBytes, triangles, vertices };
}
