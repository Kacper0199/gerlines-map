const START_OPACITY = 0.4;
const FADE_MS = 180;

/**
 * The cut of the reduced-motion version: the map is already at its new view and comes up from a lower opacity in
 * 180 ms with the design curve. Opacity only, so it is composited and moves nothing.
 */
export function fadeIn(element: Pick<HTMLElement, "animate"> | undefined): void {
  if (typeof element?.animate !== "function") return;
  element.animate([{ opacity: START_OPACITY }, { opacity: 1 }], {
    duration: FADE_MS,
    easing: "cubic-bezier(0.2, 0.7, 0.2, 1)",
  });
}
