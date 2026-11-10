import { existsSync, readFileSync } from "node:fs";
import { MeshoptDecoder } from "meshoptimizer/decoder";
import { describe, expect, it } from "vitest";
import { readCarMesh } from "./glb.ts";

function pad4(bytes: Uint8Array, fill: number): Uint8Array {
  const out = new Uint8Array(Math.ceil(bytes.length / 4) * 4).fill(fill);
  out.set(bytes);
  return out;
}

/** One triangle: float positions, int8 normalized normals, uint16 normalized UVs, uint16 indices. */
function triangleGlb(): ArrayBuffer {
  const positions = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const normals = new Int8Array([0, 127, 0, 0, 0, 0, 127, 0, 127, 0, 0, 0]);
  const uvs = new Uint16Array([0, 65535, 65535, 32768, 0, 0]);
  const indices = new Uint16Array([0, 1, 2, 0]);
  const parts = [positions, normals, uvs, indices].map((array) =>
    pad4(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), 0),
  );
  const offsets: number[] = [];
  let total = 0;
  for (const part of parts) {
    offsets.push(total);
    total += part.length;
  }
  const bin = new Uint8Array(total);
  parts.forEach((part, i) => {
    bin.set(part, offsets[i]);
  });
  const json = {
    asset: { version: "2.0" },
    buffers: [{ byteLength: total }],
    bufferViews: parts.map((part, i) => ({
      buffer: 0,
      byteOffset: offsets[i],
      byteLength: part.length,
      ...(i === 1 ? { byteStride: 4 } : {}),
    })),
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 1, componentType: 5120, count: 3, type: "VEC3", normalized: true },
      { bufferView: 2, componentType: 5123, count: 3, type: "VEC2", normalized: true },
      { bufferView: 3, componentType: 5123, count: 3, type: "SCALAR" },
    ],
    meshes: [
      { primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3 }] },
    ],
  };
  const jsonBytes = pad4(new TextEncoder().encode(JSON.stringify(json)), 0x20);
  const length = 12 + 8 + jsonBytes.length + 8 + bin.length;
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, length, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  view.setUint32(20 + jsonBytes.length, bin.length, true);
  view.setUint32(24 + jsonBytes.length, 0x004e4942, true);
  out.set(bin, 28 + jsonBytes.length);
  return out.buffer;
}

describe("readCarMesh", () => {
  it("turns glTF y up into deck.gl z up and dequantizes normals and UVs", () => {
    const mesh = readCarMesh(triangleGlb());
    expect([...mesh.positions]).toEqual([1, -3, 2, 4, -6, 5, 7, -9, 8]);
    expect([...mesh.normals]).toEqual([0, -0, 1, 0, -1, 0, 1, -0, 0]);
    expect(mesh.texCoords[1]).toBe(1);
    expect(mesh.texCoords[3]).toBeCloseTo(0.5, 4);
    expect([...mesh.indices]).toEqual([0, 1, 2]);
  });

  it("rejects a file that is not a GLB", () => {
    expect(() => readCarMesh(new ArrayBuffer(16))).toThrow(/GLB/);
  });

  const forgeFile = new URL(
    "../../../../tools/trainforge/dist/models/generic-hsr/end.lod2.glb",
    import.meta.url,
  );
  it.skipIf(!existsSync(forgeFile))(
    "reads a meshopt-compressed forge car (needs a forge build)",
    async () => {
      await MeshoptDecoder.ready;
      const bytes = readFileSync(forgeFile);
      const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const mesh = readCarMesh(data, MeshoptDecoder.decodeGltfBuffer);
      const count = mesh.positions.length / 3;
      expect(count).toBeGreaterThan(100);
      let maxUp = 0;
      let maxSide = 0;
      for (let i = 0; i < count; i++) {
        maxSide = Math.max(maxSide, Math.abs(mesh.positions[3 * i + 1] as number));
        maxUp = Math.max(maxUp, mesh.positions[3 * i + 2] as number);
        const n = Math.hypot(
          mesh.normals[3 * i] as number,
          mesh.normals[3 * i + 1] as number,
          mesh.normals[3 * i + 2] as number,
        );
        expect(n).toBeGreaterThan(0.97);
        expect(n).toBeLessThan(1.03);
      }
      expect(maxUp).toBeCloseTo(3.89, 2);
      expect(maxSide).toBeCloseTo(1.475, 2);
      expect(Math.max(...mesh.indices)).toBeLessThan(count);
    },
  );
});
