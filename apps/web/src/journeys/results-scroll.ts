export interface ScrollView {
  readonly top: number;
  readonly bottom: number;
  readonly scrollTop: number;
}

export interface Box {
  readonly top: number;
  readonly bottom: number;
}

function inView(view: ScrollView, box: Box): boolean {
  return box.top >= view.top && box.bottom <= view.bottom;
}

/**
 * Where the body that scrolls the results should go when new results arrive: nowhere while the
 * shown journey (or, without one, the start of the results) is already in view, so the form stays
 * readable; otherwise the results start at the top of the body.
 */
export function resultsScrollTop(
  view: ScrollView,
  results: Box,
  shown: Box | null,
  gap: number,
): number | null {
  const target = shown ?? { top: results.top, bottom: Math.min(results.bottom, results.top + 1) };
  if (inView(view, target)) return null;
  return Math.max(0, results.top - view.top + view.scrollTop - gap);
}
