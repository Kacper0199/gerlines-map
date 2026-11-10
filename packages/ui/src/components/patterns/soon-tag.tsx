import { cn } from "../../lib/cn.ts";

export interface SoonTagProps {
  readonly id?: string;
  readonly label: string;
  readonly description: string;
  readonly className?: string;
}

export function SoonTag({ id, label, description, className }: SoonTagProps) {
  return (
    <span
      id={id}
      data-slot="soon-tag"
      className={cn(
        "inline-flex h-5 w-fit items-center whitespace-nowrap rounded-pill border border-hairline px-2 font-semibold text-[11px] text-ink-muted leading-none",
        className,
      )}
    >
      <span>
        {label}
        <span className="sr-only">. {description}</span>
      </span>
    </span>
  );
}
