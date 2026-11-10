import type { MapStyleKind } from "../style/map-styles.ts";
import { TERRAIN_EXAGGERATION } from "../style/palette.ts";

export const TERRAIN_PITCH = 50;
export const TERRAIN_MAX_PITCH = 60;
const TILT_MS = 900;

export interface ReliefMap {
  getPitch(): number;
  isMoving(): boolean;
  setMaxPitch(pitch: number): void;
  easeTo(options: { pitch: number; duration: number }): void;
  once(event: "moveend", callback: () => void): void;
}

export interface ReliefLook {
  readonly current: { readonly style: MapStyleKind; readonly terrain3d: boolean };
  update(patch: { style?: MapStyleKind; terrain3d?: boolean }): void;
}

export interface ReliefDeps {
  readonly map: ReliefMap;
  readonly look: ReliefLook;
  /** Tells the live worker the exaggeration trains are lifted by; 0 for a flat map. */
  readonly setElevation: (scale: number) => void;
  readonly flightMs: (ms: number) => number;
  /** Whether a selection holds the map tilted: a style change then neither flattens it nor drops the pitch limit. */
  readonly holdsTilt?: () => boolean;
}

/**
 * Keeps the style's relief, the pitch of the map and the height of the trains in step: trains are
 * lifted only while the style draws the relief, and the map tilts only then.
 */
export class ReliefControl {
  private readonly deps: ReliefDeps;

  constructor(deps: ReliefDeps) {
    this.deps = deps;
  }

  /** Tells the worker the height of the trains for a map that was built with its relief already on. */
  start(): void {
    this.syncElevation();
  }

  setStyle(style: MapStyleKind): void {
    const terrain3d = style === "terrain" && this.deps.look.current.terrain3d;
    if (!terrain3d && !this.holdsTilt()) this.leavePitch();
    this.deps.look.update({ style, terrain3d });
    this.syncElevation();
  }

  setTerrain3d(on: boolean): void {
    const { look, map } = this.deps;
    const enabled = on && look.current.style === "terrain";
    if (enabled === look.current.terrain3d) return;
    look.update({ terrain3d: enabled });
    this.syncElevation();
    if (enabled) {
      map.setMaxPitch(TERRAIN_MAX_PITCH);
      map.easeTo({ pitch: TERRAIN_PITCH, duration: this.deps.flightMs(TILT_MS) });
    } else if (!this.holdsTilt()) {
      this.leavePitch();
    }
  }

  private syncElevation(): void {
    this.deps.setElevation(this.deps.look.current.terrain3d ? TERRAIN_EXAGGERATION : 0);
  }

  private leavePitch(): void {
    const { map, look } = this.deps;
    if (map.getPitch() === 0) {
      map.setMaxPitch(0);
      return;
    }
    map.easeTo({ pitch: 0, duration: this.deps.flightMs(TILT_MS) });
    if (!map.isMoving()) {
      if (!this.holdsTilt()) map.setMaxPitch(0);
      return;
    }
    map.once("moveend", () => {
      if (!look.current.terrain3d && !this.holdsTilt()) map.setMaxPitch(0);
    });
  }

  private holdsTilt(): boolean {
    return this.deps.holdsTilt?.() ?? false;
  }
}
