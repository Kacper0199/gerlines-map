import { type InViewCopy, inViewCopyFor } from "./copy-inview.ts";
import { useLocale } from "./react.ts";

export {
  COMPASS_POINTS,
  type CompassPoint,
  type InViewCopy,
  inViewCopyFor,
} from "./copy-inview.ts";

export function useInViewCopy(): InViewCopy {
  return inViewCopyFor(useLocale());
}
