export const DETAIL_PROXY_PREFIX = "/api/v1";

export function detailProxy(target: string | undefined) {
  return target ? { [DETAIL_PROXY_PREFIX]: { target, changeOrigin: true } } : {};
}

/** With a detail target set, Vite's proxy answers the whole `/api/v1` prefix, so the in-process API stands aside. */
export function handsOffDetail(url: string | undefined, target: string | undefined): boolean {
  return Boolean(target) && (url?.startsWith(`${DETAIL_PROXY_PREFIX}/`) ?? false);
}
