import { Tooltip, TooltipContent } from "../ui/tooltip.tsx";

export interface IconButtonTooltipProps {
  readonly anchor: HTMLElement;
  readonly open: boolean;
  readonly label: string;
  readonly side: "top" | "bottom";
  readonly onPopupEnter: () => void;
  readonly onPopupLeave: () => void;
}

/** The drawn tooltip of an icon button; the button decides when it is open, so this chunk stays out of the entry. */
export default function IconButtonTooltip({
  anchor,
  open,
  label,
  side,
  onPopupEnter,
  onPopupLeave,
}: IconButtonTooltipProps) {
  return (
    <Tooltip open={open}>
      <TooltipContent
        anchor={anchor}
        side={side}
        onPointerEnter={onPopupEnter}
        onPointerLeave={onPopupLeave}
      >
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
