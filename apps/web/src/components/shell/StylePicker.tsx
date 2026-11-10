import { useCopy } from "@gerlines/i18n/react";
import { Card } from "@gerlines/ui";
import { lazy } from "react";
import { type LazyPopup, LazyPopupSlot, useLazyPopup } from "./lazy-popup.tsx";
import { FOLD_TRIGGER_CLASS, FoldLabel, StyleSwitches, StyleThumbs } from "./StyleControls.tsx";

const loadFoldedPopover = () => import("./FoldedStylesPopover.tsx");
const FoldedStylesPopover = lazy(loadFoldedPopover);

function preload(): void {
  void loadFoldedPopover().catch(() => undefined);
}

/**
 * The folded style row: a plain button that never changes. The popup with the thumbnails and the switches loads on its
 * first press, so it and its positioning code stay out of the entry chunk; a hover or focus starts loading them.
 */
function FoldedStyles({ popup }: { popup: LazyPopup }) {
  return (
    <>
      <button
        type="button"
        data-testid="style-fold"
        className={FOLD_TRIGGER_CLASS}
        {...popup.triggerProps}
      >
        <FoldLabel open={popup.open} />
      </button>
      <LazyPopupSlot popup={popup}>
        <FoldedStylesPopover
          anchor={popup.anchor as HTMLElement}
          open={popup.open}
          onOpenChange={popup.setOpen}
        />
      </LazyPopupSlot>
    </>
  );
}

/**
 * The map style card. Folded, it is one row and the thumbnails with every switch sit in a popover;
 * the popover state lives here so it survives the card changing between the two forms.
 */
export function StylePicker({
  className,
  wide = false,
  folded = false,
}: {
  className?: string;
  wide?: boolean;
  folded?: boolean;
}) {
  const { style: copy } = useCopy();
  const popup = useLazyPopup(preload);
  return (
    <Card className={className} data-slot="style-picker" role="group" aria-label={copy.label}>
      {folded ? (
        <FoldedStyles popup={popup} />
      ) : (
        <>
          <StyleThumbs wide={wide} />
          <StyleSwitches />
        </>
      )}
    </Card>
  );
}
