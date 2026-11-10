import { detPow } from "./det-math.ts";

/**
 * A lofted nose: towards the tip every cross-section of the front narrows to a superellipse
 * round a waist height, so the nose tapers in plan and rounds in the front view.
 */
export interface NoseLoft {
  /** Height where the sections keep the width of the plan outline. */
  readonly waist: number;
  /** Heights where the section at the tip closes, above and below the waist. */
  readonly top: number;
  readonly bottom: number;
  /** Superellipse exponent of the tip section: 2 is elliptic, higher is squarer. */
  readonly exponent: number;
  /** Power of the taper along the nose: 1 is linear in the nose progress, higher keeps the body section longer. */
  readonly taper: number;
  /** Measured tip-section widths as [height, fraction of the plan width], replacing the superellipse. */
  readonly widths?: readonly (readonly [number, number])[] | null;
}

const MIN_WIDTH = 0.08;

function measuredWidth(widths: readonly (readonly [number, number])[], z: number): number {
  const sorted = [...widths].sort((a, b) => a[0] - b[0]);
  const first = sorted[0] as readonly [number, number];
  const last = sorted[sorted.length - 1] as readonly [number, number];
  if (z <= first[0]) return Math.min(1, first[1]);
  if (z >= last[0]) return Math.min(1, last[1]);
  for (let i = 0; i < sorted.length - 1; i++) {
    const [z0, w0] = sorted[i] as readonly [number, number];
    const [z1, w1] = sorted[i + 1] as readonly [number, number];
    if (z <= z1) {
      const t = (z - z0) / Math.max(1e-6, z1 - z0);
      const s = t * t * (3 - 2 * t);
      return Math.min(1, w0 + (w1 - w0) * s);
    }
  }
  return Math.min(1, last[1]);
}

/** Half width of the tip section at height z, as a fraction of the plan width (0 to 1). */
export function sectionWidth(loft: NoseLoft, z: number): number {
  if (loft.widths && loft.widths.length >= 2)
    return Math.max(MIN_WIDTH, measuredWidth(loft.widths, z));
  const span = z >= loft.waist ? loft.top - loft.waist : loft.waist - loft.bottom;
  const d = Math.min(1, Math.abs(z - loft.waist) / Math.max(span, 1e-6));
  return Math.max(MIN_WIDTH, detPow(1 - detPow(d, loft.exponent), 1 / loft.exponent));
}

/** Lateral scale at nose station p (0 at the nose base, 1 at the tip) and height z. */
export function loftScale(loft: NoseLoft | null | undefined, progress: number, z: number): number {
  if (!loft) return 1;
  const p = Math.min(1, Math.max(0, progress));
  return 1 - detPow(p, loft.taper) * (1 - sectionWidth(loft, z));
}
