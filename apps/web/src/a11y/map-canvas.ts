export const MAP_KEYS_ID = "map-keys";

/** The map library names its canvas in English; the canvas gets the interface language and the keys that move it. */
export function describeCanvas(canvas: HTMLElement, label: string): void {
  canvas.setAttribute("aria-label", label);
  canvas.setAttribute("aria-describedby", MAP_KEYS_ID);
}
