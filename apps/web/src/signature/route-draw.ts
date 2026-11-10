/** DESIGN.md Motion: the route ahead draws in 600 ms. */
export const ROUTE_DRAW_MS = 600;

/** The draw starts this share of the way into the flight, once the camera is closing in on the train. */
export const DRAW_LEAD = 0.45;

/** When the draw of a selection starts, null when it does not run (a cut shows the whole route). */
export function drawStart(
  flight: { readonly startedAt: number; readonly durationMs: number },
  now: number,
): number | null {
  if (flight.durationMs === 0) return null;
  return Math.max(now, flight.startedAt + DRAW_LEAD * flight.durationMs);
}

/**
 * The timeline of the route-ahead draw. The line leaves the train at a constant speed (a line being drawn,
 * `linear`) and covers `reachMetres`, which is how far the screen shows at the end of the flight; whatever lies
 * beyond is off screen and joins when the draw ends, so a 500 km route draws as fast on screen as a 20 km one.
 */
export class RouteDraw {
  private startAt = 0;
  private reachMetres = 0;
  private armed = false;

  arm(startAtMs: number, reachMetres: number): void {
    this.startAt = startAtMs;
    this.reachMetres = reachMetres;
    this.armed = true;
  }

  cancel(): void {
    this.armed = false;
  }

  active(now: number): boolean {
    if (this.armed && now >= this.startAt + ROUTE_DRAW_MS) this.armed = false;
    return this.armed;
  }

  /** Metres of the route to show now; null when the whole route shows. */
  metres(now: number, totalMetres: number): number | null {
    if (!this.active(now)) return null;
    const progress = Math.min(1, Math.max(0, (now - this.startAt) / ROUTE_DRAW_MS));
    const revealed = progress * Math.min(totalMetres, this.reachMetres);
    return revealed >= totalMetres ? null : revealed;
  }
}
