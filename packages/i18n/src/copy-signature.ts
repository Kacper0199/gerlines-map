import type { Locale } from "./locale.ts";
import { m } from "./paraglide/messages.js";

export function createSignatureCopy(locale: Locale) {
  const o = { locale };
  return {
    tilt: m.signature_tilt({}, o),
    privacyStorage: m.signature_privacy_storage({}, o),
  };
}

export type SignatureCopy = ReturnType<typeof createSignatureCopy>;

const cache = new Map<Locale, SignatureCopy>();

export function signatureCopyFor(locale: Locale): SignatureCopy {
  let copy = cache.get(locale);
  if (copy === undefined) {
    copy = createSignatureCopy(locale);
    cache.set(locale, copy);
  }
  return copy;
}
