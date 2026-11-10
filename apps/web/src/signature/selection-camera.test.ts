import { describe, expect, it, vi } from "vitest";
import { SELECT_MIN_ZOOM, SELECT_PITCH, TILT_MAX_PITCH } from "../map/camera-constants.ts";
import { TERRAIN_PITCH } from "../map/terrain/relief-control.ts";
import { SelectionCamera, type SignatureMap } from "./selection-camera.ts";

const PADDING = { top: 24, bottom: 72, left: 412, right: 248 };
const TRAIN = { lon: 8.68, lat: 50.11, bearing: 90 };

function setup(
  over: {
    reduced?: boolean;
    tilt?: boolean;
    terrain?: boolean;
    pitch?: number;
    zoom?: number;
  } = {},
) {
  const state = { pitch: over.pitch ?? 0, zoom: over.zoom ?? 5.6, maxPitch: over.terrain ? 60 : 0 };
  const calls: [string, unknown][] = [];
  const once: (() => void)[] = [];
  const map: SignatureMap = {
    getCenter: () => ({ lng: 10, lat: 51 }),
    getZoom: () => state.zoom,
    getPitch: () => state.pitch,
    setMaxPitch: vi.fn((pitch: number) => {
      state.maxPitch = pitch;
      calls.push(["setMaxPitch", pitch]);
    }),
    jumpTo: vi.fn((options) => {
      calls.push(["jumpTo", options]);
    }),
    easeTo: vi.fn((options) => {
      calls.push(["easeTo", options]);
    }),
    flyTo: vi.fn((options) => {
      calls.push(["flyTo", options]);
    }),
    onceMoveEnd: (callback) => {
      once.push(callback);
    },
  };
  const fade = vi.fn();
  const camera = new SelectionCamera({
    map,
    viewport: () => ({ width: 1440, height: 900 }),
    padding: () => PADDING,
    reducedMotion: () => over.reduced ?? false,
    tilt: () => over.tilt ?? true,
    terrain3d: () => over.terrain ?? false,
    endGesture: vi.fn(),
    fade,
    now: () => 5000,
    maxZoom: 17,
  });
  return { camera, map, state, calls, once, fade };
}

describe("SelectionCamera.go", () => {
  it("lifts the pitch limit before it flies to the train tilted and closer in", () => {
    const t = setup();
    const flight = t.camera.go(TRAIN);
    expect(t.calls[0]).toEqual(["setMaxPitch", TILT_MAX_PITCH]);
    expect(t.map.flyTo).toHaveBeenCalledWith(
      expect.objectContaining({
        center: [8.68, 50.11],
        zoom: SELECT_MIN_ZOOM,
        pitch: SELECT_PITCH,
        padding: PADDING,
      }),
    );
    expect(flight.durationMs).toBeGreaterThanOrEqual(700);
    expect(flight.startedAt).toBe(5000);
    expect(flight.reachMetres).toBeGreaterThan(10_000);
  });

  it("eases for a train in the view", () => {
    const t = setup({ zoom: 13 });
    t.camera.go({ ...TRAIN, lon: 10.001, lat: 51.001 });
    expect(t.map.easeTo).toHaveBeenCalledWith(
      expect.objectContaining({ zoom: 13, pitch: SELECT_PITCH }),
    );
    expect(t.map.flyTo).not.toHaveBeenCalled();
  });

  it("cuts with a fade under reduced motion, and flies nowhere", () => {
    const t = setup({ reduced: true });
    const flight = t.camera.go(TRAIN);
    expect(flight.durationMs).toBe(0);
    expect(t.map.flyTo).not.toHaveBeenCalled();
    expect(t.map.easeTo).not.toHaveBeenCalled();
    expect(t.map.jumpTo).toHaveBeenCalledWith(
      expect.objectContaining({ center: [8.68, 50.11], pitch: SELECT_PITCH }),
    );
    expect(t.fade).toHaveBeenCalledTimes(1);
  });

  it("leaves the pitch alone when the tilt is switched off", () => {
    const t = setup({ tilt: false });
    t.camera.go(TRAIN);
    expect(t.map.setMaxPitch).not.toHaveBeenCalledWith(TILT_MAX_PITCH);
    expect(t.map.flyTo).toHaveBeenCalledWith(expect.objectContaining({ pitch: 0 }));
  });

  it("shifts the train off the middle of the free area for a north or south heading", () => {
    const t = setup();
    t.camera.go({ ...TRAIN, bearing: 0 });
    const options = (t.map.flyTo as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(options.padding.top).toBeGreaterThan(PADDING.top);
  });
});

describe("SelectionCamera.release", () => {
  it("eases back to a flat map after a selection tilted it, then drops the pitch limit", () => {
    const t = setup();
    t.camera.go(TRAIN);
    t.state.pitch = SELECT_PITCH;
    t.camera.release();
    expect(t.map.easeTo).toHaveBeenLastCalledWith(
      expect.objectContaining({ pitch: 0, duration: 600 }),
    );
    t.state.pitch = 0;
    t.once[0]?.();
    expect(t.map.setMaxPitch).toHaveBeenLastCalledWith(0);
  });

  it("goes back to the tilt the relief had before the selection", () => {
    const t = setup({ terrain: true, pitch: 50 });
    t.camera.go(TRAIN);
    t.state.pitch = SELECT_PITCH;
    t.camera.release();
    expect(t.map.easeTo).toHaveBeenLastCalledWith(expect.objectContaining({ pitch: 50 }));
    expect(t.once).toHaveLength(0);
  });

  it("does nothing when no selection tilted the map", () => {
    const t = setup();
    t.camera.release();
    expect(t.map.easeTo).not.toHaveBeenCalled();
  });

  it("keeps the pitch the map had before the first selection across a change of train", () => {
    const t = setup();
    t.camera.go(TRAIN);
    t.state.pitch = SELECT_PITCH;
    t.camera.go({ ...TRAIN, lon: 9 });
    t.camera.release();
    expect(t.map.easeTo).toHaveBeenLastCalledWith(expect.objectContaining({ pitch: 0 }));
  });

  it("does not drop the pitch limit when another selection tilted the map again meanwhile", () => {
    const t = setup();
    t.camera.go(TRAIN);
    t.state.pitch = SELECT_PITCH;
    t.camera.release();
    t.camera.go({ ...TRAIN, lon: 9 });
    t.state.pitch = 0;
    (t.map.setMaxPitch as ReturnType<typeof vi.fn>).mockClear();
    t.once[0]?.();
    expect(t.map.setMaxPitch).not.toHaveBeenCalled();
  });

  it("cuts the pitch back under reduced motion", () => {
    const t = setup({ reduced: true });
    t.camera.go(TRAIN);
    t.state.pitch = SELECT_PITCH;
    t.camera.release();
    expect(t.map.easeTo).not.toHaveBeenCalled();
    expect(t.map.jumpTo).toHaveBeenLastCalledWith({ pitch: 0 });
  });
});

describe("SelectionCamera interruptions", () => {
  it("drops the pitch limit whatever the pitch when an interrupted tilt-back ends", () => {
    const t = setup();
    t.camera.go(TRAIN);
    t.state.pitch = SELECT_PITCH;
    t.camera.release();
    t.state.pitch = 30;
    t.once[0]?.();
    expect(t.map.setMaxPitch).toHaveBeenLastCalledWith(0);
  });

  it("does not keep a tilt the switch was turned off for when a selection follows an interrupted tilt-back", () => {
    const t = setup({ tilt: false });
    t.state.pitch = 25;
    t.state.maxPitch = TILT_MAX_PITCH;
    t.camera.go(TRAIN);
    expect(t.map.flyTo).toHaveBeenCalledWith(expect.objectContaining({ pitch: 0 }));
    t.once[0]?.();
    expect(t.map.setMaxPitch).toHaveBeenLastCalledWith(0);
  });

  it("returns Terrain 3D to the pitch of the relief, not to the pitch saved before it was on", () => {
    const t = setup({ terrain: true, pitch: 0 });
    t.camera.go(TRAIN);
    t.state.pitch = SELECT_PITCH;
    t.camera.release();
    expect(t.map.easeTo).toHaveBeenLastCalledWith(
      expect.objectContaining({ pitch: TERRAIN_PITCH }),
    );
  });

  it("keeps the relief pitch with the tilt off", () => {
    const t = setup({ terrain: true, pitch: 50, tilt: false });
    t.camera.go(TRAIN);
    expect(t.map.flyTo).toHaveBeenCalledWith(expect.objectContaining({ pitch: TERRAIN_PITCH }));
  });

  it("says whether a selection holds the tilt", () => {
    const t = setup();
    expect(t.camera.holdsTilt).toBe(false);
    t.camera.go(TRAIN);
    expect(t.camera.holdsTilt).toBe(true);
    t.camera.release();
    expect(t.camera.holdsTilt).toBe(false);
  });

  it("keeps the camera north up", () => {
    const t = setup();
    t.camera.go(TRAIN);
    expect(t.map.flyTo).toHaveBeenCalledWith(expect.objectContaining({ bearing: 0 }));
  });

  it("skips the fade of a cut when the camera is already there", () => {
    const t = setup({ reduced: true, zoom: SELECT_MIN_ZOOM, pitch: SELECT_PITCH });
    t.camera.go({ lon: 10, lat: 51, bearing: 90 });
    expect(t.fade).not.toHaveBeenCalled();
    const far = setup({ reduced: true, zoom: SELECT_MIN_ZOOM, pitch: SELECT_PITCH });
    far.camera.go({ lon: 10.2, lat: 51, bearing: 90 });
    expect(far.fade).toHaveBeenCalledTimes(1);
  });
});

describe("SelectionCamera follow and route helpers", () => {
  it("gives Follow the selection pitch and lifts the limit", () => {
    const t = setup();
    expect(t.camera.holdFollowPitch()).toBe(SELECT_PITCH);
    expect(t.map.setMaxPitch).toHaveBeenCalledWith(TILT_MAX_PITCH);
  });

  it("gives Follow nothing when the tilt is off", () => {
    const t = setup({ tilt: false });
    expect(t.camera.holdFollowPitch()).toBeUndefined();
  });

  it("flattens the map for Route unless the relief is tilted", () => {
    expect(setup().camera.routePitch()).toBe(0);
    expect(setup({ terrain: true }).camera.routePitch()).toBeUndefined();
  });
});
