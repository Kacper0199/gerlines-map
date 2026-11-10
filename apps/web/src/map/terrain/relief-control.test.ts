import { describe, expect, it } from "vitest";
import { ReliefControl } from "./relief-control.ts";

function setup(
  initial: { style: "dark" | "light" | "terrain" | "satellite"; terrain3d: boolean },
  holds = { tilt: false },
  flight = (ms: number) => ms,
) {
  const log: string[] = [];
  const state = { ...initial, pitch: 0, maxPitch: 0, moving: false, stillMoves: false };
  let moveEnd: (() => void) | undefined;
  const look = {
    get current() {
      return { style: state.style, terrain3d: state.terrain3d };
    },
    update(patch: Partial<typeof initial>) {
      Object.assign(state, patch);
      log.push(`look ${JSON.stringify(patch)}`);
    },
  };
  const map = {
    getPitch: () => state.pitch,
    setMaxPitch: (value: number) => {
      state.maxPitch = value;
      log.push(`max ${value}`);
    },
    easeTo: (options: { pitch: number; duration: number }) => {
      log.push(`ease ${options.pitch} ${options.duration}`);
      state.pitch = options.pitch;
      state.moving = options.duration > 0 || state.stillMoves;
    },
    isMoving: () => state.moving,
    once: (_event: "moveend", callback: () => void) => {
      moveEnd = callback;
    },
  };
  const control = new ReliefControl({
    map,
    look,
    setElevation: (scale) => log.push(`elevation ${scale}`),
    flightMs: flight,
    holdsTilt: () => holds.tilt,
  });
  return {
    control,
    holds,
    log,
    state,
    finishMove: () => {
      state.moving = false;
      moveEnd?.();
    },
  };
}

describe("ReliefControl", () => {
  it("lifts the trains by the exaggeration and tilts the map when the relief goes on", () => {
    const t = setup({ style: "terrain", terrain3d: false });
    t.control.setTerrain3d(true);

    expect(t.log).toEqual(['look {"terrain3d":true}', "elevation 1.5", "max 60", "ease 50 900"]);
  });

  it("puts the trains back at sea level when the style leaves Terrain", () => {
    const t = setup({ style: "terrain", terrain3d: true });
    t.state.pitch = 50;
    t.state.maxPitch = 60;
    t.control.setStyle("dark");

    expect(t.log).toEqual(["ease 0 900", 'look {"style":"dark","terrain3d":false}', "elevation 0"]);
    expect(t.state.terrain3d).toBe(false);
    t.finishMove();
    expect(t.state.maxPitch).toBe(0);
  });

  it("keeps the relief when the style stays Terrain and does nothing twice", () => {
    const t = setup({ style: "terrain", terrain3d: true });
    t.control.setStyle("terrain");
    expect(t.log).toEqual(['look {"style":"terrain","terrain3d":true}', "elevation 1.5"]);

    t.control.setTerrain3d(true);
    expect(t.log).toHaveLength(2);
  });

  it("ignores the relief request in a style that cannot show it", () => {
    const t = setup({ style: "dark", terrain3d: false });
    t.control.setTerrain3d(true);
    expect(t.log).toEqual([]);
  });

  it("does not tilt a flat map back and only locks its pitch", () => {
    const t = setup({ style: "terrain", terrain3d: true });
    t.control.setTerrain3d(false);
    expect(t.log).toEqual(['look {"terrain3d":false}', "elevation 0", "max 0"]);
  });

  it("keeps the pitch lock when the relief came back before the tilt ended", () => {
    const t = setup({ style: "terrain", terrain3d: true });
    t.state.pitch = 50;
    t.control.setTerrain3d(false);
    t.control.setTerrain3d(true);
    t.state.maxPitch = 60;
    t.finishMove();
    expect(t.state.maxPitch).toBe(60);
  });

  it("tells the worker the exaggeration at the start when the map was built with the relief on", () => {
    const on = setup({ style: "terrain", terrain3d: true });
    on.control.start();
    expect(on.log).toEqual(["elevation 1.5"]);

    const off = setup({ style: "light", terrain3d: false });
    off.control.start();
    expect(off.log).toEqual(["elevation 0"]);
  });

  it("does not rebuild the style for the settings the map was built with", () => {
    const t = setup({ style: "terrain", terrain3d: true });
    t.control.setStyle("terrain");
    t.control.setTerrain3d(true);
    expect(t.log.filter((entry) => entry.startsWith("look")).length).toBe(1);
  });

  it("keeps the tilt and the pitch limit a selection holds when the style changes between flat styles", () => {
    const t = setup({ style: "dark", terrain3d: false }, { tilt: true });
    t.state.pitch = 55;
    t.state.maxPitch = 60;
    t.control.setStyle("light");
    expect(t.log.some((entry) => entry.startsWith("ease"))).toBe(false);
    expect(t.state.maxPitch).toBe(60);
  });

  it("does not drop the pitch limit at the end of a move when a selection holds the tilt by then", () => {
    const t = setup({ style: "terrain", terrain3d: true });
    t.state.pitch = 50;
    t.state.maxPitch = 60;
    t.control.setStyle("dark");
    t.holds.tilt = true;
    t.finishMove();
    expect(t.state.maxPitch).toBe(60);
  });

  it("drops the pitch limit when the tilt back is a cut, which ends before a listener could wait for it", () => {
    const t = setup({ style: "terrain", terrain3d: true }, { tilt: false }, () => 0);
    t.state.pitch = 50;
    t.state.maxPitch = 60;
    t.control.setTerrain3d(false);
    expect(t.state.pitch).toBe(0);
    expect(t.state.maxPitch).toBe(0);
  });

  it("drops the pitch limit at once when the style leaves Terrain and the tilt back is a cut", () => {
    const t = setup({ style: "terrain", terrain3d: true }, { tilt: false }, () => 0);
    t.state.pitch = 50;
    t.state.maxPitch = 60;
    t.control.setStyle("dark");
    expect(t.state.maxPitch).toBe(0);
  });

  it("keeps the tilt and the pitch limit a selection holds when the relief goes off", () => {
    const t = setup({ style: "terrain", terrain3d: true }, { tilt: true }, () => 0);
    t.state.pitch = 50;
    t.state.maxPitch = 60;
    t.control.setTerrain3d(false);
    expect(t.log.some((entry) => entry.startsWith("ease"))).toBe(false);
    expect(t.state.pitch).toBe(50);
    expect(t.state.maxPitch).toBe(60);
    expect(t.log).toContain("elevation 0");
  });

  it("waits for moveend when the map is still moving after the ease, whatever the duration asked", () => {
    const t = setup({ style: "terrain", terrain3d: true }, { tilt: false }, () => 0);
    t.state.pitch = 50;
    t.state.maxPitch = 60;
    t.state.stillMoves = true;
    t.control.setTerrain3d(false);
    expect(t.state.maxPitch).toBe(60);
    t.finishMove();
    expect(t.state.maxPitch).toBe(0);
  });
});
