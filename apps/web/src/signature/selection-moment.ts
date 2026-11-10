import type { SplitRoute } from "../map/route-split.ts";
import { drawStart, RouteDraw } from "./route-draw.ts";
import { RouteReveal } from "./route-reveal.ts";
import type { Flight, SelectedPlace } from "./selection-camera.ts";

/** The selected train of a worker frame, as far as the signature moment needs it. */
export interface MomentFrame extends SelectedPlace {
  readonly id: string;
  readonly legKey: string;
}

export interface MomentCamera {
  go(selected: SelectedPlace): Flight;
  release(): void;
}

/**
 * The order of the signature moment for one selection: the camera flies when the first frame of the selected
 * train arrives (a frame of the train selected before does not count), and the route ahead draws once the route
 * of the selected train's leg is known, a share of the way into the flight. A cut, a Route request or the end of
 * the selection leaves the route whole.
 */
export class SelectionMoment {
  private readonly camera: MomentCamera;
  private readonly now: () => number;
  private readonly draw = new RouteDraw();
  private readonly reveal = new RouteReveal();
  private selectedId: string | null = null;
  private pending = false;
  private flight: Flight | undefined;

  constructor(camera: MomentCamera, now: () => number) {
    this.camera = camera;
    this.now = now;
  }

  /** Whether the selected train has not been flown to yet. */
  get flightPending(): boolean {
    return this.pending;
  }

  select(id: string | null): void {
    this.selectedId = id;
    this.pending = id !== null;
    this.flight = undefined;
    this.draw.cancel();
    if (id === null) this.camera.release();
  }

  /** One frame of the worker: `routeLegKey` is the leg the drawn route belongs to, undefined without one. */
  frame(selected: MomentFrame | null, routeLegKey: string | undefined): void {
    if (!(selected && selected.id === this.selectedId)) return;
    if (this.pending) {
      this.pending = false;
      this.flight = this.camera.go(selected);
    }
    const flight = this.flight;
    if (!(flight && routeLegKey === selected.legKey)) return;
    this.flight = undefined;
    const start = drawStart(flight, this.now());
    if (start !== null) this.draw.arm(start, flight.reachMetres);
  }

  /** The reader asked for the whole route: no draw, the route shows whole. */
  routeRequested(): void {
    this.flight = undefined;
    this.draw.cancel();
  }

  tiltSwitched(on: boolean): void {
    if (!on) this.camera.release();
  }

  /** The route ahead as far as the draw has come; the whole of it when no draw runs. */
  drawn(route: SplitRoute): SplitRoute {
    const now = this.now();
    if (!this.draw.active(now)) return route;
    const metres = this.draw.metres(now, this.reveal.totalMetres(route.ahead));
    return metres === null
      ? route
      : { passed: route.passed, ahead: this.reveal.prefix(route.ahead, metres) };
  }
}
