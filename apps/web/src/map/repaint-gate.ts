import { type Frame, type FrameGroup, POSITION_STRIDE } from "../motion/frame.ts";

export interface GateView {
  readonly zoom: number;
  readonly lng: number;
  readonly lat: number;
  readonly pitch: number;
  readonly bearing: number;
  /** Pixels one unit of a train's size gives a chevron at this zoom; 0 while only dots are drawn. */
  readonly chevronPixels: number;
  /** How many times finer than at the screen centre the nearest row resolves the ground, at least 1 (a pitched view). */
  readonly nearScale: number;
  /** Canvas size in CSS pixels and the camera padding, which move the labels. */
  readonly width: number;
  readonly height: number;
  readonly padding: string;
}

/** The finer scale of the nearest screen row against the centre, from metres per pixel at both; 1 when it is not finer. */
export function nearScale(centreMetresPerPixel: number, nearMetresPerPixel: number): number {
  if (!(nearMetresPerPixel > 0)) return 1;
  return Math.max(1, centreMetresPerPixel / nearMetresPerPixel);
}

export interface GateOptions {
  /** Screen distance in CSS pixels a train may be from where it was drawn before the map draws again. */
  readonly pixels?: number;
  /** The longest time the map goes without drawing a new frame. */
  readonly maxAgeMs?: number;
}

const EARTH_CIRCUMFERENCE_M = 40_075_016.7;

interface Drawn {
  readonly view: GateView;
  readonly groups: readonly FrameGroup[];
  readonly at: number;
}

function sameBytes(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function snapshot(group: FrameGroup): FrameGroup {
  return {
    hollow: group.hollow,
    count: group.count,
    positions: group.positions.slice(),
    iconAngles: group.iconAngles.slice(),
    sizes: group.sizes.slice(),
    fillColors: group.fillColors.slice(),
    lineColors: group.lineColors.slice(),
    ids: undefined,
  };
}

function sameView(a: GateView, b: GateView): boolean {
  return (
    a.zoom === b.zoom &&
    a.lng === b.lng &&
    a.lat === b.lat &&
    a.pitch === b.pitch &&
    a.bearing === b.bearing &&
    a.nearScale === b.nearScale &&
    a.width === b.width &&
    a.height === b.height &&
    a.padding === b.padding
  );
}

/**
 * Tells the map when a frame of trains differs enough from the last one drawn to be worth a draw. Every draw of the
 * interleaved map repaints the whole style, which software GL pays in full; at national zoom a train needs seconds to
 * move half a pixel, so most frames change nothing anyone can see. The comparison is against the last frame drawn,
 * not the last frame received, so slow movement adds up until it shows.
 */
export class RepaintGate {
  private readonly pixels: number;
  private readonly maxAgeMs: number;
  private drawn: Drawn | undefined;

  constructor(options: GateOptions = {}) {
    this.pixels = options.pixels ?? 0.5;
    this.maxAgeMs = options.maxAgeMs ?? 2000;
  }

  forget(): void {
    this.drawn = undefined;
  }

  /**
   * Whether the frame is worth a draw; when it is, the frame becomes the one later frames are compared with. While a
   * train is selected or cars are drawn every frame draws and nothing is kept, so the first frame after it draws too.
   */
  shouldDraw(frame: Frame, view: GateView, now: number): boolean {
    if (frame.selected !== null || frame.cars !== undefined) {
      this.drawn = undefined;
      return true;
    }
    const last = this.drawn;
    if (
      last === undefined ||
      now - last.at >= this.maxAgeMs ||
      !sameView(last.view, view) ||
      this.differs(frame.groups, last.groups, view)
    ) {
      this.drawn = { view, groups: frame.groups.map(snapshot), at: now };
      return true;
    }
    return false;
  }

  private differs(
    groups: readonly FrameGroup[],
    held: readonly FrameGroup[],
    view: GateView,
  ): boolean {
    if (groups.length !== held.length) return true;
    const worldPixels = 512 * 2 ** view.zoom;
    const limit = this.pixels / view.nearScale;
    return groups.some((group, index) => {
      const before = held[index] as FrameGroup;
      return (
        group.ids !== undefined ||
        group.hollow !== before.hollow ||
        group.count !== before.count ||
        !sameBytes(group.sizes, before.sizes) ||
        !sameBytes(group.fillColors, before.fillColors) ||
        !sameBytes(group.lineColors, before.lineColors) ||
        this.turned(group, before, view.chevronPixels * view.nearScale) ||
        this.moved(group.positions, before.positions, group.count, worldPixels, limit)
      );
    });
  }

  /** A chevron has turned when its tip, half its size from the centre, has moved by more than the pixel limit. */
  private turned(group: FrameGroup, before: FrameGroup, chevronPixels: number): boolean {
    if (chevronPixels === 0) return false;
    for (let index = 0; index < group.count; index++) {
      const half = ((group.sizes[index] as number) * chevronPixels) / 2;
      const difference =
        (Math.abs((group.iconAngles[index] as number) - (before.iconAngles[index] as number)) %
          360) *
        (Math.PI / 180);
      if (Math.min(difference, 2 * Math.PI - difference) * half > this.pixels) return true;
    }
    return false;
  }

  /** Whether any train is more than `limit` screen pixels from where it was, height counted as the pixels it spans. */
  private moved(
    now: Float32Array | Float64Array,
    before: Float32Array | Float64Array,
    count: number,
    worldPixels: number,
    limit: number,
  ): boolean {
    for (let index = 0; index < count; index++) {
      const at = index * POSITION_STRIDE;
      const lon = now[at] as number;
      const lat = now[at + 1] as number;
      const height = now[at + 2] as number;
      const lonBefore = before[at] as number;
      const latBefore = before[at + 1] as number;
      const heightBefore = before[at + 2] as number;
      if (lon === lonBefore && lat === latBefore && height === heightBefore) continue;
      const east = ((lon - lonBefore) / 360) * worldPixels;
      const north = ((mercatorY(lat) - mercatorY(latBefore)) / (2 * Math.PI)) * worldPixels;
      const metresPerPixel =
        (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / worldPixels;
      const up = (height - heightBefore) / metresPerPixel;
      if (Math.hypot(east, north, up) > limit) return true;
    }
    return false;
  }
}

function mercatorY(latitude: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (latitude * Math.PI) / 360));
}

/** Probe runs only: `?repaint=always` draws every frame the worker evaluates, as before the gate, so frame budgets measure drawing. */
export function drawsEveryFrame(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has("probe") && params.get("repaint") === "always";
}
