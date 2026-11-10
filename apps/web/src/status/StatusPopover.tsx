import { useCopy } from "@gerlines/i18n/react";
import { Popover, PopoverContent, PopoverTrigger } from "@gerlines/ui";
import { useState } from "react";
import { StatusDot } from "./StatusDot.tsx";
import StatusPanel from "./StatusPanel.tsx";
import { STATUS_TRIGGER_CLASS } from "./trigger-style.ts";

/**
 * The popover with its trigger, loaded on the first press of the plain trigger it replaces. It opens
 * at once with the focus in the popup, and closing it returns the focus to this trigger.
 */
export default function StatusPopover({ label, healthy }: { label: string; healthy: boolean }) {
  const copy = useCopy();
  const [open, setOpen] = useState(true);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        data-slot="status-trigger"
        aria-label={copy.live.openStatus(label)}
        className={STATUS_TRIGGER_CLASS}
      >
        <StatusDot state={healthy ? "ok" : "stale"} />
        <span aria-hidden="true">{label}</span>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={10}
        className="w-80 gap-3 whitespace-normal"
      >
        <StatusPanel />
      </PopoverContent>
    </Popover>
  );
}
