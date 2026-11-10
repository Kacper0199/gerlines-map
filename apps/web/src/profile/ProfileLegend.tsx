import type { ProfileCopy } from "@gerlines/i18n/profile";
import { cn } from "@gerlines/ui";
import type { ThemeName } from "../theme/tokens.ts";
import { CURTAIN_CAP_MINUTES, GAIN_CLASSES, MISSING_COLOUR, profileColour } from "./scale.ts";

const TICKS: Readonly<Record<number, string>> = { [-3]: "-3", 0: "0", 3: "+3" };

/** The diverging scale in whole minutes against all trains, the missing style and what the curtain height means. */
export function ProfileLegend({
  copy,
  theme,
  unit,
  curtain,
}: {
  copy: ProfileCopy;
  theme: ThemeName;
  unit: string;
  curtain: boolean;
}) {
  return (
    <figure className="flex flex-col gap-1.5" aria-label={copy.legend.title}>
      <figcaption className="type-label">{copy.legend.title}</figcaption>
      <div className="flex items-start gap-0.5" aria-hidden="true">
        {GAIN_CLASSES.map((gain) => (
          <div key={gain} className="flex min-w-0 flex-1 flex-col items-center gap-0.5">
            <span
              className={cn(
                "h-2.5 w-full",
                gain === -3 && "rounded-l-sm",
                gain === 3 && "rounded-r-sm",
              )}
              style={{ backgroundColor: profileColour(gain, theme) }}
            />
            <span className="num type-data-small text-ink-muted">{TICKS[gain] ?? " "}</span>
          </div>
        ))}
      </div>
      <div className="type-caption flex justify-between text-ink-muted">
        <span>{copy.legend.low}</span>
        <span>{copy.legend.zero}</span>
        <span className="text-right">{copy.legend.high}</span>
      </div>
      <p className="type-caption flex items-center gap-2 text-ink-muted">
        <span
          aria-hidden="true"
          className="h-0 w-8 shrink-0 border-t-[3px] border-dashed"
          style={{ borderColor: MISSING_COLOUR[theme] }}
        />
        {copy.legend.missing}
      </p>
      {curtain ? (
        <p className="type-caption text-pretty text-ink-muted">
          {copy.curtain(`${CURTAIN_CAP_MINUTES}\u00a0${unit}`)}
        </p>
      ) : null}
    </figure>
  );
}
