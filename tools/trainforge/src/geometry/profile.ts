import { detPow } from "./det-math.ts";

/** A point of the car cross-section: lateral y (left positive) and height z above top of rail. */
export interface SectionPoint {
  readonly y: number;
  readonly z: number;
}

export interface SectionParams {
  readonly halfWidth: number;
  /** Roof top above top of rail. */
  readonly height: number;
  /** Where the roof shoulder meets the straight side wall. */
  readonly eave: number;
  /** Lower end of the straight side wall. */
  readonly sideBottom: number;
  /** Underside of the body. */
  readonly bottom: number;
  /** How far the lower edge of the body sits inside the side wall. */
  readonly tuck: number;
  /** Superellipse exponent of the roof shoulder: 2 is elliptic, higher is squarer. */
  readonly roofExponent: number;
  readonly roofSegments: number;
  readonly lowerSegments: number;
  /** How far the top of the side wall sits inside the full width (side tumblehome). */
  readonly tumblehome?: number;
}

function eaveHalfWidth(p: SectionParams): number {
  return p.halfWidth - (p.tumblehome ?? 0);
}

/** Roof from the centre (0, height) to the eave (halfWidth, eave), both included. */
export function roofArc(p: SectionParams): SectionPoint[] {
  const e = 2 / p.roofExponent;
  const w = eaveHalfWidth(p);
  return Array.from({ length: p.roofSegments + 1 }, (_, i) => {
    if (i === 0) return { y: 0, z: p.height };
    if (i === p.roofSegments) return { y: w, z: p.eave };
    const theta = (Math.PI / 2) * (i / p.roofSegments);
    return {
      y: w * detPow(Math.sin(theta), e),
      z: p.eave + (p.height - p.eave) * detPow(Math.cos(theta), e),
    };
  });
}

/** Lower side from the wall bottom (halfWidth, sideBottom) to the bottom edge, then to the centre. */
export function lowerArc(p: SectionParams): SectionPoint[] {
  const points: SectionPoint[] = [];
  for (let i = 0; i <= p.lowerSegments; i++) {
    const t = i / p.lowerSegments;
    const angle = (Math.PI / 2) * t;
    points.push({
      y: p.halfWidth - p.tuck * (1 - Math.cos(angle)),
      z: p.sideBottom - (p.sideBottom - p.bottom) * Math.sin(angle),
    });
  }
  points.push({ y: 0, z: p.bottom });
  return points;
}

/** Height of the roof polygon at lateral position y (0 to halfWidth). */
export function roofZAt(p: SectionParams, y: number): number {
  const arc = roofArc(p);
  for (let i = 0; i < arc.length - 1; i++) {
    const a = arc[i] as SectionPoint;
    const b = arc[i + 1] as SectionPoint;
    if (y >= a.y && y <= b.y)
      return b.y === a.y ? a.z : a.z + ((y - a.y) / (b.y - a.y)) * (b.z - a.z);
  }
  return p.eave;
}

export interface Ring {
  readonly points: readonly SectionPoint[];
  /** Columns where the surface has a hard edge. */
  readonly creases: ReadonlySet<number>;
  /** Column range (inclusive) of the straight left wall, from its top to its bottom. */
  readonly leftWall: readonly [number, number];
  readonly rightWall: readonly [number, number];
  /** Index of the bottom edge point of the left half, where the lower arc meets the underside. */
  readonly leftEdge: number;
}

const EPS = 1e-6;

/** Inserts a point at every requested height strictly between two neighbours of the half ring. */
function insertLevels(half: readonly SectionPoint[], levels: readonly number[]): SectionPoint[] {
  const out = [...half];
  for (const z of [...new Set(levels)]) {
    for (let i = 0; i < out.length - 1; i++) {
      const a = out[i] as SectionPoint;
      const b = out[i + 1] as SectionPoint;
      if (a.z > z + EPS && b.z < z - EPS) {
        const t = (a.z - z) / (a.z - b.z);
        out.splice(i + 1, 0, { y: a.y + t * (b.y - a.y), z });
        break;
      }
    }
  }
  return out;
}

/**
 * The closed cross-section: roof centre, left roof, left wall, left lower side, bottom centre, then
 * the mirror image back up the right side. Every requested level becomes a point on the left half
 * (on the wall, the roof or the lower side, interpolated along the polygon) and its mirror image.
 */
export function fullRing(p: SectionParams, levels: readonly number[] = []): Ring {
  const lower = lowerArc(p);
  const outline = [...roofArc(p), ...lower.slice(0, -1)];
  const left = [
    ...insertLevels(
      outline,
      levels.filter((z) => z < p.height - EPS && z > p.bottom + EPS),
    ),
    lower[lower.length - 1] as SectionPoint,
  ];
  const bottomIndex = left.length - 1;
  const right = left
    .slice(1, bottomIndex)
    .reverse()
    .map((q) => ({ y: -q.y, z: q.z }));
  const points = [...left, ...right];
  const find = (y: number, z: number) =>
    left.findIndex((q) => Math.abs(q.y - y) < EPS && Math.abs(q.z - z) < EPS);
  const wallTop = find(eaveHalfWidth(p), p.eave);
  const wallBottom = find(p.halfWidth, p.sideBottom);
  const edgeLeft = bottomIndex - 1;
  const edgeRight = points.length - edgeLeft;
  return {
    points,
    creases: new Set([edgeLeft, edgeRight]),
    leftWall: [wallTop, wallBottom],
    rightWall: [points.length - wallBottom, points.length - wallTop],
    leftEdge: edgeLeft,
  };
}

/** Arc-length position of every ring point from the roof centre (0) to the bottom centre (1). */
export function ringParameter(points: readonly SectionPoint[]): number[] {
  const half = Math.floor(points.length / 2);
  const cumulative = [0];
  for (let i = 1; i <= half; i++) {
    const a = points[i - 1] as SectionPoint;
    const b = points[i] as SectionPoint;
    cumulative.push((cumulative[i - 1] as number) + Math.hypot(b.y - a.y, b.z - a.z));
  }
  const total = cumulative[half] || 1;
  return points.map((_, i) => (cumulative[i <= half ? i : points.length - i] as number) / total);
}
