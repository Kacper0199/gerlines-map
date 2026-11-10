import { type ColourKeyCopy, colourKeyCopyFor } from "./copy-colour-key.ts";
import { useLocale } from "./react.ts";

export { type ColourKeyCopy, colourKeyCopyFor } from "./copy-colour-key.ts";

export function useColourKeyCopy(): ColourKeyCopy {
  return colourKeyCopyFor(useLocale());
}
