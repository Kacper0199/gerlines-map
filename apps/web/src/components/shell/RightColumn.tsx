import { useLocale } from "@gerlines/i18n/react";
import { useRef } from "react";
import { useAppStore } from "../../state/store.ts";
import { LegendCard } from "./LegendCard.tsx";
import { LocaleSwitch } from "./LocaleSwitch.tsx";
import { foldsStyleCard, LEGEND_FIT_STEPS, LEGEND_PIN_STEP } from "./legend-fit.ts";
import { StylePicker } from "./StylePicker.tsx";
import { useOverflowLadder } from "./use-overflow-ladder.ts";

/**
 * The column scrolls when the legend is longer than the screen, and a scroller clips what lies
 * outside it. Padding on each side, cancelled by a negative margin, keeps the card shadows inside
 * the scroll box: at the screen edges (top and right) as much as the 16 px page padding, so the
 * box ends at the edge and its scrollbar stays on screen; 24 px on the left and 32 px at the
 * bottom (the shadow's 8 px offset plus 24 px blur). The cards stay 14 rem wide.
 */
export function RightColumn({ compact }: { compact: boolean }) {
  const column = useRef<HTMLDivElement>(null);
  const colourMode = useAppStore((state) => state.colourMode);
  const locale = useLocale();
  const fit = useOverflowLadder(
    column,
    LEGEND_FIT_STEPS,
    `${colourMode}|${locale}|${compact}`,
    LEGEND_PIN_STEP,
  );
  const collapsible = compact || fit === "collapsed";
  return (
    <div
      ref={column}
      data-legend-fit={fit}
      className="col-start-3 row-start-1 -mt-4 -mr-4 -mb-8 -ml-6 flex min-h-0 w-66 flex-col items-end gap-3 justify-self-end overflow-y-auto pt-4 pr-4 pb-8 pl-6"
    >
      <LocaleSwitch className="pointer-events-auto shrink-0" />
      <StylePicker
        folded={compact || foldsStyleCard(fit)}
        className="pointer-events-auto w-full shrink-0"
      />
      <LegendCard
        collapsible={collapsible}
        defaultOpen={false}
        fit={fit}
        className="pointer-events-auto w-full shrink-0"
      />
    </div>
  );
}
