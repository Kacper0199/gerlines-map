import type { Slot } from "../palette.ts";
import { add, cross, type MeshBuilder, normalize, sub, type Vec3 } from "./mesh.ts";

/**
 * A lofted surface: rows are stations along the car, each a ring of the same number of points.
 * Rows must run towards +x and every ring must go from the roof centre over the left side (+y)
 * and the bottom to the right side; then faces point outwards.
 */
export interface Grid {
  readonly rows: readonly (readonly Vec3[])[];
  readonly closed: boolean;
  readonly creaseColumns?: ReadonlySet<number>;
  readonly creaseRows?: ReadonlySet<number>;
}

/** Slot of the face between rows r, r + 1 and columns c, c + 1, or null to leave it out. */
export type FaceSlot = (row: number, column: number) => Slot | null;

function bandIndex(
  index: number,
  creases: ReadonlySet<number> | undefined,
  wraps: boolean,
): number {
  let band = 0;
  for (const crease of creases ?? []) if (crease <= index) band++;
  return wraps && creases && band === creases.size && !creases.has(0) ? 0 : band;
}

export function emitGrid(mesh: MeshBuilder, grid: Grid, slotOf: FaceSlot): number {
  const { rows, closed } = grid;
  const rowCount = rows.length;
  const columns = rows[0]?.length ?? 0;
  const faceColumns = closed ? columns : columns - 1;
  const point = (r: number, c: number): Vec3 => rows[r]?.[(c + columns) % columns] as Vec3;
  const faceNormal = (r: number, c: number): Vec3 =>
    cross(sub(point(r + 1, c + 1), point(r, c)), sub(point(r, c + 1), point(r + 1, c)));
  const patch = (r: number, c: number) =>
    `${bandIndex(r, grid.creaseRows, false)}:${bandIndex((c + columns) % columns, grid.creaseColumns, closed)}`;
  const validFace = (r: number, c: number) =>
    r >= 0 && r < rowCount - 1 && (closed || (c >= 0 && c < faceColumns));

  const vertexNormal = (r: number, c: number, fr: number, fc: number): Vec3 => {
    const own = patch(fr, fc);
    let sum: Vec3 = [0, 0, 0];
    for (const [dr, dc] of [
      [-1, -1],
      [-1, 0],
      [0, -1],
      [0, 0],
    ] as const) {
      const ar = r + dr;
      const ac = closed ? (c + dc + faceColumns) % faceColumns : c + dc;
      if (validFace(ar, ac) && patch(ar, ac) === own) sum = add(sum, faceNormal(ar, ac));
    }
    return normalize(sum);
  };

  let faces = 0;
  for (let r = 0; r < rowCount - 1; r++) {
    for (let c = 0; c < faceColumns; c++) {
      const slot = slotOf(r, c);
      if (!slot) continue;
      const corners: [number, number][] = [
        [r, c],
        [r + 1, c],
        [r + 1, c + 1],
        [r, c + 1],
      ];
      const [a, b, cc, d] = corners.map(([vr, vc]) => point(vr, vc)) as [Vec3, Vec3, Vec3, Vec3];
      const [na, nb, nc, nd] = corners.map(([vr, vc]) => vertexNormal(vr, vc, r, c)) as [
        Vec3,
        Vec3,
        Vec3,
        Vec3,
      ];
      mesh.quad(a, b, cc, d, slot, [na, nb, nc, nd]);
      faces++;
    }
  }
  return faces;
}
