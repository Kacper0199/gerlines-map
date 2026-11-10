import { ROW_V, type Slot, slotU } from "../palette.ts";

/** Car frame: x forward, y to the left, z up, metres, origin at the car centre on top of rail. */
export type Vec3 = readonly [number, number, number];

export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
}

const DEGENERATE_AREA = 1e-9;

/**
 * Triangle soup with explicit normals and one palette slot per face. Faces keep their own
 * vertices; gltf-transform's weld merges equal ones afterwards.
 */
export class MeshBuilder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly uvs: number[] = [];

  get triangleCount(): number {
    return this.positions.length / 9;
  }

  /** Adds triangle a, b, c (counter-clockwise seen from outside); returns false for a degenerate one. */
  triangle(a: Vec3, b: Vec3, c: Vec3, slot: Slot, normals?: readonly [Vec3, Vec3, Vec3]): boolean {
    const face = cross(sub(b, a), sub(c, a));
    if (length(face) < DEGENERATE_AREA) return false;
    const flat = normalize(face);
    const u = slotU(slot);
    [a, b, c].forEach((p, i) => {
      this.positions.push(p[0], p[1], p[2]);
      const n = normals?.[i] ?? flat;
      this.normals.push(n[0], n[1], n[2]);
      this.uvs.push(u, ROW_V);
    });
    return true;
  }

  /** Adds quad a, b, c, d (counter-clockwise seen from outside) as two triangles. */
  quad(
    a: Vec3,
    b: Vec3,
    c: Vec3,
    d: Vec3,
    slot: Slot,
    normals?: readonly [Vec3, Vec3, Vec3, Vec3],
  ) {
    this.triangle(a, b, c, slot, normals && [normals[0], normals[1], normals[2]]);
    this.triangle(a, c, d, slot, normals && [normals[0], normals[2], normals[3]]);
  }

  /** Adds quad a, b, c, d wound so that its face points along `facing`. */
  facingQuad(
    q: readonly [Vec3, Vec3, Vec3, Vec3],
    facing: Vec3,
    slot: Slot,
    normals?: readonly [Vec3, Vec3, Vec3, Vec3],
  ) {
    const [a, b, c, d] = q;
    const n = cross(sub(b, a), sub(c, a));
    if (n[0] * facing[0] + n[1] * facing[1] + n[2] * facing[2] >= 0)
      this.quad(a, b, c, d, slot, normals);
    else this.quad(a, d, c, b, slot, normals && [normals[0], normals[3], normals[2], normals[1]]);
  }

  /** Axis-aligned box from min to max corner, flat shaded; `skip` omits faces by name. */
  box(min: Vec3, max: Vec3, slot: Slot, skip: readonly ("top" | "bottom")[] = []): void {
    const [x0, y0, z0] = min;
    const [x1, y1, z1] = max;
    const p = (x: number, y: number, z: number): Vec3 => [x, y, z];
    this.quad(p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), p(x1, y0, z1), slot);
    this.quad(p(x0, y1, z0), p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1), slot);
    this.quad(p(x0, y1, z0), p(x0, y1, z1), p(x1, y1, z1), p(x1, y1, z0), slot);
    this.quad(p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1), slot);
    if (!skip.includes("top"))
      this.quad(p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1), slot);
    if (!skip.includes("bottom")) {
      this.quad(p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0), p(x1, y0, z0), slot);
    }
  }

  /** Cylinder along the y axis (a wheel) with `segments` sides and both caps. */
  wheel(
    centre: Vec3,
    radius: number,
    width: number,
    segments: number,
    slot: Slot,
    outerOnly = false,
  ): void {
    const [cx, cy, cz] = centre;
    const ring = (y: number): Vec3[] =>
      Array.from({ length: segments }, (_, i) => {
        const a = (2 * Math.PI * i) / segments;
        return [cx + radius * Math.cos(a), y, cz + radius * Math.sin(a)] as Vec3;
      });
    const left = ring(cy + width / 2);
    const right = ring(cy - width / 2);
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      this.quad(right[i] as Vec3, left[i] as Vec3, left[j] as Vec3, right[j] as Vec3, slot);
    }
    const outward = cy >= 0 ? "left" : "right";
    for (let i = 1; i < segments - 1; i++) {
      if (!outerOnly || outward === "left")
        this.triangle(left[0] as Vec3, left[i + 1] as Vec3, left[i] as Vec3, slot);
      if (!outerOnly || outward === "right")
        this.triangle(right[0] as Vec3, right[i] as Vec3, right[i + 1] as Vec3, slot);
    }
  }

  append(other: MeshBuilder): void {
    this.positions.push(...other.positions);
    this.normals.push(...other.normals);
    this.uvs.push(...other.uvs);
  }

  /** Appends `other` mirrored at the plane x = 0, keeping every face facing outwards. */
  appendMirroredX(other: MeshBuilder): void {
    const p = other.positions;
    const n = other.normals;
    const uv = other.uvs;
    for (let t = 0; t < p.length / 9; t++) {
      for (const v of [0, 2, 1]) {
        const i = t * 9 + v * 3;
        this.positions.push(-(p[i] as number), p[i + 1] as number, p[i + 2] as number);
        this.normals.push(-(n[i] as number), n[i + 1] as number, n[i + 2] as number);
        const k = t * 6 + v * 2;
        this.uvs.push(uv[k] as number, uv[k + 1] as number);
      }
    }
  }
}
