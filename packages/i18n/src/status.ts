import { type StatusPageCopy, statusCopyFor } from "./copy-status.ts";
import { useLocale } from "./react.ts";

export { type StatusCopy, type StatusPageCopy, statusCopyFor } from "./copy-status.ts";

export function useStatusCopy(): StatusPageCopy {
  return statusCopyFor(useLocale());
}
