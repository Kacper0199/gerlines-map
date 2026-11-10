import { cn } from "@gerlines/ui";
import { useId } from "react";

export interface RadioOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

interface RadioTabsProps<T extends string> {
  readonly value: T;
  readonly onValueChange: (value: T) => void;
  readonly options: readonly RadioOption<T>[];
  readonly label?: string;
  readonly labelledBy?: string;
  readonly className?: string;
}

const OPTION_CLASS = cn(
  "type-label relative inline-flex min-h-target min-w-target shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-md px-2 text-ink-muted transition-colors",
  "hover:text-ink has-checked:text-ink",
  "after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-ink after:opacity-0 after:transition-opacity has-checked:after:opacity-100",
  "forced-colors:has-checked:underline forced-colors:has-checked:decoration-2 forced-colors:has-checked:underline-offset-4",
  "has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-(--gl-focus) has-focus-visible:outline-solid",
);

/**
 * A choice of one that looks like tabs and is what it is: a radio group. The options have no panels, so the
 * tab roles of a tab list would promise content that is not there (WCAG 4.1.2); native radios bring the arrow keys.
 */
export function RadioTabs<T extends string>({
  value,
  onValueChange,
  options,
  label,
  labelledBy,
  className,
}: RadioTabsProps<T>) {
  const name = useId();
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-labelledby={labelledBy}
      className={cn("-m-1 flex items-center gap-2 overflow-x-auto p-1", className)}
    >
      {options.map((option) => (
        <label key={option.value} className={OPTION_CLASS}>
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={option.value === value}
            onChange={() => onValueChange(option.value)}
            className="sr-only"
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}
