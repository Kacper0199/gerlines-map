import { useFormatters } from "@gerlines/i18n/react";

export function Num({ value, className }: { value: number; className?: string }) {
  const { countParts } = useFormatters();
  let offset = 0;
  return (
    <span className={className ? `num ${className}` : "num"}>
      {countParts(value).map((part) => {
        const key = `${part.type}${offset}`;
        offset += part.value.length;
        return part.type === "group" ? (
          <span key={key} className="p">
            {part.value}
          </span>
        ) : (
          part.value
        );
      })}
    </span>
  );
}
