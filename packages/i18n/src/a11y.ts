import { type A11yCopy, a11yCopyFor } from "./copy-a11y.ts";
import { useLocale } from "./react.ts";

export { type A11yCopy, a11yCopyFor } from "./copy-a11y.ts";

export function useA11yCopy(): A11yCopy {
  return a11yCopyFor(useLocale());
}
