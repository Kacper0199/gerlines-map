/** Where the camera tilts to on a selection: steep enough to read depth, shallow enough to keep the horizon off screen. */
export const SELECT_PITCH = 55;
/** The map's pitch limit while a selection holds the tilt (MapLibre allows 60). */
export const TILT_MAX_PITCH = 60;
/** A selection closes in to at least this zoom: chevrons are full size and a few kilometres of route show on both sides. */
export const SELECT_MIN_ZOOM = 11.5;
