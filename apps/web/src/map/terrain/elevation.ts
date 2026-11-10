const DEGREES = 180 / Math.PI;

/** How trains are lifted to the relief: the factor on the baked shape heights and a small lift above the surface. */
export interface Elevation {
  /** 0 on a flat map (trains at sea level), else the exaggeration of the 3D terrain. */
  readonly scale: number;
  /** Metres added above the surface so that a train does not sink into a coarser terrain mesh. */
  readonly liftM: number;
}

export const FLAT: Elevation = { scale: 0, liftM: 0 };

/** Screen pixels a marker or route line is raised above the relief, so a coarser terrain mesh does not cover it. */
export const TRAIN_LIFT_PX = 3;
/** Lift of the cars, ground metres: the mesh under a car is as fine as the DEM, so it only avoids fighting depth. */
export const CAR_LIFT_M = 0.5;

const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
const TILE_PX = 512;

/** Ground metres one screen pixel spans at a zoom and latitude (degrees). */
export function metresPerPixel(zoom: number, latDeg: number): number {
  return (EARTH_CIRCUMFERENCE_M * Math.cos((latDeg * Math.PI) / 180)) / (TILE_PX * 2 ** zoom);
}

/**
 * The terrain mesh follows the DEM (zoom 12 at most) at two samples per mesh cell, so on a steep wall
 * it cuts a marker standing on the baked height by up to this many metres. The cut shrinks as the
 * zoom grows, because the tiles on screen get smaller and the mesh finer.
 */
export const MESH_LIFT_M = 30;
const MESH_LIFT_FULL_ZOOM = 13;
const MESH_LIFT_NONE_ZOOM = 15;
const MAX_LIFT_PITCH_DEG = 60;

/**
 * The lift of markers and route lines at a view: a few pixels of the ground at the view centre,
 * stretched by the tilt because the far half of a pitched view is coarser, and never below what the
 * mesh can cut at that zoom.
 */
export function markerLiftM(zoom: number, latDeg: number, pitchDeg = 0): number {
  const pitch = (Math.min(Math.max(pitchDeg, 0), MAX_LIFT_PITCH_DEG) * Math.PI) / 180;
  const pixels = (TRAIN_LIFT_PX * metresPerPixel(zoom, latDeg)) / Math.cos(pitch);
  const fade = (MESH_LIFT_NONE_ZOOM - zoom) / (MESH_LIFT_NONE_ZOOM - MESH_LIFT_FULL_ZOOM);
  return Math.max(pixels, MESH_LIFT_M * Math.min(Math.max(fade, 0), 1));
}

/** The elevation of trains on 3D terrain with the given exaggeration; a scale that is not positive is flat. */
export function terrainElevation(exaggeration: number, liftM = 0): Elevation {
  if (!(exaggeration > 0) || !Number.isFinite(exaggeration)) return FLAT;
  return { scale: exaggeration, liftM };
}

/** The same relief for the 3D cars: they lift by `CAR_LIFT_M` instead of the marker lift. */
export function carElevation(elevation: Elevation): Elevation {
  return elevation.scale === 0 ? FLAT : { scale: elevation.scale, liftM: CAR_LIFT_M };
}

/** Height of a train in the map's units: the baked shape height (metres above sea level) on the relief. */
export function drawnHeight(bakedZ: number, elevation: Elevation): number {
  if (elevation.scale === 0) return 0;
  const z = Number.isFinite(bakedZ) ? bakedZ : 0;
  return z * elevation.scale + elevation.liftM;
}

/**
 * Pitch of a car body in degrees, positive when the front is higher, from the height difference `dz`
 * of its two pivots (rear minus front, baked metres) over their along-track distance. On a flat map
 * it is the real grade; on terrain the exaggerated one, so a car lies on the relief it is drawn on.
 */
export function gradeAngleDeg(dz: number, span: number, elevation: Elevation): number {
  if (elevation.scale === 0) {
    return Math.asin(Math.max(-1, Math.min(1, span > 0 ? -dz / span : 0))) * DEGREES;
  }
  return Math.atan2(-dz * elevation.scale, span) * DEGREES;
}

/** Metres the ground may stand above the car base before the cover starts: the DEM and the baked track height disagree by about this much. */
export const COVER_DEADBAND_M = 1;
/** Metres over which the cover grows from 0 to 1: a car is about 4 m high, so the ground that high above its base buries it. */
export const COVER_RAMP_M = 4;

/**
 * How far the relief hides the cars of a train whose base is at `carBase` (drawn metres) from 0 (they
 * stand on or above the ground) to 1 (they are buried, as inside a tunnel under a ridge). `ground` is
 * the height of the relief as drawn there. While it is not known, the relief drawn there may still hide
 * the depth tested cars (MapLibre draws a tile from its parent's DEM until its own arrives), so it
 * counts as covered: a chevron over visible cars costs nothing for a moment.
 */
export function reliefCover(ground: number | null | undefined, carBase: number): number {
  if (!Number.isFinite(carBase)) return 0;
  if (typeof ground !== "number" || !Number.isFinite(ground)) return 1;
  return Math.min(1, Math.max(0, (ground - carBase - COVER_DEADBAND_M) / COVER_RAMP_M));
}

export type DrawnGround = (lon: number, lat: number) => number | null | undefined;

/**
 * The cover of the selected train's cars: its drawn height (`z`, which includes the marker `lift`)
 * brought down to the car base, against the relief at its position. Zero without the relief or
 * without a map terrain to ask.
 */
export function selectedCover(
  ground: DrawnGround | undefined,
  selected: { readonly lon: number; readonly lat: number; readonly z: number },
  lift: number,
  terrain3d: boolean,
): number {
  if (!(terrain3d && ground)) return 0;
  return reliefCover(ground(selected.lon, selected.lat), selected.z - lift + CAR_LIFT_M);
}
