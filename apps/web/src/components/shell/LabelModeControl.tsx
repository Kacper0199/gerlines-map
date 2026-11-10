import { useCopy } from "@gerlines/i18n/react";
import { cn } from "@gerlines/ui";
import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import { isLabelMode, LABEL_MIN_ZOOM } from "../../modes/label-mode.ts";
import { useAppStore } from "../../state/store.ts";
import { RadioTabs } from "./RadioTabs.tsx";

function LabelTabs({ titleId }: { titleId: string }) {
  const { labels } = useCopy();
  const labelMode = useAppStore((state) => state.labelMode);
  const setLabelMode = useAppStore((state) => state.setLabelMode);
  return (
    <RadioTabs
      labelledBy={titleId}
      value={labelMode}
      onValueChange={(value) => {
        if (isLabelMode(value)) setLabelMode(value);
      }}
      options={[
        { value: "off", label: labels.off },
        { value: "line", label: labels.line },
        { value: "delay", label: labels.delay },
      ]}
    />
  );
}

function ZoomHint({ hidden = false }: { hidden?: boolean }) {
  const { labels } = useCopy();
  const labelMode = useAppStore((state) => state.labelMode);
  const zoomedOut = useAppStore((state) => state.zoom < LABEL_MIN_ZOOM);
  const hint = labelMode !== "off" && zoomedOut;
  return (
    <p
      role="status"
      className={cn(
        "type-caption text-ink-muted",
        hidden || labelMode === "off" ? "sr-only" : "min-h-[1.3em]",
      )}
    >
      {hint ? labels.hint : ""}
    </p>
  );
}

/**
 * The label control, inline or, when the column is short, behind a disclosure. The disclosure state
 * lives here so it survives the column changing between the two forms.
 */
export function LabelModeControl({ folded = false }: { folded?: boolean }) {
  const { labels } = useCopy();
  const labelMode = useAppStore((state) => state.labelMode);
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const bodyId = useId();
  if (!folded) {
    return (
      <div className="flex flex-col gap-1 px-4 pt-2 pb-3" data-testid="label-mode">
        <span id={titleId} className="type-caption text-ink-muted">
          {labels.label}
        </span>
        <LabelTabs titleId={titleId} />
        <ZoomHint />
      </div>
    );
  }
  return (
    <div data-testid="label-mode" data-folded="">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        data-fit-pin=""
        onClick={() => setOpen(!open)}
        className="focus-ring type-label flex min-h-target w-full items-center justify-between gap-2 px-4 focus-visible:outline-offset-[-2px]!"
      >
        <span id={titleId}>{labels.label}</span>
        <span className="flex items-center gap-2 text-ink-muted">
          {labels[labelMode]}
          <ChevronDown
            aria-hidden="true"
            className="size-[18px] shrink-0 transition-transform data-[open=true]:rotate-180"
            data-open={open}
          />
        </span>
      </button>
      <div id={bodyId} hidden={!open} className="flex flex-col gap-1 px-4 pb-3">
        <LabelTabs titleId={titleId} />
      </div>
      <ZoomHint hidden={!open} />
    </div>
  );
}
