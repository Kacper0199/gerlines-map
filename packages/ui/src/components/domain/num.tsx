import { cn } from "../../lib/cn.ts";

const formatters = new Map<string, Intl.NumberFormat>();

function formatterFor(locale: string, options: Intl.NumberFormatOptions | undefined) {
  const key = `${locale}|${options ? JSON.stringify(options) : ""}`;
  const cached = formatters.get(key);
  if (cached) {
    return cached;
  }
  const created = new Intl.NumberFormat(locale, { useGrouping: "always", ...options });
  formatters.set(key, created);
  return created;
}

export interface NumProps {
  readonly value: number;
  readonly locale?: string;
  readonly options?: Intl.NumberFormatOptions;
  readonly className?: string;
}

export function Num({ value, locale = "en", options, className }: NumProps) {
  const parts = formatterFor(locale, options).formatToParts(value);
  let offset = 0;
  return (
    <span className={cn("num", className)}>
      {parts.map((part) => {
        const key = `${part.type}${offset}`;
        offset += part.value.length;
        return part.type === "group" ? (
          <span key={key} className="punct">
            {part.value}
          </span>
        ) : (
          part.value
        );
      })}
    </span>
  );
}
