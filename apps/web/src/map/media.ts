const PICKING_RADIUS_DESKTOP = 8;
const PICKING_RADIUS_PHONE = 16;

export function pickingRadius(phone: boolean): number {
  return phone ? PICKING_RADIUS_PHONE : PICKING_RADIUS_DESKTOP;
}

export function onMediaChange(
  query: MediaQueryList,
  callback: (matches: boolean) => void,
): () => void {
  const listener = () => callback(query.matches);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}
