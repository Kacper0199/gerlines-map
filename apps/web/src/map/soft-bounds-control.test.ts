import { describe, expect, it, vi } from "vitest";
import { elasticBox, type LngLatLike, softPosition } from "./soft-bounds.ts";
import { attachSoftBounds, EASE_BACK_MS, type SoftBoundsMap } from "./soft-bounds-control.ts";

type Listener = (event: { originalEvent?: unknown }) => void;
type CameraUpdate = (next: { center: LngLatLike }) => { center?: LngLatLike };

const box = elasticBox();
const POINTER = { type: "mousedown" };
const PARIS = { lng: 2.3522, lat: 48.8566 };
const WARSAW = { lng: 21.0122, lat: 52.2297 };

function fakeMap(initial: LngLatLike) {
  const listeners = new Map<string, Set<Listener>>();
  let center = initial;
  let update: CameraUpdate | null = null;
  const easeTo = vi.fn((options: { center: [number, number]; duration: number }) => {
    if (options.duration === 0) {
      center = { lng: options.center[0], lat: options.center[1] };
      fire("movestart");
      fire("moveend");
    }
  });
  function fire(type: string, originalEvent?: unknown) {
    for (const listener of listeners.get(type) ?? []) {
      listener(originalEvent ? { originalEvent } : {});
    }
  }
  const map: SoftBoundsMap = {
    on: (type: string, listener: Listener) => {
      listeners.set(type, (listeners.get(type) ?? new Set()).add(listener));
    },
    off: (type: string, listener: Listener) => {
      listeners.get(type)?.delete(listener);
    },
    getCenter: () => center,
    easeTo,
    setTransformCameraUpdate: (callback: CameraUpdate | null) => {
      update = callback;
    },
  } as unknown as SoftBoundsMap;
  return {
    map,
    easeTo,
    fire,
    request(next: LngLatLike): LngLatLike {
      const shown = update?.({ center: next }).center ?? next;
      center = { lng: shown.lng, lat: shown.lat };
      return center;
    },
    hasUpdate: () => update !== null,
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  };
}

function setup(
  start: LngLatLike,
  options: { reduced?: boolean; selected?: LngLatLike | null } = {},
) {
  const fake = fakeMap(start);
  const bounds = attachSoftBounds(fake.map, {
    reducedMotion: () => options.reduced ?? false,
    selected: () => options.selected ?? null,
    box,
  });
  return { ...fake, bounds };
}

const pastEast = { lng: box.east + 2, lat: 51 };

describe("attachSoftBounds", () => {
  it("does not touch programmatic camera moves, such as a flight to a train", () => {
    const fake = setup({ lng: 10, lat: 51 });
    fake.fire("movestart");

    expect(fake.request(PARIS)).toEqual(PARIS);
    fake.fire("moveend");
    expect(fake.easeTo).not.toHaveBeenCalled();
  });

  it("damps a user drag past the box and eases back with the design curve after release", () => {
    const fake = setup({ lng: 14, lat: 51 });
    fake.fire("movestart", POINTER);
    const shown = fake.request(pastEast);
    fake.fire("moveend", POINTER);

    expect(shown).toEqual(softPosition(pastEast, box));
    expect(fake.easeTo).toHaveBeenCalledTimes(1);
    expect(fake.easeTo.mock.calls[0]?.[0]).toMatchObject({
      center: [box.east, 51],
      duration: EASE_BACK_MS,
      essential: true,
    });
  });

  it("cuts the ease back under reduced motion", () => {
    const fake = setup({ lng: 14, lat: 51 }, { reduced: true });
    fake.fire("movestart", POINTER);
    fake.request(pastEast);
    fake.fire("moveend", POINTER);

    expect(fake.easeTo.mock.calls[0]?.[0]).toMatchObject({ duration: 0 });
    expect(fake.map.getCenter()).toEqual({ lng: box.east, lat: 51 });
  });

  it("keeps damping through the inertial ease, which fires no movestart, and eases back at its end", () => {
    const fake = setup({ lng: 14, lat: 51 });
    fake.fire("movestart", POINTER);
    fake.request({ lng: box.east + 0.5, lat: 51 });
    const inertial = fake.request(pastEast);
    fake.fire("moveend", POINTER);

    expect(inertial).toEqual(softPosition(pastEast, box));
    expect(fake.easeTo).toHaveBeenCalledTimes(1);
  });

  it("ignores a programmatic moveend in the middle of a gesture", () => {
    const fake = setup({ lng: 14, lat: 51 });
    fake.fire("movestart", POINTER);
    fake.request(pastEast);
    fake.fire("moveend");

    expect(fake.easeTo).not.toHaveBeenCalled();
    expect(fake.request(pastEast)).toEqual(softPosition(pastEast, box));
  });

  it("lets a drag that starts in Paris pan from there without a jump or an ease back", () => {
    const fake = setup(PARIS);
    fake.fire("movestart", POINTER);
    const nudged = { lng: PARIS.lng + 0.1, lat: PARIS.lat + 0.1 };

    expect(fake.request(PARIS)).toEqual(PARIS);
    expect(fake.request(nudged)).toEqual(nudged);
    fake.fire("moveend", POINTER);
    expect(fake.easeTo).not.toHaveBeenCalled();
  });

  it("does not ease the camera away from a selected train outside the box", () => {
    const fake = setup(PARIS, { selected: PARIS });
    fake.fire("movestart", POINTER);
    fake.request({ lng: PARIS.lng - 1, lat: PARIS.lat });
    fake.fire("moveend", POINTER);

    expect(fake.easeTo).not.toHaveBeenCalled();
  });

  it("continues the rubber band when a drag interrupts the ease back", () => {
    const fake = setup({ lng: 14, lat: 51 });
    fake.fire("movestart", POINTER);
    const released = fake.request(pastEast);
    fake.fire("moveend", POINTER);
    fake.fire("moveend");
    fake.fire("movestart", POINTER);

    expect(fake.request(released).lng).toBeCloseTo(released.lng, 9);
    const further = fake.request({ lng: released.lng + 1, lat: 51 });
    expect(further.lng - released.lng).toBeLessThan(0.5);
  });

  it("lets a flight go undamped after a drag that ended over a card without a moveend", () => {
    const fake = setup({ lng: 14, lat: 51 });
    fake.fire("movestart", POINTER);
    fake.request(pastEast);
    fake.fire("movestart");

    expect(fake.request(PARIS)).toEqual(PARIS);
  });

  it("lets the map end a gesture before a programmatic jump, so a jump to Warsaw lands there", () => {
    const fake = setup({ lng: 14, lat: 51 });
    fake.fire("movestart", POINTER);
    fake.request(pastEast);
    fake.bounds.endGesture();

    expect(fake.request(WARSAW)).toEqual(WARSAW);
    expect(fake.easeTo).not.toHaveBeenCalled();
  });

  it("removes its listeners and the camera hook when detached", () => {
    const fake = setup({ lng: 10, lat: 51 });
    fake.bounds.detach();

    expect(fake.listenerCount()).toBe(0);
    expect(fake.hasUpdate()).toBe(false);
  });
});
