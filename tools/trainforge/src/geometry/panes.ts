import { COMBINED_TAIL_U, type Slot, slotU } from "../palette.ts";
import { detPow } from "./det-math.ts";
import type { FrontDecal, FrontSpec } from "./front.ts";
import { add, cross, type MeshBuilder, normalize, scale, sub, type Vec3 } from "./mesh.ts";

const EPS = 1e-6;
/** Distance of the windscreen pane off the facets (its chords sag across the folds); decals sit on top of it. */
export const PANE_LIFT = 0.025;
const DECAL_STEP = 0.01;
/**
 * Distance of a panel seam off the facets: small enough that a hairline at a grazing view stays
 * inside the outline, under every pane; its rows and columns every few centimetres keep its chords
 * on the facets.
 */
export const SEAM_LIFT = 0.006;
const SEAM_STEP = 0.04;

/** A point on the emitted facets of the front at lateral fraction u and height z, with the facet's outward normal. */
export type Facets = (u: number, z: number) => { readonly point: Vec3; readonly normal: Vec3 };

function weighted(terms: readonly (readonly [Vec3, number])[]): Vec3 {
  return terms.reduce<Vec3>((sum, [p, w]) => add(sum, scale(p, w)), [0, 0, 0]);
}

/**
 * The front as emitted: rows at descending heights `levels`, columns at lateral fractions `us`,
 * each quad split as MeshBuilder.quad splits it, so a point lies on the drawn triangles.
 */
export function facetSurface(
  levels: readonly number[],
  rows: readonly (readonly Vec3[])[],
  us: readonly number[],
  inside: Vec3,
): Facets {
  const n = levels.length;
  return (u, z) => {
    let r = 0;
    while (r < n - 2 && z < (levels[r + 1] as number) - EPS) r++;
    const z1 = levels[r] as number;
    const z0 = levels[r + 1] as number;
    const t = Math.min(1, Math.max(0, z1 - z0 < EPS ? 0 : (z1 - z) / (z1 - z0)));
    let c = 0;
    while (c < us.length - 2 && u > (us[c + 1] as number)) c++;
    const ua = us[c] as number;
    const ub = us[c + 1] as number;
    const s = Math.min(1, Math.max(0, (u - ua) / Math.max(EPS, ub - ua)));
    const a = rows[r]?.[c] as Vec3;
    const b = rows[r + 1]?.[c] as Vec3;
    const cc = rows[r + 1]?.[c + 1] as Vec3;
    const d = rows[r]?.[c + 1] as Vec3;
    const point =
      s <= t
        ? weighted([
            [a, 1 - t],
            [b, t - s],
            [cc, s],
          ])
        : weighted([
            [a, 1 - s],
            [cc, t],
            [d, s - t],
          ]);
    const facet = cross(sub(cc, a), sub(d, b));
    const away = sub(point, inside);
    const raw = Math.hypot(...facet) > EPS ? facet : away;
    const sign = raw[0] * away[0] + raw[1] * away[1] + raw[2] * away[2] >= 0 ? 1 : -1;
    return { point, normal: normalize(scale(raw, sign)) };
  };
}

/** Lateral span of a pane at height z, t running from -1 at its bottom to 1 at its top. */
type Span = (z: number, t: number) => readonly [number, number];

/** Width factor of a superellipse of exponent n at t in [-1, 1]. */
export function superellipse(t: number, n: number): number {
  return detPow(Math.max(0, 1 - detPow(Math.abs(t), n)), 1 / n);
}

/** Paint of a pane row by its height fraction from 0 at the bottom to 1 at the top. */
type PanePaint = Slot | ((height: number) => Slot);

/** The windscreen glass: dark below, a lighter band and a sky reflection in its top third. */
const GLASS: PanePaint = (h) => (h > 0.8 ? "sheen" : h > 0.64 ? "glass" : "window");
/** Photographed regional glass: grey-blue below, a lighter reflection from the middle up. */
const GLASS_LIGHT: PanePaint = (h) => (h > 0.55 ? "sheen" : "glass");
/** Dark seal round the windscreen pane, metres. */
const SCREEN_FRAME = 0.05;
/** Dark panel round a destination display, metres. */
const DISPLAY_PANEL = 0.04;

/** Lateral fraction and height of grid point (row k, column j) of a pane. */
type PatchPoint = (k: number, j: number) => readonly [number, number];
/** Lowest height of the visible skin at a lateral fraction. */
type Floor = (u: number) => number;
/** A pane point this far under the floor is hidden, and every quad touching it is left out. */
const FLOOR_TOLERANCE = 0.01;

/** The lifted points of a patch, their facet normals and which of them lie under the floor. */
interface PatchGrid {
  readonly points: Vec3[][];
  readonly normals: Vec3[][];
  readonly hidden: boolean[][];
  readonly centre: Vec3[];
}

function sampleGrid(
  facets: Facets,
  at: PatchPoint,
  lift: number,
  steps: readonly [number, number],
  floor?: Floor,
): PatchGrid {
  const [nz, nu] = steps;
  const grid: PatchGrid = { points: [], normals: [], hidden: [], centre: [] };
  for (let k = 0; k <= nz; k++) {
    const row: Vec3[] = [];
    const rowNormals: Vec3[] = [];
    const rowHidden: boolean[] = [];
    for (let j = 0; j <= nu; j++) {
      const [u, z] = at(k, j);
      rowHidden.push(!!floor && z < floor(u) - FLOOR_TOLERANCE);
      const f = facets(u, z);
      row.push(add(f.point, scale(f.normal, lift)));
      rowNormals.push(f.normal);
      if (j === Math.floor(nu / 2)) grid.centre.push(f.normal);
    }
    grid.points.push(row);
    grid.normals.push(rowNormals);
    grid.hidden.push(rowHidden);
  }
  return grid;
}

/** The four corners of quad (k, j) in one of the grid's tables, from row k column j round to row k + 1. */
function corners<T>(table: readonly (readonly T[])[], k: number, j: number): [T, T, T, T] {
  const lo = table[k] as readonly T[];
  const hi = table[k + 1] as readonly T[];
  return [lo[j] as T, lo[j + 1] as T, hi[j + 1] as T, hi[j] as T];
}

/**
 * A grid of quads just off the facets: rows 0..nz from bottom to top, columns 0..nu across,
 * each row painted by its height fraction, every quad facing out along the facets' normal.
 * Quads touching a point under the floor are left out.
 */
function emitPatch(
  mesh: MeshBuilder,
  facets: Facets,
  at: PatchPoint,
  heights: readonly number[],
  paint: PanePaint,
  lift: number,
  steps: readonly [number, number],
  floor?: Floor,
  local = false,
) {
  const [nz, nu] = steps;
  const grid = sampleGrid(facets, at, lift, steps, floor);
  for (let k = 0; k < nz; k++) {
    const facing = normalize(add(grid.centre[k] as Vec3, grid.centre[k + 1] as Vec3));
    const middle = ((heights[k] as number) + (heights[k + 1] as number)) / 2;
    const slot = typeof paint === "function" ? paint(middle) : paint;
    for (let j = 0; j < nu; j++) {
      if (corners(grid.hidden, k, j).some((h) => h)) continue;
      const normals = corners(grid.normals, k, j);
      const own = local
        ? normalize(normals.reduce((sum, n) => add(sum, n), [0, 0, 0] as Vec3))
        : facing;
      mesh.facingQuad(corners(grid.points, k, j), own, slot, normals);
    }
  }
}

/** Heights sampled along a column pane's outline when its columns are laid out. */
const OUTLINE_SAMPLES = 64;

/**
 * A pane inside a symmetric outline of half width `width(z)` between two heights, laid out in
 * columns: each column runs from the outline's bottom to its top at its lateral fraction, so the
 * outline's top and bottom edges are rows of the grid and the pane does not fan to a point at its
 * top or bottom, where on a dome such a fan cuts under the skin. Columns are spaced evenly along the
 * outline, so its steep sides get short edges too. Quads face along their own normals.
 */
function emitColumnPane(
  mesh: MeshBuilder,
  facets: Facets,
  pane: { readonly bottom: number; readonly top: number; readonly width: (z: number) => number },
  paint: PanePaint,
  lift: number,
  steps: readonly [number, number],
  floor?: Floor,
) {
  const [nz, nu] = steps;
  const zs = Array.from(
    { length: OUTLINE_SAMPLES + 1 },
    (_, i) => pane.bottom + ((pane.top - pane.bottom) * i) / OUTLINE_SAMPLES,
  );
  const ws = zs.map((z) => pane.width(z));
  const peak = ws.reduce((best, w, i) => (w > (ws[best] as number) ? i : best), 0);
  const widest = ws[peak] as number;
  if (widest <= EPS) return;
  const edge = (u: number, dir: 1 | -1): number => {
    let i = peak;
    while (i + dir >= 0 && i + dir <= OUTLINE_SAMPLES && (ws[i + dir] as number) >= u) i += dir;
    const next = i + dir;
    if (next < 0 || next > OUTLINE_SAMPLES) return zs[i] as number;
    const wa = ws[i] as number;
    const s = (wa - u) / Math.max(EPS, wa - (ws[next] as number));
    return (zs[i] as number) + ((zs[next] as number) - (zs[i] as number)) * s;
  };
  const table = Array.from({ length: OUTLINE_SAMPLES + 1 }, (_, i) => {
    const u = widest * (1 - i / OUTLINE_SAMPLES);
    const lo = edge(u, -1);
    const hi = edge(u, 1);
    return { u, lo, hi, low: facets(u, lo).point, high: facets(u, hi).point };
  });
  const along = [0];
  for (let i = 1; i < table.length; i++) {
    const a = table[i - 1] as (typeof table)[number];
    const b = table[i] as (typeof table)[number];
    const step = (p: Vec3, q: Vec3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    along.push((along[i - 1] as number) + step(a.high, b.high) + step(a.low, b.low));
  }
  const total = along[along.length - 1] as number;
  const half = nu / 2;
  const right = Array.from({ length: half + 1 }, (_, h) => {
    const target = (total * h) / half;
    let i = 1;
    while (i < along.length - 1 && (along[i] as number) < target) i++;
    const a = table[i - 1] as (typeof table)[number];
    const b = table[i] as (typeof table)[number];
    const s =
      (target - (along[i - 1] as number)) /
      Math.max(EPS, (along[i] as number) - (along[i - 1] as number));
    const lerp = (x: number, y: number) => x + (y - x) * Math.min(1, Math.max(0, s));
    return { u: lerp(a.u, b.u), lo: lerp(a.lo, b.lo), hi: lerp(a.hi, b.hi) };
  });
  const columns = [...right.map((c) => ({ ...c, u: -c.u })), ...right.slice(0, half).reverse()];
  const ts = Array.from({ length: nz + 1 }, (_, k) => (1 - Math.cos((Math.PI * k) / nz)) / 2);
  const at: PatchPoint = (k, j) => {
    const c = columns[j] as (typeof columns)[number];
    return [c.u, c.lo + (c.hi - c.lo) * (ts[k] as number)];
  };
  emitPatch(mesh, facets, at, ts, paint, lift, steps, floor, true);
}

/** Cosine spacing from -1 to 1 over n steps, denser at both ends. */
function cosineSteps(n: number): number[] {
  return Array.from({ length: n + 1 }, (_, k) => -Math.cos((Math.PI * k) / n));
}

function emitPane(
  mesh: MeshBuilder,
  facets: Facets,
  pane: { readonly bottom: number; readonly top: number; readonly span: Span },
  paint: PanePaint,
  lift: number,
  steps: readonly [number, number],
  floor?: Floor,
) {
  const [nz, nu] = steps;
  const ts = cosineSteps(nz);
  const across = (j: number) => (1 - Math.cos((Math.PI * j) / nu)) / 2;
  const rows = ts.map((t) => {
    const z = (pane.bottom + pane.top) / 2 + (t * (pane.top - pane.bottom)) / 2;
    return { z, span: pane.span(z, t) };
  });
  const at: PatchPoint = (k, j) => {
    const { z, span } = rows[k] as (typeof rows)[number];
    return [span[0] + (span[1] - span[0]) * across(j), z];
  };
  emitPatch(
    mesh,
    facets,
    at,
    ts.map((t) => (t + 1) / 2),
    paint,
    lift,
    steps,
    floor,
  );
}

const DEG = Math.PI / 180;

/**
 * A decal turned by its tilt about its pivot (its own centre when it has none): the outline is
 * laid out in metres on the unturned decal, turned so that the outer end rises, then mapped back
 * to lateral fractions at the pivot's height and mirrored when the decal has an inner edge.
 */
function emitTilted(
  mesh: MeshBuilder,
  facets: Facets,
  decal: FrontDecal,
  lift: number,
  steps: readonly [number, number],
  floor?: Floor,
) {
  const zc = (decal.bottom + decal.top) / 2;
  const pivotZ = decal.pivot?.z ?? zc;
  const perFraction = Math.max(
    EPS,
    Math.abs(facets(1, pivotZ).point[1] - facets(0, pivotZ).point[1]),
  );
  const mirrored = decal.inner > 0;
  const from = mirrored ? decal.inner : -decal.outer;
  const latC = ((from + decal.outer) / 2) * perFraction;
  const latP = (decal.pivot?.u ?? (from + decal.outer) / 2) * perFraction;
  const halfLength = ((decal.outer - from) / 2) * perFraction;
  const halfHeight = (decal.top - decal.bottom) / 2;
  const theta = (decal.tilt ?? 0) * DEG;
  const [nz, nu] = steps;
  const vs = cosineSteps(nz);
  const ss = cosineSteps(nu);
  for (const side of mirrored ? [1, -1] : [1]) {
    const at: PatchPoint = (k, j) => {
      const v = vs[k] as number;
      const lat =
        latC +
        (ss[j] as number) * halfLength * outline(v, decal.round) +
        (decal.slant * perFraction * v) / 2;
      const z = zc + v * halfHeight;
      const dl = lat - latP;
      const dz = z - pivotZ;
      const u = (latP + dl * Math.cos(theta) - dz * Math.sin(theta)) / perFraction;
      return [side * Math.min(1, u), pivotZ + dl * Math.sin(theta) + dz * Math.cos(theta)];
    };
    emitPatch(
      mesh,
      facets,
      at,
      vs.map((v) => (v + 1) / 2),
      decal.slot,
      lift,
      steps,
      floor,
    );
  }
}

function smoothWidth(widths: readonly (readonly [number, number])[], z: number): number {
  const sorted = [...widths].sort((a, b) => a[0] - b[0]);
  const first = sorted[0] as readonly [number, number];
  const last = sorted[sorted.length - 1] as readonly [number, number];
  if (z <= first[0]) return first[1];
  if (z >= last[0]) return last[1];
  let i = 0;
  while (z > (sorted[i + 1] as readonly [number, number])[0]) i++;
  const [z0, w0] = sorted[i] as readonly [number, number];
  const [z1, w1] = sorted[i + 1] as readonly [number, number];
  const s = (z - z0) / Math.max(EPS, z1 - z0);
  return w0 + (w1 - w0) * s * s * (3 - 2 * s);
}

/** Half width of the pane windscreen at height z, as a lateral fraction. */
export function screenPaneWidth(front: FrontSpec, z: number): number {
  const n = front.screenRound ?? 0;
  if (n <= 0 || z < front.screenBottom - EPS || z > front.screenTop + EPS) return 0;
  const t = (2 * z - front.screenBottom - front.screenTop) / (front.screenTop - front.screenBottom);
  const w =
    front.screenWidths && front.screenWidths.length >= 2
      ? smoothWidth(front.screenWidths, z)
      : front.screenWidth;
  return Math.min(1, w) * superellipse(t, n);
}

function decalSpans(decal: FrontDecal): Span[] {
  const k = (t: number) => outline(t, decal.round);
  if (decal.span) {
    const [a, b] = decal.span;
    const mid = (a + b) / 2;
    return [
      (_z, t) => {
        const h = ((b - a) / 2) * k(t);
        return [mid - h, mid + h];
      },
    ];
  }
  if (decal.inner <= 0) {
    return [
      (_z, t) => {
        const h = decal.outer * k(t);
        return [-h, h];
      },
    ];
  }
  const centre = (t: number) => (decal.inner + decal.outer) / 2 + (decal.slant * t) / 2;
  const half = (t: number) => ((decal.outer - decal.inner) / 2) * k(t);
  return [
    (_z, t) => [centre(t) - half(t), Math.min(1, centre(t) + half(t))],
    (_z, t) => [-Math.min(1, centre(t) + half(t)), -(centre(t) - half(t))],
  ];
}

/** Superellipse exponent from which a decal counts as a rectangle: its outline needs no rounding rows. */
const SQUARE = 12;

/** Width factor of a decal's outline at t in [-1, 1]: a superellipse, or full width for a rectangle. */
function outline(t: number, round: number): number {
  return round >= SQUARE ? 1 : superellipse(t, round);
}

/**
 * Rows and columns of a decal: about one every 0.1 of a fraction or 0.12 m, so its chords stay
 * near the facets; a rectangle takes rows only every 0.25 m and as few as two rows and columns.
 */
function decalSteps(decal: FrontDecal): [number, number] {
  const across = decal.span
    ? Math.abs(decal.span[1] - decal.span[0])
    : decal.inner > 0
      ? decal.outer - decal.inner
      : 2 * decal.outer;
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));
  const square = decal.round >= SQUARE;
  const rows = clamp((decal.top - decal.bottom) / (square ? 0.25 : 0.12), square ? 2 : 6, 12);
  return [rows, clamp(across / 0.1, square ? 2 : 6, 16)];
}

/** A lamp decal: a light pane mirrored on both sides, or a small round one in the middle (logos are square). */
export function isLamp(decal: FrontDecal): boolean {
  return decal.slot === "light" && (decal.inner > 0 || decal.round < 6);
}

const LENS_FILL = 0.68;
const LENS_GAP = 0.14;
const STRIP_RATIO = 2.2;
/** Margin between a cluster lamp's housing and its lenses, and the gap between white and red, metres. */
const CLUSTER_MARGIN = 0.035;
const CLUSTER_GAP = 0.025;

/** How a lamp shares its housing with a red tail lens: the share of its width, on which side. */
export interface TailShare {
  readonly share: number;
  readonly inner?: boolean;
  readonly below?: boolean;
}

/** A lamp housing measured on the facets: centre height, height, lateral span and its metres. */
interface Housing {
  readonly decal: FrontDecal;
  readonly z: number;
  readonly h: number;
  readonly from: number;
  readonly span: number;
  readonly metres: number;
  readonly perFraction: number;
  readonly strip: boolean;
}

function housing(decal: FrontDecal, facets: Facets): Housing {
  const z = (decal.bottom + decal.top) / 2;
  const h = decal.top - decal.bottom;
  const from = decal.inner > 0 ? decal.inner : -decal.outer;
  const span = decal.outer - from;
  const metres = Math.abs(facets(decal.outer, z).point[1] - facets(from, z).point[1]);
  const perFraction = metres / Math.max(EPS, span);
  return { decal, z, h, from, span, metres, perFraction, strip: metres > STRIP_RATIO * h };
}

/** A lens of the housing between two lateral fractions, turned with a tilted housing about its centre. */
function lensOf(
  hs: Housing,
  inner: number,
  outer: number,
  lensH: number,
  slot: Slot,
  round: number,
  centre?: number,
): FrontDecal {
  const { decal, z, h } = hs;
  const zc = centre ?? z;
  const lens: FrontDecal = {
    slot,
    bottom: zc - lensH / 2,
    top: zc + lensH / 2,
    inner,
    outer,
    round,
    slant: decal.slant * (lensH / Math.max(EPS, h)),
  };
  return decal.tilt
    ? { ...lens, tilt: decal.tilt, pivot: { u: (hs.from + decal.outer) / 2, z } }
    : lens;
}

/** Lenses filling a cluster lamp or a strip: one, or a white and a red part split by the share. */
function stripLenses(hs: Housing, share: number, inner: boolean): FrontDecal[] {
  const { decal, h, perFraction } = hs;
  const clusterMargin = decal.lensMargin ?? CLUSTER_MARGIN;
  const margin = decal.fill ? clusterMargin : h * 0.25;
  const mf = Math.min(hs.span / 4, clusterMargin / perFraction);
  const gf = CLUSTER_GAP / perFraction;
  const a = hs.from + mf;
  const b = decal.outer - mf;
  const round = Math.max(4, decal.round);
  const lens = (from: number, to: number, slot: Slot) =>
    lensOf(hs, from, to, h - 2 * margin, slot, round);
  if (share <= 0 || share >= 1 || decal.inner <= 0)
    return [lens(Math.max(0, a), b, share >= 1 ? "tail" : "light")];
  if (inner) {
    const cut = a + (b - a) * share;
    return [lens(a, cut - gf / 2, "tail"), lens(cut + gf / 2, b, "light")];
  }
  const cut = b - (b - a) * share;
  return [lens(a, cut - gf / 2, "light"), lens(cut + gf / 2, b, "tail")];
}

/** A white and a red round lens, each centred in its share of the housing. */
function splitLenses(hs: Housing, share: number, inner: boolean): FrontDecal[] {
  const { decal, from, span, perFraction, h } = hs;
  const at = inner ? from + span * share : decal.outer - span * share;
  const cells: [number, number, Slot][] = inner
    ? [
        [from, at, "tail"],
        [at, decal.outer, "light"],
      ]
    : [
        [from, at, "light"],
        [at, decal.outer, "tail"],
      ];
  return cells.map(([c0, c1, slot]) => {
    const lensH = Math.min(h * LENS_FILL, (c1 - c0) * perFraction * (1 - LENS_GAP));
    const lensW = Math.min((c1 - c0) * (1 - LENS_GAP), lensH / perFraction);
    const centre = (c0 + c1) / 2;
    return lensOf(hs, centre - lensW / 2, centre + lensW / 2, lensH, slot, 2.2);
  });
}

/** A small white lens above a larger red one, both round, centred in the housing. */
function stackLenses(hs: Housing): FrontDecal[] {
  const { z, h, from, span, perFraction } = hs;
  const diameter = Math.min(h * 0.4, hs.metres * 0.7);
  const half = diameter / 2 / perFraction;
  const centre = from + span / 2;
  return [
    lensOf(hs, Math.max(0, centre - half), centre + half, diameter, "light", 2.2, z + h * 0.24),
    lensOf(hs, Math.max(0, centre - half), centre + half, diameter, "tail", 2.2, z - h * 0.24),
  ];
}

/** Round lenses side by side (one or two by the housing's width) or one inset strip, all one colour. */
function plainLenses(hs: Housing, slot: Slot): FrontDecal[] {
  const { decal, from, span, metres, perFraction, h, strip } = hs;
  const count = strip ? 1 : metres > 1.45 * h ? 2 : 1;
  const cell = span / count;
  const lensH = strip ? h * 0.5 : Math.min(h * LENS_FILL, (metres / count) * (1 - LENS_GAP));
  const lensW = strip ? span * 0.9 : Math.min(cell * (1 - LENS_GAP), lensH / perFraction);
  const round = strip ? Math.max(4, decal.round) : 2.2;
  const clear = count === 2 && decal.clearLens ? (decal.clearLens === "inner" ? 0 : 1) : -1;
  return Array.from({ length: count }, (_, i) => {
    const centre = from + cell * (i + 0.5);
    const lens = lensOf(
      hs,
      Math.max(0, centre - lensW / 2),
      centre + lensW / 2,
      lensH,
      i === clear ? "glass" : slot,
      round,
    );
    return decal.inner > 0 ? lens : { ...lens, inner: 0, outer: lensW / 2 };
  });
}

/**
 * Lenses inside a lamp housing, as decals on its outline. Without a tail share: round lenses side
 * by side, as many as the housing is wide in units of its height (one or two), or one inset strip
 * for a slim LED strip. With a share below 1 the housing splits into a white and a red part (red
 * outside unless `inner`): two round lenses, two strips, or for a cluster lamp (`fill`) two lenses
 * filling the housing. A share of 1 paints the lenses red.
 */
export function lampLenses(decal: FrontDecal, facets: Facets, tail?: TailShare): FrontDecal[] {
  const hs = housing(decal, facets);
  if (tail?.below && tail.share > 0 && decal.inner > 0) return stackLenses(hs);
  const share = tail?.share ?? 0;
  const inner = tail?.inner ?? false;
  const split = share > 0 && share < 1 && decal.inner > 0;
  if (decal.fill || (hs.strip && split)) return stripLenses(hs, share, inner);
  if (split) return splitLenses(hs, share, inner);
  return plainLenses(hs, share >= 1 ? "tail" : "light");
}

/** Share of a lamp given by the forge's rule to a single lone lamp, a pair of lenses and a strip. */
const AUTO_TAIL = { lone: 0.4, pair: 0.5, strip: 0.3 } as const;

function autoShare(lamp: FrontDecal, facets: Facets, alone: boolean): number {
  if (!alone) return 1;
  const hs = housing(lamp, facets);
  if (lamp.fill || hs.strip) return AUTO_TAIL.strip;
  return hs.metres > 1.45 * hs.h ? AUTO_TAIL.pair : AUTO_TAIL.lone;
}

/**
 * The red tail lens of each mirrored lamp. Lamps that state a tail keep it, and then every other
 * lamp stays white. Otherwise the outermost lamp (the lowest of equals) carries the red lens: its
 * whole lens when other lamps sit beside it, else half of a pair, the outer end of a strip, or a
 * smaller lens beside a lone round one.
 */
export function tailShares(
  decals: readonly FrontDecal[],
  facets: Facets,
): Map<FrontDecal, TailShare> {
  const lamps = decals.filter((d) => isLamp(d) && d.inner > 0);
  const out = new Map<FrontDecal, TailShare>();
  const side = (d: FrontDecal) =>
    d.tailBelow ? { below: true } : d.tailInner ? { inner: true } : {};
  if (lamps.some((d) => d.tail !== undefined)) {
    for (const d of lamps) out.set(d, { share: d.tail ?? 0, ...side(d) });
    return out;
  }
  const outer = [...lamps].sort((a, b) => b.outer - a.outer || a.bottom - b.bottom)[0];
  if (outer)
    out.set(outer, { share: autoShare(outer, facets, lamps.length === 1), ...side(outer) });
  return out;
}

/**
 * The windscreen pane and the decals of a front, drawn just off its facets at full detail, one
 * layer above the other: decals marked under first, then the windscreen, then the rest in order.
 * `floor` is the lowest height of the visible skin at a lateral fraction (the apron is cut behind
 * it); nothing is drawn below it, so a decal ends on the skin instead of hanging under the nose.
 */
/** The lateral and height range a decal covers on one side, grown by the turn of a tilted decal. */
interface Footprint {
  readonly u0: number;
  readonly u1: number;
  readonly z0: number;
  readonly z1: number;
  readonly layer: number;
}

/** A decal this tall or wide spans enough of a curved front that its chords sag: it starts two layers up. */
const LARGE = { height: 0.5, across: 0.6 } as const;
const LARGE_LAYER = 2;

function isLarge(f: Omit<Footprint, "layer">): boolean {
  return f.z1 - f.z0 > LARGE.height || f.u1 - f.u0 > LARGE.across;
}

/** Metres per lateral fraction assumed when a tilted decal's footprint is grown. */
const FOOTPRINT_HALF_WIDTH = 1.5;

function footprint(decal: FrontDecal): Omit<Footprint, "layer"> {
  if (decal.span) {
    const [a, b] = decal.span;
    const near = a * b > 0 ? Math.min(Math.abs(a), Math.abs(b)) : 0;
    return {
      u0: near,
      u1: Math.max(Math.abs(a), Math.abs(b)),
      z0: decal.bottom,
      z1: decal.top,
    };
  }
  const rise = decal.tilt
    ? ((decal.outer - decal.inner) / 2) *
      FOOTPRINT_HALF_WIDTH *
      Math.abs(Math.sin(decal.tilt * DEG))
    : 0;
  const lean = Math.abs(decal.slant) / 2;
  return {
    u0: Math.max(0, decal.inner - lean),
    u1: decal.outer + lean,
    z0: decal.bottom - rise,
    z1: decal.top + rise,
  };
}

/**
 * The windscreen frame and glass laid out in columns (`screen_columns`): the frame on the glass's
 * grid, so their chords run together, and the glass one layer higher, so the frame never shows
 * through it on a dome. `lifts` are the frame's and the glass's lifts.
 */
function emitColumnScreen(
  mesh: MeshBuilder,
  facets: Facets,
  front: FrontSpec,
  framed: FrontSpec,
  flat: boolean,
  lifts: readonly [number, number],
) {
  const steps: [number, number] = flat ? [8, 10] : [10, 16];
  const outline = (spec: FrontSpec) => ({
    bottom: spec.screenBottom,
    top: spec.screenTop,
    width: (z: number) => screenPaneWidth(spec, z),
  });
  emitColumnPane(mesh, facets, outline(framed), "housing", lifts[0], steps);
  emitColumnPane(mesh, facets, outline(front), GLASS, lifts[1], steps);
}

/**
 * The DB logo plate as rectangles in metres about the decal's centre: the plate in the ink
 * slot, the red field inset by the border, then the letters D and B as blocks of the plate's
 * colour with red counters (the field's colour) on top of them. With `redLetters` the two colours
 * swap: a red border and red letters on a field in the decal's slot.
 */
const LOGO_BORDER = 0.035;
const LOGO_LETTER_HEIGHT = 0.72;
const LOGO_PARTS: readonly {
  readonly x: readonly [number, number];
  readonly y: readonly [number, number];
  readonly field: boolean;
}[] = [
  { x: [-0.38, -0.02], y: [-0.5, 0.5], field: false },
  { x: [-0.265, -0.135], y: [-0.27, 0.27], field: true },
  { x: [0.02, 0.38], y: [-0.5, 0.5], field: false },
  { x: [0.125, 0.27], y: [-0.28, -0.07], field: true },
  { x: [0.125, 0.27], y: [0.07, 0.28], field: true },
];

/** The plate's colour (border and letters) and the field's colour (field and counters). */
function logoSlots(decal: FrontDecal): { readonly plate: Slot; readonly field: Slot } {
  return decal.redLetters
    ? { plate: "logo", field: decal.slot }
    : { plate: "logo_ink", field: "logo" };
}

/** Layers above the plate: its field, then the letters, then their counters. */
function logoStep(part: FrontDecal, field: Slot): number {
  const inField = part.slot === field ? 1 : 0;
  return part.span ? 2 + inField : inField;
}

export function logoParts(decal: FrontDecal, facets: Facets): FrontDecal[] {
  const slots = logoSlots(decal);
  const z = (decal.bottom + decal.top) / 2;
  const perFraction = Math.max(EPS, Math.abs(facets(1, z).point[1] - facets(0, z).point[1]));
  const width = 2 * decal.outer * perFraction;
  const height = decal.top - decal.bottom;
  const metres = (m: number) => m / perFraction;
  const base = { round: 12, slant: 0, inner: 0, outer: 0 };
  const plate: FrontDecal = {
    ...base,
    slot: slots.plate,
    bottom: decal.bottom,
    top: decal.top,
    outer: decal.outer,
    round: 6,
  };
  const inset = LOGO_BORDER;
  const field: FrontDecal = {
    ...plate,
    slot: slots.field,
    bottom: decal.bottom + inset,
    top: decal.top - inset,
    outer: Math.max(0.01, decal.outer - metres(inset)),
  };
  const letters = LOGO_LETTER_HEIGHT * (height - 2 * inset);
  const parts = LOGO_PARTS.map((part) => {
    return {
      ...base,
      slot: part.field ? slots.field : slots.plate,
      bottom: z + part.y[0] * letters,
      top: z + part.y[1] * letters,
      outer: 0,
      span: [
        metres(part.x[0] * (width - 2 * inset)),
        metres(part.x[1] * (width - 2 * inset)),
      ] as const,
    };
  });
  return [plate, field, ...parts];
}

/** Moves a combined lamp's light lenses emitted since `from` (an index into the uvs) to its tail spot. */
function markCombinedTail(mesh: MeshBuilder, from: number, decal: FrontDecal) {
  if (!decal.combinedTail) return;
  const light = slotU("light");
  for (let k = from; k < mesh.uvs.length; k += 2)
    if (mesh.uvs[k] === light) mesh.uvs[k] = COMBINED_TAIL_U;
}

export function emitPanes(mesh: MeshBuilder, front: FrontSpec, facets: Facets, floor?: Floor) {
  const decals = front.decals ?? [];
  const under = decals.filter((d) => d.under);
  const over = decals.filter((d) => !d.under);
  const tails = tailShares(over, facets);
  const placed: Footprint[] = [];
  /** One layer above every earlier pane it overlaps, so panes that do not touch share the lowest lift. */
  const layerFor = (f: Omit<Footprint, "layer">, lowest = 0) =>
    placed
      .filter((p) => p.u0 < f.u1 && f.u0 < p.u1 && p.z0 < f.z1 && f.z0 < p.z1)
      .reduce((top, p) => Math.max(top, p.layer + 1), lowest);
  const place = (f: Omit<Footprint, "layer">, layer = layerFor(f)) => {
    placed.push({ ...f, layer });
    return PANE_LIFT + DECAL_STEP * layer;
  };
  const emitDecal = (decal: FrontDecal, steps?: [number, number], layer?: number) => {
    const f = footprint(decal);
    const lift = place(f, layer ?? layerFor(f, isLarge(f) ? LARGE_LAYER : 0));
    if (decal.tilt) emitTilted(mesh, facets, decal, lift, steps ?? decalSteps(decal), floor);
    else
      for (const span of decalSpans(decal)) {
        emitPane(
          mesh,
          facets,
          { bottom: decal.bottom, top: decal.top, span },
          decal.slot,
          lift,
          steps ?? decalSteps(decal),
          floor,
        );
      }
  };
  const emitLogo = (decal: FrontDecal) => {
    const parts = logoParts(decal, facets);
    const field = logoSlots(decal).field;
    const first = layerFor(footprint(parts[0] as FrontDecal));
    for (const part of parts)
      emitDecal(part, part.span ? undefined : [3, 6], first + logoStep(part, field));
  };
  const emitSeam = (decal: FrontDecal) => {
    const width = decal.inner > 0 ? decal.outer - decal.inner : 2 * decal.outer;
    const count = (extent: number, most: number) =>
      Math.min(most, Math.max(1, Math.round(extent / SEAM_STEP)));
    const steps: [number, number] = [count(decal.top - decal.bottom, 32), count(width, 24)];
    for (const span of decalSpans(decal))
      emitPane(mesh, facets, { ...decal, span }, decal.slot, SEAM_LIFT, steps, floor);
  };
  const emitDisplay = (decal: FrontDecal) => {
    const z = (decal.bottom + decal.top) / 2;
    const perFraction = Math.abs(facets(1, z).point[1] - facets(0, z).point[1]);
    const pad = DISPLAY_PANEL / Math.max(EPS, perFraction);
    emitDecal({
      ...decal,
      slot: "housing",
      bottom: decal.bottom - DISPLAY_PANEL,
      top: decal.top + DISPLAY_PANEL,
      inner: decal.inner > 0 ? Math.max(0, decal.inner - pad) : 0,
      outer: Math.min(1, decal.outer + pad),
    });
    emitDecal(decal);
  };
  const emitOver = (decal: FrontDecal) => {
    if (decal.seam) return emitSeam(decal);
    if (decal.logo) return emitLogo(decal);
    if (decal.slot === "display") return emitDisplay(decal);
    if (!isLamp(decal)) return emitDecal(decal);
    const housingLayer = layerFor(footprint(decal));
    emitDecal({ ...decal, slot: "housing" }, undefined, housingLayer);
    const from = mesh.uvs.length;
    for (const lens of lampLenses(decal, facets, tails.get(decal)))
      emitDecal(lens, decal.fill ? undefined : [4, 6], housingLayer + 1);
    markCombinedTail(mesh, from, decal);
  };
  for (const decal of under) emitDecal(decal);
  if (front.screenRound) {
    const flat = front.plan[0] >= 4;
    const mid = (front.screenBottom + front.screenTop) / 2;
    const perFraction = Math.abs(facets(1, mid).point[1] - facets(0, mid).point[1]);
    const grow = SCREEN_FRAME / Math.max(EPS, perFraction);
    const framed: FrontSpec = {
      ...front,
      screenBottom: front.screenBottom - SCREEN_FRAME,
      screenTop: front.screenTop + SCREEN_FRAME,
      screenWidth: front.screenWidth + grow,
      screenWidths: front.screenWidths?.map(([z, w]) => [z, w + grow] as const) ?? null,
    };
    const widest = Math.max(framed.screenWidth, ...(framed.screenWidths ?? []).map(([, w]) => w));
    const glassArea = {
      u0: 0,
      u1: Math.min(1, widest),
      z0: framed.screenBottom,
      z1: framed.screenTop,
    };
    const frameSpan: Span = (z) => {
      const w = screenPaneWidth(framed, z);
      return [-w, w];
    };
    if (front.screenColumns) {
      emitColumnScreen(mesh, facets, front, framed, flat, [
        place(glassArea),
        place(glassArea, layerFor(glassArea) + 1),
      ]);
      over.forEach(emitOver);
      return;
    }
    emitPane(
      mesh,
      facets,
      { bottom: framed.screenBottom, top: framed.screenTop, span: frameSpan },
      "housing",
      place(glassArea),
      flat ? [4, 8] : [6, 12],
    );
    const span: Span = (z) => {
      const w = screenPaneWidth(front, z);
      return [-w, w];
    };
    emitPane(
      mesh,
      facets,
      { bottom: front.screenBottom, top: front.screenTop, span },
      front.lightGlass ? GLASS_LIGHT : GLASS,
      place(glassArea),
      flat ? [8, 10] : [10, 16],
    );
  }
  over.forEach(emitOver);
}
