import { useCopy, useFormatters } from "@gerlines/i18n/react";
import { sample } from "../sample.ts";
import { Clock } from "./Clock.tsx";

export function LiveBar() {
  const copy = useCopy();
  const { clock, day } = useFormatters();
  return (
    <p className="card live-bar" role="status" aria-live="polite">
      <span className="status">
        <span className="dot" aria-hidden="true" />
        {copy.live.recorded}
      </span>
      <Clock text={clock(sample.capturedMs)} />
      <span>{day(sample.capturedMs)}</span>
      <span className="muted">{copy.stage.national}</span>
    </p>
  );
}
