export interface DeckWindows {
  /** The shape of each run, so the page can remember what it already measured. */
  readonly shapeIds: readonly string[];
  /** Index of the first shape vertex of each run. */
  readonly first: Uint32Array;
  /** Vertex count of each run. */
  readonly counts: Uint32Array;
  /** Longitude, latitude and drawn height of the vertices of all runs, one after the other. */
  readonly paths: Float32Array;
}

/** A fresh empty deck each time: the worker transfers its buffers, and a transferred buffer cannot be sent twice. */
export function emptyDeck(): DeckWindows {
  return {
    shapeIds: [],
    first: new Uint32Array(0),
    counts: new Uint32Array(0),
    paths: new Float32Array(0),
  };
}

/** Zoom from which the line under the trains is drawn from the shape heights. */
export const DECK_MIN_ZOOM = 12;
/** Vertices one deck message holds at most: about 1.8 MB, so a dense view cannot flood the page. */
export const MAX_DECK_VERTICES = 150_000;
const MIN_GAP_MS = 600;
const REFRESH_MS = 4000;
const PAD_PER_SIDE = 0.5;
const MARGIN = 0.1;

/** A box of Web Mercator metres. */
export interface DeckBox {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/**
 * Decides when the worker sends the track of the shapes in view again. A bridge is there with or
 * without a train, so the deck covers every shape in the view plus half a screen on each side and
 * is scanned again only when the view comes near the edge of that box, when the shown categories
 * changed, or now and then (new shapes arrive). The worker sends a scan only if it differs from the last.
 */
export class DeckSchedule {
  private sent: DeckBox | undefined;
  private sentAt = Number.NEGATIVE_INFINITY;
  private version = Number.NaN;

  /** The box to scan when a scan is due now, otherwise null. A due scan counts as done. */
  due(view: DeckBox, version: number, wallMs: number): DeckBox | null {
    if (wallMs - this.sentAt < MIN_GAP_MS) return null;
    const wanted =
      !this.sent ||
      version !== this.version ||
      wallMs - this.sentAt >= REFRESH_MS ||
      !this.holds(view);
    if (!wanted) return null;
    const pad = PAD_PER_SIDE * Math.max(view.maxX - view.minX, view.maxY - view.minY);
    this.sent = {
      minX: view.minX - pad,
      minY: view.minY - pad,
      maxX: view.maxX + pad,
      maxY: view.maxY + pad,
    };
    this.sentAt = wallMs;
    this.version = version;
    return this.sent;
  }

  reset(): void {
    this.sent = undefined;
    this.sentAt = Number.NEGATIVE_INFINITY;
    this.version = Number.NaN;
  }

  private holds(view: DeckBox): boolean {
    const sent = this.sent as DeckBox;
    const margin = MARGIN * Math.max(view.maxX - view.minX, view.maxY - view.minY);
    return (
      view.minX >= sent.minX + margin &&
      view.minY >= sent.minY + margin &&
      view.maxX <= sent.maxX - margin &&
      view.maxY <= sent.maxY - margin
    );
  }
}

/** The windows of one shape merged where they overlap or touch, in vertex order. */
export function mergeWindows(
  windows: readonly { readonly from: number; readonly to: number }[],
): { from: number; to: number }[] {
  const sorted = [...windows].sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: { from: number; to: number }[] = [];
  for (const window of sorted) {
    const last = merged[merged.length - 1];
    if (last && window.from <= last.to + 1) last.to = Math.max(last.to, window.to);
    else merged.push({ from: window.from, to: window.to });
  }
  return merged;
}
