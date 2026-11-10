import { useCopy } from "@gerlines/i18n/react";
import { lazy, Suspense, useState } from "react";
import { StatusDot } from "./StatusDot.tsx";
import { STATUS_TRIGGER_CLASS } from "./trigger-style.ts";

const loadPopover = () => import("./StatusPopover.tsx");
const StatusPopover = lazy(loadPopover);

function preload(): void {
  void loadPopover().catch(() => undefined);
}

/**
 * The live bar's status dot and label as the button of the data status popover. Until the first
 * press it is a plain button, so the popover, its copy and its reads stay out of the entry chunk;
 * a hover or focus starts loading them. The label stays in a status region for screen readers.
 */
export function StatusTrigger({ label, healthy }: { label: string; healthy: boolean }) {
  const copy = useCopy();
  const [requested, setRequested] = useState(false);
  const plain = (
    <button
      type="button"
      data-slot="status-trigger"
      aria-label={copy.live.openStatus(label)}
      aria-haspopup="dialog"
      aria-expanded={false}
      aria-busy={requested || undefined}
      className={STATUS_TRIGGER_CLASS}
      onPointerEnter={preload}
      onFocus={preload}
      onClick={() => setRequested(true)}
    >
      <StatusDot state={healthy ? "ok" : "stale"} />
      <span aria-hidden="true">{label}</span>
    </button>
  );
  return (
    <>
      <span role="status" className="sr-only">
        {label}
      </span>
      {requested ? (
        <Suspense fallback={plain}>
          <StatusPopover label={label} healthy={healthy} />
        </Suspense>
      ) : (
        plain
      )}
    </>
  );
}
