import { useCopy } from "@gerlines/i18n/react";
import { Popover, PopoverContent, PopoverTitle } from "@gerlines/ui";
import { StyleSwitches, StyleThumbs } from "./StyleControls.tsx";

/**
 * The popup of the folded style row, loaded on the first press of the row (StylePicker); it opens at once and closing
 * it returns the focus to the row.
 */
export default function FoldedStylesPopover({
  anchor,
  open,
  onOpenChange,
}: {
  anchor: HTMLElement;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { style: copy } = useCopy();
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverContent
        anchor={anchor}
        align="end"
        className="w-64 gap-1 p-3 px-0"
        finalFocus={{ current: anchor }}
      >
        <PopoverTitle className="sr-only">{copy.label}</PopoverTitle>
        <StyleThumbs wide={false} />
        <StyleSwitches />
      </PopoverContent>
    </Popover>
  );
}
