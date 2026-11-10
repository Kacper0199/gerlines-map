import { type SignatureCopy, signatureCopyFor } from "./copy-signature.ts";
import { useLocale } from "./react.ts";

export { type SignatureCopy, signatureCopyFor } from "./copy-signature.ts";

export function useSignatureCopy(): SignatureCopy {
  return signatureCopyFor(useLocale());
}
