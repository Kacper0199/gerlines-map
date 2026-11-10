import { describe, expect, it } from "vitest";
import { cameraMatches, planSlotEase, SlotEase } from "./slot-ease.ts";

const STACKED = { top: 372, bottom: 72, left: 16, right: 16 };
const DESKTOP = { top: 24, bottom: 72, left: 412, right: 248 };
const SLOT = { top: 372, bottom: 72, left: 392, right: 16 };

describe("cameraMatches", () => {
  const target = { center: { lng: 10.45, lat: 51.16 }, zoom: 5.4 };

  it("accepts the same camera and a rounding difference", () => {
    expect(cameraMatches(target, target)).toBe(true);
    expect(cameraMatches({ center: { lng: 10.451, lat: 51.159 }, zoom: 5.41 }, target)).toBe(true);
  });

  it("rejects a camera the user zoomed or panned", () => {
    expect(cameraMatches({ ...target, zoom: 6.2 }, target)).toBe(false);
    expect(cameraMatches({ center: { lng: 11.9, lat: 51.16 }, zoom: 5.4 }, target)).toBe(false);
    expect(cameraMatches({ center: { lng: 10.45, lat: 50.2 }, zoom: 5.4 }, target)).toBe(false);
  });
});

describe("planSlotEase", () => {
  const base = { before: STACKED, after: DESKTOP, atOverview: true, refit: true };

  it("eases to the slot padding when a panel opens over the untouched overview", () => {
    expect(planSlotEase(base)).toBe("ease");
  });

  it("eases back to the stacked padding when the panel closes over the eased overview", () => {
    expect(planSlotEase({ ...base, before: DESKTOP, after: STACKED })).toBe("ease");
  });

  it("leaves a view the user moved", () => {
    expect(planSlotEase({ ...base, atOverview: false })).toBe("stay");
  });

  it("leaves the camera to a card that flies to its own target", () => {
    expect(planSlotEase({ ...base, refit: false })).toBe("stay");
  });

  it("does nothing where the padding does not change", () => {
    expect(planSlotEase({ ...base, before: DESKTOP, after: DESKTOP })).toBe("stay");
  });
});

describe("SlotEase with a fake map", () => {
  const OVERVIEW: Record<string, { center: { lng: number; lat: number }; zoom: number }> = {
    stacked: { center: { lng: 10.45, lat: 52.86 }, zoom: 5.4 },
    slot: { center: { lng: 6.4, lat: 53.3 }, zoom: 5.03 },
  };
  const nameOf = (padding: typeof STACKED) => (padding === STACKED ? "stacked" : "slot");

  function setup(duration = 900) {
    const state = {
      camera: OVERVIEW.stacked as { center: { lng: number; lat: number }; zoom: number },
      moving: false,
      fits: [] as Array<{ padding: string; duration: number }>,
      idle: [] as Array<() => void>,
      gestures: 0,
    };
    const ease = new SlotEase({
      camera: () => state.camera,
      target: (padding) => OVERVIEW[nameOf(padding as typeof STACKED)],
      fit: (padding, ms) => {
        state.fits.push({ padding: nameOf(padding as typeof STACKED), duration: ms });
        state.moving = ms > 0;
        state.camera = { center: { lng: 0, lat: 0 }, zoom: 1 };
      },
      isMoving: () => state.moving,
      onceIdle: (callback) => state.idle.push(callback),
      endGesture: () => {
        state.gestures += 1;
      },
      duration: () => duration,
    });
    const finishEase = (to: string) => {
      state.moving = false;
      state.camera = OVERVIEW[to] as never;
      for (const callback of state.idle.splice(0)) callback();
    };
    return { state, ease, finishEase };
  }

  const open = { before: STACKED, after: SLOT, refit: true, selected: false };
  const close = { before: SLOT, after: STACKED, refit: true, selected: false };

  it("flies to the slot overview when a panel opens over the untouched overview", () => {
    const { state, ease } = setup();
    ease.change(open);
    expect(state.fits).toEqual([{ padding: "slot", duration: 900 }]);
    expect(state.gestures).toBe(1);
  });

  it("flies back when the panel closes over the settled slot overview", () => {
    const { state, ease, finishEase } = setup();
    ease.change(open);
    finishEase("slot");
    ease.change(close);
    expect(state.fits.map((fit) => fit.padding)).toEqual(["slot", "stacked"]);
  });

  it("retargets a quick toggle instead of leaving the first ease running to the wrong overview", () => {
    const { state, ease } = setup();
    ease.change(open);
    ease.change(close);
    expect(state.fits.map((fit) => fit.padding)).toEqual(["slot", "stacked"]);
  });

  it("leaves the camera where the user put it when a gesture ended the ease", () => {
    const { state, ease } = setup();
    ease.change(open);
    state.moving = false;
    state.camera = { center: { lng: 8.5, lat: 51.0 }, zoom: 7 };
    for (const callback of state.idle.splice(0)) callback();
    ease.change(close);
    expect(state.fits).toHaveLength(1);
  });

  it("does not refit a view the user had moved before the panel opened", () => {
    const { state, ease } = setup();
    state.camera = { center: { lng: 8.5, lat: 51.0 }, zoom: 8 };
    ease.change(open);
    expect(state.fits).toHaveLength(0);
  });

  it("leaves a selected train and a card to their own flights", () => {
    const { state, ease } = setup();
    ease.change({ ...open, selected: true });
    ease.change({ ...open, refit: false });
    expect(state.fits).toHaveLength(0);
  });

  it("is not left easing when the motion is reduced to a cut, so the next toggle compares the camera", () => {
    const { state, ease } = setup(0);
    ease.change(open);
    state.camera = OVERVIEW.slot as never;
    ease.change(close);
    expect(state.fits.map((fit) => fit.padding)).toEqual(["slot", "stacked"]);
    state.camera = { center: { lng: 8.5, lat: 51.0 }, zoom: 7 };
    ease.change(open);
    expect(state.fits).toHaveLength(2);
  });
});
