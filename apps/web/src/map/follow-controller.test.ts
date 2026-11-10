import { describe, expect, it, vi } from "vitest";
import { FollowController, type FollowMap, type FollowSelected } from "./follow-controller.ts";

const PADDING = { top: 24, bottom: 72, left: 412, right: 248 };
const PATH = Float32Array.from([8, 48, 9, 49, 10, 50, 11, 51]);
const SELECTED: FollowSelected = { lon: 9.5, lat: 49.5, vertex: 1, legKey: "3/7" };
const ROUTE = { legKey: "3/7", path: PATH };

function setup(
  over: {
    moving?: boolean;
    camera?: object | undefined;
    followPitch?: number;
    routePitch?: number;
    followPadding?: typeof PADDING;
  } = {},
) {
  let now = 1000;
  const calls: string[] = [];
  const once: (() => void)[] = [];
  const map: FollowMap = {
    jumpTo: vi.fn(() => calls.push("jumpTo")),
    easeTo: vi.fn(() => calls.push("easeTo")),
    setPadding: vi.fn(() => calls.push("setPadding")),
    cameraForBounds: vi.fn(() => {
      calls.push("cameraForBounds");
      return "camera" in over ? over.camera : { center: [10, 49], zoom: 7 };
    }) as FollowMap["cameraForBounds"],
    isMoving: vi.fn(() => over.moving ?? false),
    getZoom: () => 8,
    onceMoveEnd: (callback) => {
      once.push(callback);
    },
  };
  const onFollowEnd = vi.fn();
  const controller = new FollowController({
    map,
    padding: () => PADDING,
    ...(over.followPadding ? { followPadding: () => over.followPadding as typeof PADDING } : {}),
    followPitch: () => over.followPitch,
    routePitch: () => over.routePitch,
    flightMs: (ms) => ms,
    endGesture: vi.fn(),
    onFollowEnd,
    now: () => now,
  });
  return {
    controller,
    map,
    calls,
    onFollowEnd,
    once,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

describe("FollowController following", () => {
  it("eases to the train when Follow starts, then jumps to it on every frame", () => {
    const t = setup();
    t.controller.setFollowing(true, SELECTED);
    expect(t.map.easeTo).toHaveBeenCalledWith(
      expect.objectContaining({ center: [9.5, 49.5], padding: PADDING, duration: 600 }),
    );
    t.controller.frame(SELECTED, undefined, false);
    expect(t.map.jumpTo).not.toHaveBeenCalled();
    t.once[0]?.();
    t.controller.frame(SELECTED, undefined, false);
    expect(t.map.jumpTo).toHaveBeenCalledWith({ center: [9.5, 49.5] });
  });

  it("does not jump while the map is moving, so zoom buttons, keys and double click finish", () => {
    const t = setup({ moving: true });
    t.controller.setFollowing(true, SELECTED);
    t.once[0]?.();
    t.controller.frame(SELECTED, undefined, false);
    expect(t.map.jumpTo).not.toHaveBeenCalled();
  });

  it("does not jump while a pointer is down and resumes when it is up", () => {
    const t = setup();
    t.controller.setFollowing(true, SELECTED);
    t.once[0]?.();
    t.controller.pointerDown(1);
    t.controller.frame(SELECTED, undefined, false);
    expect(t.map.jumpTo).not.toHaveBeenCalled();
    t.controller.pointerUp(1);
    t.controller.frame(SELECTED, undefined, false);
    expect(t.map.jumpTo).toHaveBeenCalledTimes(1);
  });

  it("does not jump within 250 ms of a wheel turn", () => {
    const t = setup();
    t.controller.setFollowing(true, SELECTED);
    t.once[0]?.();
    t.controller.wheel();
    t.tick(200);
    t.controller.frame(SELECTED, undefined, false);
    expect(t.map.jumpTo).not.toHaveBeenCalled();
    t.tick(60);
    t.controller.frame(SELECTED, undefined, false);
    expect(t.map.jumpTo).toHaveBeenCalledTimes(1);
  });

  it("does not jump before the first flight to a new selection is done or without a selected frame", () => {
    const t = setup();
    t.controller.setFollowing(true, SELECTED);
    t.once[0]?.();
    t.controller.frame(SELECTED, undefined, true);
    t.controller.frame(null, undefined, false);
    expect(t.map.jumpTo).not.toHaveBeenCalled();
  });

  it("ends when the map is dragged or panned with an arrow key, not by zoom keys", () => {
    const t = setup();
    t.controller.setFollowing(true, SELECTED);
    t.controller.moveStart({ key: "+" });
    t.controller.moveStart(undefined);
    expect(t.onFollowEnd).not.toHaveBeenCalled();
    t.controller.moveStart({ key: "ArrowLeft" });
    expect(t.onFollowEnd).toHaveBeenCalledTimes(1);
    expect(t.controller.isFollowing).toBe(false);
    t.controller.setFollowing(true, SELECTED);
    t.controller.dragStart();
    expect(t.onFollowEnd).toHaveBeenCalledTimes(2);
  });

  it("starts without a train in a frame and eases in on the first frame that has one", () => {
    const t = setup();
    t.controller.setFollowing(true, null);
    expect(t.map.easeTo).not.toHaveBeenCalled();
    t.controller.frame(SELECTED, undefined, false);
    expect(t.map.easeTo).toHaveBeenCalledTimes(1);
  });

  it("forgets everything when the selection changes", () => {
    const t = setup();
    t.controller.setFollowing(true, SELECTED);
    t.controller.showRoute(SELECTED, undefined);
    t.controller.reset();
    expect(t.controller.isFollowing).toBe(false);
    t.controller.frame(SELECTED, ROUTE, false);
    expect(t.map.cameraForBounds).not.toHaveBeenCalled();
  });
});

describe("FollowController tilt", () => {
  it("settles Follow at least at the selection zoom, at the pitch and padding it is given", () => {
    const chase = { ...PADDING, top: 200 };
    const t = setup({ followPitch: 55, followPadding: chase });
    t.controller.setFollowing(true, SELECTED);
    expect(t.map.easeTo).toHaveBeenCalledWith(
      expect.objectContaining({ zoom: 11.5, pitch: 55, padding: chase }),
    );
  });

  it("leaves the pitch out of Follow when none is given", () => {
    const t = setup();
    t.controller.setFollowing(true, SELECTED);
    expect(t.map.easeTo).toHaveBeenCalledWith(
      expect.not.objectContaining({ pitch: expect.anything() }),
    );
  });

  it("fits the route at the route pitch, with the plain card padding", () => {
    const t = setup({ routePitch: 0, followPadding: { ...PADDING, top: 200 } });
    t.controller.showRoute(SELECTED, ROUTE);
    expect(t.map.easeTo).toHaveBeenCalledWith(
      expect.objectContaining({ pitch: 0, padding: PADDING }),
    );
  });
});

describe("FollowController route", () => {
  it("fits the route ahead with the card padding set on the map and only a margin as option", () => {
    const t = setup();
    t.controller.showRoute(SELECTED, ROUTE);
    expect(t.calls).toEqual(["setPadding", "cameraForBounds", "easeTo"]);
    expect(t.map.setPadding).toHaveBeenCalledWith(PADDING);
    expect(t.map.cameraForBounds).toHaveBeenCalledWith(
      [
        [9.5, 49.5],
        [11, 51],
      ],
      { padding: { top: 56, bottom: 104, left: 32, right: 32 }, maxZoom: 14 },
    );
    expect(t.map.easeTo).toHaveBeenCalledWith(
      expect.objectContaining({ center: [10, 49], zoom: 7, padding: PADDING }),
    );
  });

  it("waits for the route when it is not known yet and fits once when it arrives", () => {
    const t = setup();
    t.controller.showRoute(SELECTED, undefined);
    expect(t.map.easeTo).not.toHaveBeenCalled();
    t.controller.frame(SELECTED, { legKey: "other", path: PATH }, false);
    expect(t.map.easeTo).not.toHaveBeenCalled();
    t.controller.frame(SELECTED, ROUTE, false);
    t.controller.frame(SELECTED, ROUTE, false);
    expect(t.map.easeTo).toHaveBeenCalledTimes(1);
  });

  it("ends Follow when it fits", () => {
    const t = setup();
    t.controller.setFollowing(true, SELECTED);
    t.controller.showRoute(SELECTED, ROUTE);
    expect(t.onFollowEnd).toHaveBeenCalledTimes(1);
    expect(t.controller.isFollowing).toBe(false);
  });

  it("does not let a Route pressed earlier end a Follow started since", () => {
    const t = setup();
    t.controller.showRoute(SELECTED, undefined);
    t.controller.setFollowing(true, SELECTED);
    t.once[0]?.();
    t.controller.frame(SELECTED, ROUTE, false);
    expect(t.map.cameraForBounds).not.toHaveBeenCalled();
    expect(t.controller.isFollowing).toBe(true);
    expect(t.onFollowEnd).not.toHaveBeenCalled();
  });

  it("gives up quietly when the map has no camera for the bounds", () => {
    const t = setup({ camera: undefined });
    t.controller.showRoute(SELECTED, ROUTE);
    expect(t.map.easeTo).not.toHaveBeenCalled();
  });
});
