import { useInViewCopy } from "@gerlines/i18n/inview";
import { cn, IconButton } from "@gerlines/ui";
import { List } from "lucide-react";
import { lazy, Suspense } from "react";
import { PANEL_BUTTON_CLASS } from "../components/shell/panel-button.ts";
import { usePanelOpen, usePanelStore } from "../state/panel-store.ts";
import { usePlaceStore } from "../state/place-store.ts";
import { useAppStore } from "../state/store.ts";

const InViewPanel = lazy(() => import("./InViewPanel.tsx"));

/** Opens the list in the card slot; a train or station card that was open gives way to it. */
export function showInView(): void {
  useAppStore.getState().select(null);
  usePlaceStore.getState().selectStation(null);
  usePanelStore.getState().open("inview");
}

let headingForPopover = false;

/** True once, after the list was opened from inside the layers popover: that popover then hands its focus to the list heading. */
export function takeHeadingForPopover(): boolean {
  const take = headingForPopover;
  headingForPopover = false;
  return take;
}

export function clearHeadingForPopover(): void {
  headingForPopover = false;
}

/** The legend's entry to the list of trains in view: pressed while the list holds the card slot. */
export function InViewButton({ className }: { className?: string }) {
  const copy = useInViewCopy();
  const open = usePanelOpen("inview");
  return (
    <IconButton
      label={copy.open}
      tooltip
      tooltipSide="bottom"
      variant="secondary"
      aria-pressed={open}
      data-slot="inview-button"
      onClick={() => {
        if (open) {
          usePanelStore.getState().close("inview");
          return;
        }
        headingForPopover = true;
        showInView();
      }}
      className={cn(PANEL_BUTTON_CLASS, className)}
    >
      <List aria-hidden="true" />
    </IconButton>
  );
}

export function useInViewOpen(): boolean {
  return usePanelOpen("inview");
}

/** The list in the card slot of the shell, loaded on demand. */
export function InViewSlot({ phone }: { phone: boolean }) {
  return (
    <Suspense fallback={null}>
      <InViewPanel phone={phone} />
    </Suspense>
  );
}
