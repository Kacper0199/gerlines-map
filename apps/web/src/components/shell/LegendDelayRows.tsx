import { useCopy, useLocale } from "@gerlines/i18n/react";
import { Checkbox, Num } from "@gerlines/ui";
import { useId } from "react";
import type { DelayClass } from "../../modes/delay.ts";
import type { CategoryKey } from "../../motion/categories.ts";

export const LEGEND_DELAY_CLASSES: readonly DelayClass[] = [
  "ok",
  "minor",
  "major",
  "severe",
  "none",
  "foreign",
];

export const SWATCH_COLOUR: Readonly<Record<DelayClass, string>> = {
  ok: "var(--gl-delay-ok)",
  minor: "var(--gl-delay-minor)",
  major: "var(--gl-delay-major)",
  severe: "var(--gl-delay-severe)",
  none: "var(--gl-cat-foreign)",
  foreign: "var(--gl-cat-foreign)",
};

export const ROW =
  "type-label grid min-h-target grid-cols-[14px_1fr_auto] items-center gap-2 px-1 py-1 font-normal";
const STATIC_ROW = ROW.replace("min-h-target ", "min-h-7 ");

export function Count({ value, locale }: { value: number | null; locale: string }) {
  if (value === null) {
    return (
      <span aria-hidden="true" className="flex items-center">
        <span
          data-testid="count-missing"
          className="h-2.5 w-6 animate-pulse rounded-sm bg-ink-muted/25 motion-reduce:animate-none"
        />
      </span>
    );
  }
  return (
    <Num
      value={value}
      locale={locale}
      className="text-ink group-has-[[data-unchecked]]/row:text-ink-muted"
    />
  );
}

export function DelayRows({ counts }: { counts: Readonly<Record<DelayClass, number>> | null }) {
  const copy = useCopy();
  const locale = useLocale();
  return (
    <ul className="flex flex-col" data-testid="delay-legend" aria-label={copy.mode.delay}>
      {LEGEND_DELAY_CLASSES.map((name) => (
        <li key={name} className={STATIC_ROW} data-delay-class={name}>
          <svg aria-hidden="true" viewBox="0 0 14 14" width={14} height={14}>
            <circle cx={7} cy={7} r={5} fill={SWATCH_COLOUR[name]} />
          </svg>
          <span lang={locale} className="min-w-0 hyphens-auto">
            {copy.legend.delay[name]}
          </span>
          <Count value={counts ? counts[name] : null} locale={locale} />
        </li>
      ))}
    </ul>
  );
}

export function ToggleRow({
  name,
  count,
  checked,
  onCheckedChange,
  category,
}: {
  name: string;
  count: number | null;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  category: CategoryKey;
}) {
  const locale = useLocale();
  const id = useId();
  return (
    <div data-slot="legend-row" data-category={category}>
      <label
        htmlFor={id}
        className={`${ROW} group/row cursor-pointer grid-cols-[18px_1fr_auto] rounded-md transition-colors hover:bg-raised has-[[data-unchecked]]:text-ink-muted`}
      >
        <span className="flex items-center">
          <Checkbox id={id} aria-label={name} checked={checked} onCheckedChange={onCheckedChange} />
        </span>
        <span lang={locale} className="min-w-0 hyphens-auto">
          {name}
        </span>
        <Count value={count} locale={locale} />
      </label>
    </div>
  );
}
