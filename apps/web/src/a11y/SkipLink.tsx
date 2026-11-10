import { useA11yCopy } from "@gerlines/i18n/a11y";
import { showInView } from "../inview/InViewEntry.tsx";
import { useInViewStore } from "../inview/store.ts";
import { searchInput } from "./focus.ts";

const SKIP_CLASS =
  "focus-ring card-surface type-label sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:inline-flex focus:min-h-target focus:items-center focus:px-4";

/** Opens the list of trains in view and asks its heading for the focus, also when the list is already open. */
function skipToInView(): void {
  showInView();
  useInViewStore.getState().requestHeadingFocus();
}

/** The first stops of the page: hidden until they have the focus, then they jump over the map to the search field or to the trains in view. */
export function SkipLink() {
  const { skipToSearch, skipToInView: toInView } = useA11yCopy();
  return (
    <>
      <button
        type="button"
        data-slot="skip-link"
        onClick={() => searchInput()?.focus()}
        className={SKIP_CLASS}
      >
        {skipToSearch}
      </button>
      <button
        type="button"
        data-slot="skip-link-inview"
        onClick={skipToInView}
        className={SKIP_CLASS}
      >
        {toInView}
      </button>
    </>
  );
}
