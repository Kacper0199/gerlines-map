import type { ProfileCopy } from "@gerlines/i18n/profile";
import { Button } from "@gerlines/ui";
import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import type { ThemeName } from "../theme/tokens.ts";
import { describeLeg } from "./format.ts";
import { legMeasure, type ProfileLeg, type Quantile } from "./model.ts";
import { MISSING_COLOUR, profileColour } from "./scale.ts";

function Swatch({
  leg,
  quantile,
  theme,
}: {
  leg: ProfileLeg;
  quantile: Quantile;
  theme: ThemeName;
}) {
  const measure = legMeasure(leg, quantile);
  return measure.status === "known" ? (
    <span
      aria-hidden="true"
      className="mt-1.5 h-2.5 w-1.5 shrink-0 rounded-full"
      style={{ backgroundColor: profileColour(measure.gain, theme) }}
    />
  ) : (
    <span
      aria-hidden="true"
      className="mt-1.5 h-2.5 w-1.5 shrink-0 rounded-full border border-dashed"
      style={{ borderColor: MISSING_COLOUR[theme] }}
    />
  );
}

/** Every leg with the words of its map tooltip, so the figures are readable without hovering. */
export function ProfileLegList({
  legs,
  quantile,
  copy,
  unit,
  locale,
  theme,
}: {
  legs: readonly ProfileLeg[];
  quantile: Quantile;
  copy: ProfileCopy;
  unit: string;
  locale: string;
  theme: ThemeName;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="quiet"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen(!open)}
        className="-ml-3 self-start text-ink"
      >
        {open ? copy.listHide : copy.listShow(legs.length)}
        <ChevronDown aria-hidden="true" className={open ? "rotate-180" : ""} />
      </Button>
      <ul id={listId} hidden={!open} className="flex flex-col gap-2.5">
        {legs.map((leg) => {
          const text = describeLeg(leg, quantile, copy, unit, locale);
          return (
            <li key={leg.index} className="flex items-start gap-2">
              <Swatch leg={leg} quantile={quantile} theme={theme} />
              <span className="flex min-w-0 flex-col">
                <span className="type-label break-words">{text.title}</span>
                {text.lines.map((line) => (
                  <span key={line.label} className="type-caption text-ink-muted">
                    {line.label}: {line.value}
                  </span>
                ))}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
