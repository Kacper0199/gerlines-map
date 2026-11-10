import { type LegalPageCopy, legalCopyFor } from "./copy-legal.ts";
import { useLocale } from "./react.ts";

export { type LegalCopy, type LegalPageCopy, legalCopyFor } from "./copy-legal.ts";

export function useLegalCopy(): LegalPageCopy {
  return legalCopyFor(useLocale());
}
