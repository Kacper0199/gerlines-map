import { type ProfilePageCopy, profileCopyFor } from "./copy-profile.ts";
import { useLocale } from "./react.ts";

export { type ProfileCopy, type ProfilePageCopy, profileCopyFor } from "./copy-profile.ts";

export function useProfileCopy(): ProfilePageCopy {
  return profileCopyFor(useLocale());
}
