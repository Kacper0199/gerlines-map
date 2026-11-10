/** A triangle mesh in deck.gl's axes: +x forward, +y left, +z up, metres; normals and UVs as floats. */
export interface CarMesh {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly texCoords: Float32Array;
  readonly indices: Uint32Array;
}

/** Decodes one EXT_meshopt_compression buffer view (meshoptimizer's decodeGltfBuffer). */
export type MeshoptDecode = (
  target: Uint8Array,
  count: number,
  size: number,
  source: Uint8Array,
  mode: string,
  filter?: string,
) => void;

interface Accessor {
  readonly bufferView: number;
  readonly byteOffset?: number;
  readonly componentType: number;
  readonly count: number;
  readonly type: string;
  readonly normalized?: boolean;
}

interface MeshoptView {
  readonly buffer: number;
  readonly byteOffset?: number;
  readonly byteLength: number;
  readonly byteStride: number;
  readonly count: number;
  readonly mode: string;
  readonly filter?: string;
}

interface BufferView {
  readonly buffer: number;
  readonly byteOffset?: number;
  readonly byteLength: number;
  readonly byteStride?: number;
  readonly extensions?: { readonly EXT_meshopt_compression?: MeshoptView };
}

interface Gltf {
  readonly accessors: readonly Accessor[];
  readonly bufferViews: readonly BufferView[];
  readonly meshes: readonly {
    readonly primitives: readonly {
      readonly attributes: Readonly<Record<string, number>>;
      readonly indices?: number;
    }[];
  }[];
}

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const COMPONENTS: Readonly<Record<string, number>> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const BYTES: Readonly<Record<number, number>> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};

function chunks(data: ArrayBuffer): { json: Gltf; bin: Uint8Array } {
  const view = new DataView(data);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error("not a GLB file");
  let offset = 12;
  let json: Gltf | undefined;
  let bin: Uint8Array | undefined;
  while (offset + 8 <= data.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const body = new Uint8Array(data, offset + 8, length);
    if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(body)) as Gltf;
    if (type === CHUNK_BIN) bin = body;
    offset += 8 + length;
  }
  if (!(json && bin)) throw new Error("GLB without JSON or binary chunk");
  return { json, bin };
}

function viewBytes(
  json: Gltf,
  bin: Uint8Array,
  index: number,
  decode: MeshoptDecode | undefined,
): { bytes: Uint8Array; stride: number | undefined } {
  const view = json.bufferViews[index] as BufferView;
  const meshopt = view.extensions?.EXT_meshopt_compression;
  if (meshopt) {
    if (!decode) throw new Error("meshopt-compressed GLB needs a decoder");
    const target = new Uint8Array(meshopt.count * meshopt.byteStride);
    const source = bin.subarray(
      meshopt.byteOffset ?? 0,
      (meshopt.byteOffset ?? 0) + meshopt.byteLength,
    );
    decode(target, meshopt.count, meshopt.byteStride, source, meshopt.mode, meshopt.filter);
    return { bytes: target, stride: meshopt.byteStride };
  }
  const start = view.byteOffset ?? 0;
  return { bytes: bin.subarray(start, start + view.byteLength), stride: view.byteStride };
}

function readComponent(view: DataView, offset: number, type: number, normalized: boolean): number {
  switch (type) {
    case 5126:
      return view.getFloat32(offset, true);
    case 5120:
      return normalized ? Math.max(view.getInt8(offset) / 127, -1) : view.getInt8(offset);
    case 5121:
      return normalized ? view.getUint8(offset) / 255 : view.getUint8(offset);
    case 5122:
      return normalized
        ? Math.max(view.getInt16(offset, true) / 32767, -1)
        : view.getInt16(offset, true);
    case 5123:
      return normalized ? view.getUint16(offset, true) / 65535 : view.getUint16(offset, true);
    case 5125:
      return view.getUint32(offset, true);
    default:
      throw new Error(`component type ${type}`);
  }
}

function readAccessor(
  json: Gltf,
  bin: Uint8Array,
  index: number,
  decode?: MeshoptDecode,
): Float64Array {
  const accessor = json.accessors[index] as Accessor;
  const components = COMPONENTS[accessor.type] ?? 0;
  const size = BYTES[accessor.componentType] ?? 0;
  const { bytes, stride } = viewBytes(json, bin, accessor.bufferView, decode);
  const step = stride ?? components * size;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float64Array(accessor.count * components);
  const base = accessor.byteOffset ?? 0;
  for (let i = 0; i < accessor.count; i++) {
    for (let c = 0; c < components; c++) {
      out[i * components + c] = readComponent(
        view,
        base + i * step + c * size,
        accessor.componentType,
        accessor.normalized ?? false,
      );
    }
  }
  return out;
}

/** glTF (+x forward, +y up, +z right) to deck.gl (+x forward, +y left, +z up): (x, -z, y). */
function toDeckAxes(values: Float64Array): Float32Array {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 3) {
    out[i] = values[i] as number;
    out[i + 1] = -(values[i + 2] as number);
    out[i + 2] = values[i + 1] as number;
  }
  return out;
}

/** Reads the single primitive of a forge GLB into a deck.gl mesh. */
export function readCarMesh(data: ArrayBuffer, decode?: MeshoptDecode): CarMesh {
  const { json, bin } = chunks(data);
  const primitive = json.meshes[0]?.primitives[0];
  if (!primitive) throw new Error("GLB without a primitive");
  const { POSITION, NORMAL, TEXCOORD_0 } = primitive.attributes;
  if (POSITION === undefined || NORMAL === undefined || TEXCOORD_0 === undefined) {
    throw new Error("GLB primitive needs positions, normals and UVs");
  }
  const positions = toDeckAxes(readAccessor(json, bin, POSITION, decode));
  const normals = toDeckAxes(readAccessor(json, bin, NORMAL, decode));
  const texCoords = Float32Array.from(readAccessor(json, bin, TEXCOORD_0, decode));
  const indices =
    primitive.indices === undefined
      ? Uint32Array.from({ length: positions.length / 3 }, (_, i) => i)
      : Uint32Array.from(readAccessor(json, bin, primitive.indices, decode));
  return { positions, normals, texCoords, indices };
}
