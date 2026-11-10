/**
 * The schema modules hold the answer parsers (zod) and stay out of the entry chunk: each fetcher starts its loader
 * before it sends its request, so the chunk and the answer arrive together, and `warmSchemas` fetches them while
 * the page is idle after the map code has loaded.
 */
export const loadSearchSchema = () => import("@gerlines/schema/search");
export const loadJourneysSchema = () => import("@gerlines/schema/journeys");
export const loadTrainSchema = () => import("@gerlines/schema");

/** Loads every schema module now; a module that cannot be loaded is left for the fetcher that needs it to report. */
export function warmSchemas(): void {
  for (const load of [loadSearchSchema, loadJourneysSchema, loadTrainSchema]) {
    void load().catch(() => undefined);
  }
}

/** Calls `callback` when the browser is idle, or after a few seconds at the latest. */
export function whenIdle(callback: () => void): void {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(callback, { timeout: 5_000 });
    return;
  }
  setTimeout(callback, 2_000);
}
