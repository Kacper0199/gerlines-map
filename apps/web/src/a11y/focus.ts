function find(selector: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(selector);
}

export const mapCanvas = () => find(".maplibregl-canvas");

export const searchInput = () => find("[data-slot=search-card] input[role=combobox]");

export const slotButton = (slot: string) => () => find(`[data-slot=${slot}]`);

/**
 * Gives the focus to `target` once a closing panel has unmounted, but only when the closing took
 * the focus with it (it fell back to the page), so a user who moved on is never pulled back.
 */
export function restoreFocus(target: () => HTMLElement | null): void {
  requestAnimationFrame(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) {
      target()?.focus({ preventScroll: true });
    }
  });
}

export function returnToMap(): void {
  restoreFocus(mapCanvas);
}
