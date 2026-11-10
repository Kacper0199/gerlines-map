import { Field } from "@base-ui/react/field";
import { cn } from "../../lib/cn.ts";
import type { CategoryKey } from "../../theme/tokens.ts";
import { CategoryMark } from "../domain/category-mark.tsx";
import { Num } from "../domain/num.tsx";
import { Checkbox } from "../ui/checkbox.tsx";

export interface LegendRowProps {
  readonly category: CategoryKey;
  readonly name: string;
  /** Null while the count is not known yet: it shows as missing, never as zero. */
  readonly count: number | null;
  readonly locale?: string;
  readonly checked?: boolean;
  readonly defaultChecked?: boolean;
  readonly onCheckedChange?: (checked: boolean) => void;
  readonly disabled?: boolean;
  readonly className?: string;
}

export function LegendRow({
  category,
  name,
  count,
  locale,
  checked,
  defaultChecked = true,
  onCheckedChange,
  disabled = false,
  className,
}: LegendRowProps) {
  return (
    <Field.Root disabled={disabled} data-slot="legend-row">
      <Field.Label
        className={cn(
          "type-label group/row grid min-h-target cursor-pointer grid-cols-[18px_14px_1fr_auto] items-start gap-2 rounded-md px-1 py-[calc((var(--gl-target)-1.3*13px)/2)] font-normal transition-colors hover:bg-raised has-[[data-unchecked]]:text-ink-muted has-[[data-disabled]]:cursor-not-allowed",
          className,
        )}
      >
        <span className="flex h-[1.3em] items-center">
          <Checkbox
            aria-label={name}
            onCheckedChange={onCheckedChange}
            {...(checked === undefined ? { defaultChecked } : { checked })}
          />
        </span>
        <span className="flex h-[1.3em] items-center justify-center">
          <CategoryMark
            category={category}
            size={14}
            className="group-has-[[data-unchecked]]/row:opacity-40"
          />
        </span>
        <span className="min-w-0 hyphens-auto" {...(locale === undefined ? {} : { lang: locale })}>
          {name}
        </span>
        {count === null ? (
          <span className="flex h-[1.3em] items-center" aria-hidden="true">
            <span
              data-testid="count-missing"
              className="h-2.5 w-6 animate-pulse rounded-sm bg-ink-muted/25 motion-reduce:animate-none"
            />
          </span>
        ) : (
          <Num
            value={count}
            {...(locale === undefined ? {} : { locale })}
            className="text-ink group-has-[[data-unchecked]]/row:text-ink-muted"
          />
        )}
      </Field.Label>
    </Field.Root>
  );
}
