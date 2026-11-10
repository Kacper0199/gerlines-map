import { useCopy } from "@gerlines/i18n/react";
import { Popover, PopoverContent, PopoverTitle } from "@gerlines/ui";
import { takeHeadingForPopover } from "../../inview/InViewEntry.tsx";
import { LegendCard } from "./LegendCard.tsx";
import { LocaleSwitch } from "./LocaleSwitch.tsx";
import { StylePicker } from "./StylePicker.tsx";

/**
 * The popup of the layers button, loaded on its first press (LayersPopover). It opens at once with the focus in the
 * popup, and closing it returns the focus to the button, or to the trains in view heading that asked for it.
 */
export default function LayersPopoverBody({
  anchor,
  open,
  onOpenChange,
}: {
  anchor: HTMLElement;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { layers, language } = useCopy();
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverContent
        anchor={anchor}
        align="end"
        className="max-h-(--available-height) w-[calc(100vw-24px)] overflow-y-auto p-3"
        finalFocus={() =>
          (takeHeadingForPopover()
            ? document.querySelector<HTMLElement>("[data-slot=inview-heading]")
            : null) ?? anchor
        }
      >
        <PopoverTitle className="sr-only">{layers.title}</PopoverTitle>
        <div className="flex items-center justify-between gap-3 px-1">
          <span aria-hidden="true" className="type-label">
            {language.label}
          </span>
          <LocaleSwitch />
        </div>
        <StylePicker wide className="shrink-0 border-0 bg-transparent py-1 shadow-none" />
        <LegendCard className="border-0 bg-transparent py-0 shadow-none" />
      </PopoverContent>
    </Popover>
  );
}
