import { useCopy } from "@gerlines/i18n/react";
import { IconButton } from "@gerlines/ui";
import { Minus, Plus } from "lucide-react";

export function ZoomControls({ onZoom }: { onZoom: (delta: number) => void }) {
  const copy = useCopy();
  return (
    <fieldset
      aria-label={copy.map.zoomGroup}
      className="card-surface pointer-events-auto m-0 flex w-target min-w-0 flex-col overflow-hidden p-0"
    >
      <IconButton
        label={copy.map.zoomIn}
        className="rounded-none focus-visible:outline-offset-[-2px]!"
        onClick={() => onZoom(1)}
      >
        <Plus aria-hidden="true" />
      </IconButton>
      <div aria-hidden="true" className="h-px bg-hairline" />
      <IconButton
        label={copy.map.zoomOut}
        className="rounded-none focus-visible:outline-offset-[-2px]!"
        onClick={() => onZoom(-1)}
      >
        <Minus aria-hidden="true" />
      </IconButton>
    </fieldset>
  );
}
