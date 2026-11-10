import type { ViewPadding } from "./view-padding.ts";

export interface CameraPose {
  readonly center: { readonly lng: number; readonly lat: number };
  readonly zoom: number;
}

const ZOOM_TOLERANCE = 0.05;
const CENTER_TOLERANCE_DEGREES = 0.05;

export function cameraMatches(current: CameraPose, target: CameraPose): boolean {
  return (
    Math.abs(current.zoom - target.zoom) <= ZOOM_TOLERANCE &&
    Math.abs(current.center.lng - target.center.lng) <= CENTER_TOLERANCE_DEGREES &&
    Math.abs(current.center.lat - target.center.lat) <= CENTER_TOLERANCE_DEGREES
  );
}

function samePadding(a: ViewPadding, b: ViewPadding): boolean {
  return a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.right === b.right;
}

/**
 * The left slot opening or closing re-frames the national overview, but only while the view is
 * still the overview of the previous padding and no card flies the camera somewhere else.
 */
export function planSlotEase(change: {
  before: ViewPadding;
  after: ViewPadding;
  atOverview: boolean;
  refit: boolean;
}): "ease" | "stay" {
  if (!change.refit || !change.atOverview || samePadding(change.before, change.after)) {
    return "stay";
  }
  return "ease";
}

export interface SlotEaseHost {
  camera(): CameraPose;
  /** The camera that frames the national overview with `padding`, undefined where there is none. */
  target(padding: ViewPadding): CameraPose | undefined;
  fit(padding: ViewPadding, durationMs: number): void;
  isMoving(): boolean;
  onceIdle(callback: () => void): void;
  endGesture(): void;
  duration(): number;
}

/**
 * Re-frames the national overview when the left slot opens or closes. An ease still running
 * counts as the overview, so a quick toggle retargets it; a gesture that ends the ease leaves the
 * camera where the user put it.
 */
export class SlotEase {
  private easing = false;

  private readonly host: SlotEaseHost;

  constructor(host: SlotEaseHost) {
    this.host = host;
  }

  change(change: {
    before: ViewPadding;
    after: ViewPadding;
    refit: boolean;
    selected: boolean;
  }): void {
    const plan = planSlotEase({
      before: change.before,
      after: change.after,
      atOverview: !change.selected && (this.easing || this.atOverview(change.before)),
      refit: change.refit,
    });
    if (plan === "stay") {
      return;
    }
    this.host.endGesture();
    this.easing = true;
    this.host.fit(change.after, this.host.duration());
    if (this.host.isMoving()) {
      this.host.onceIdle(() => {
        this.easing = false;
      });
    } else {
      this.easing = false;
    }
  }

  private atOverview(padding: ViewPadding): boolean {
    const target = this.host.target(padding);
    return target !== undefined && cameraMatches(this.host.camera(), target);
  }
}
