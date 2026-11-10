import type { Slot } from "../palette.ts";
import type { MeshBuilder, Vec3 } from "./mesh.ts";

/** Operator lettering along both sides of a cab end, between setbacks from the tip and heights. */
export interface FrontLettering {
  readonly text: string;
  /** Setback of the word's end nearest the tip, metres. */
  readonly from: number;
  /** Setback of the word's end furthest from the tip, metres. */
  readonly to: number;
  readonly bottom: number;
  readonly top: number;
  /** Lean of the letters: shift of their tops in the reading direction, per unit of height. */
  readonly italic: number;
  /** Setbacks between which the measured side stripe is left out, behind the letters. */
  readonly stripeGap: readonly [number, number] | null;
}

type Point2 = readonly [number, number];
type Quad2 = readonly [Point2, Point2, Point2, Point2];

interface Glyph {
  readonly width: number;
  readonly quads: readonly Quad2[];
}

/**
 * Block letters of the DB logotype in units of the cap height, x along the reading direction:
 * convex quads, counter-clockwise, upright (the lean is applied when placing them).
 */
const GLYPHS: Readonly<Record<string, Glyph>> = {
  I: {
    width: 0.25,
    quads: [
      [
        [0, 0],
        [0.25, 0],
        [0.25, 1],
        [0, 1],
      ],
    ],
  },
  C: {
    width: 0.8,
    quads: [
      [
        [0, 0.2],
        [0.24, 0.27],
        [0.24, 0.73],
        [0, 0.8],
      ],
      [
        [0.2, 0],
        [0.3, 0.21],
        [0.24, 0.27],
        [0, 0.2],
      ],
      [
        [0.2, 0],
        [0.8, 0],
        [0.8, 0.21],
        [0.3, 0.21],
      ],
      [
        [0, 0.8],
        [0.24, 0.73],
        [0.3, 0.79],
        [0.2, 1],
      ],
      [
        [0.3, 0.79],
        [0.8, 0.79],
        [0.8, 1],
        [0.2, 1],
      ],
    ],
  },
  E: {
    width: 0.68,
    quads: [
      [
        [0, 0],
        [0.24, 0],
        [0.24, 1],
        [0, 1],
      ],
      [
        [0.24, 0],
        [0.68, 0],
        [0.68, 0.2],
        [0.24, 0.2],
      ],
      [
        [0.24, 0.41],
        [0.6, 0.41],
        [0.6, 0.59],
        [0.24, 0.59],
      ],
      [
        [0.24, 0.8],
        [0.68, 0.8],
        [0.68, 1],
        [0.24, 1],
      ],
    ],
  },
};

/** Space between letters, in units of the cap height. */
const LETTER_GAP = 0.11;

/** The word's quads in cap-height units, letters leaning by `italic`, and its overall width. */
export function wordQuads(text: string, italic: number): { quads: Quad2[]; width: number } {
  const quads: Quad2[] = [];
  let cursor = 0;
  for (const [i, ch] of [...text].entries()) {
    const glyph = GLYPHS[ch];
    if (!glyph) throw new Error(`lettering has no glyph for ${JSON.stringify(ch)}`);
    if (i > 0) cursor += LETTER_GAP;
    const at = cursor;
    for (const q of glyph.quads)
      quads.push(q.map(([x, v]) => [at + x + italic * v, v] as const) as unknown as Quad2);
    cursor += glyph.width;
  }
  return { quads, width: cursor + italic };
}

/**
 * Where a point of the word lands on one side: setback and height. The word reads left to right
 * from outside, so on the left side (y > 0) it runs back from the tip and on the right side
 * towards it.
 */
export function letterPlace(l: FrontLettering, side: 1 | -1, width: number) {
  const k = (l.to - l.from) / width;
  return ([u, v]: Point2): Point2 => [
    side === 1 ? l.from + u * k : l.to - u * k,
    l.bottom + v * (l.top - l.bottom),
  ];
}

/** Height of a row of a letter quad, metres: rows follow the curved section between them. */
const ROW_HEIGHT = 0.16;

/** Draws the lettering on both sides in the given slot, on points already lifted off the surface. */
export function emitLettering(
  mesh: MeshBuilder,
  l: FrontLettering,
  point: (side: 1 | -1, setback: number, z: number) => Vec3,
  slot: Slot,
) {
  const { quads, width } = wordQuads(l.text, l.italic);
  const rows = Math.max(1, Math.ceil((l.top - l.bottom) / ROW_HEIGHT));
  for (const side of [1, -1] as const) {
    const place = letterPlace(l, side, width);
    const at = (p: Point2): Vec3 => {
      const [s, z] = place(p);
      return point(side, s, z);
    };
    for (const [a, b, c, d] of quads) {
      const lerp = (p: Point2, q: Point2, t: number): Point2 => [
        p[0] + (q[0] - p[0]) * t,
        p[1] + (q[1] - p[1]) * t,
      ];
      const spanRows = Math.max(1, Math.round(rows * Math.abs(d[1] - a[1])));
      for (let r = 0; r < spanRows; r++) {
        const t0 = r / spanRows;
        const t1 = (r + 1) / spanRows;
        mesh.facingQuad(
          [at(lerp(a, d, t0)), at(lerp(b, c, t0)), at(lerp(b, c, t1)), at(lerp(a, d, t1))],
          [0, side, 0],
          slot,
        );
      }
    }
  }
}

/** The pieces of a measured [setback, bottom, top] stripe outside a gap, cut where they cross it. */
export function stripeOutside(
  curve: readonly (readonly [number, number, number])[],
  gap: readonly [number, number],
): (readonly [number, number, number])[][] {
  const sorted = [...curve].sort((p, q) => p[0] - q[0]);
  const at = (s: number): readonly [number, number, number] => {
    for (let i = 0; i < sorted.length - 1; i++) {
      const p = sorted[i] as readonly [number, number, number];
      const q = sorted[i + 1] as readonly [number, number, number];
      if (s >= p[0] && s <= q[0]) {
        const t = q[0] - p[0] > 0 ? (s - p[0]) / (q[0] - p[0]) : 0;
        return [s, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
      }
    }
    return sorted[s < (sorted[0]?.[0] ?? 0) ? 0 : sorted.length - 1] as readonly [
      number,
      number,
      number,
    ];
  };
  const [g0, g1] = gap;
  const first = sorted[0]?.[0] ?? 0;
  const last = sorted[sorted.length - 1]?.[0] ?? 0;
  const front = [...sorted.filter((p) => p[0] < g0), ...(g0 > first && g0 < last ? [at(g0)] : [])];
  const rear = [...(g1 > first && g1 < last ? [at(g1)] : []), ...sorted.filter((p) => p[0] > g1)];
  return [front, rear].filter((piece) => piece.length >= 2);
}
