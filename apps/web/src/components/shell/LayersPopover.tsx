import { useCopy } from "@gerlines/i18n/react";
import { IconButton } from "@gerlines/ui";
import { Layers } from "lucide-react";
import { lazy, useEffect, useRef } from "react";
import { clearHeadingForPopover, useInViewOpen } from "../../inview/InViewEntry.tsx";
import { LazyPopupSlot, useLazyPopup } from "./lazy-popup.tsx";

const loadBody = () => import("./LayersPopoverBody.tsx");
const LayersPopoverBody = lazy(loadBody);

function preload(): void {
  void loadBody().catch(() => undefined);
}

/**
 * The layers button of the phone shell. It is a plain button that never changes; the popup with the legend and the
 * style switches loads on the first press, so neither it nor its positioning code is in the entry chunk, and a hover or
 * focus starts loading them.
 */
export function LayersPopover() {
  const { layers } = useCopy();
  const popup = useLazyPopup(preload, clearHeadingForPopover);
  const inViewOpen = useInViewOpen();
  const inViewWasOpen = useRef(inViewOpen);
  const { setOpen } = popup;
  useEffect(() => {
    if (inViewOpen && !inViewWasOpen.current) setOpen(false);
    inViewWasOpen.current = inViewOpen;
  }, [inViewOpen, setOpen]);
  return (
    <>
      <IconButton
        label={layers.open}
        variant="secondary"
        data-slot="layers-button"
        {...popup.triggerProps}
      >
        <Layers aria-hidden="true" />
      </IconButton>
      <LazyPopupSlot popup={popup}>
        <LayersPopoverBody
          anchor={popup.anchor as HTMLElement}
          open={popup.open}
          onOpenChange={(next) => {
            if (next) clearHeadingForPopover();
            popup.setOpen(next);
          }}
        />
      </LazyPopupSlot>
    </>
  );
}
