import { useLocale } from "@gerlines/i18n/react";
import { useStatsCopy } from "@gerlines/i18n/stats";
import { Fragment } from "react";
import { numberFormat } from "./format.ts";
import { durationParts, isTinyShare, percentNumber, percentOf, percentSign } from "./model.ts";

/** A number in Overpass Mono with its group and decimal separators narrowed (DESIGN.md Typography). */
export function NumberText({ value, digits = 0 }: { value: number; digits?: number }) {
  const locale = useLocale();
  const parts = numberFormat(locale, digits).formatToParts(value);
  let offset = 0;
  return (
    <span className="num">
      {parts.map((part) => {
        const key = `${part.type}${offset}`;
        offset += part.value.length;
        return part.type === "group" || part.type === "decimal" ? (
          <span key={key} className="punct">
            {part.value}
          </span>
        ) : (
          <Fragment key={key}>{part.value}</Fragment>
        );
      })}
    </span>
  );
}

export function Percent({ share }: { share: number }) {
  const locale = useLocale();
  const copy = useStatsCopy();
  if (isTinyShare(share)) {
    return <span className="whitespace-nowrap">{percentOf(share, locale, copy.stats.under)}</span>;
  }
  return (
    <span className="whitespace-nowrap">
      <NumberText value={percentNumber(share)} digits={1} />
      {percentSign(locale)}
    </span>
  );
}

export function Duration({
  seconds,
  minutesWord,
}: {
  seconds: number | null;
  minutesWord: string;
}) {
  const parts = durationParts(seconds);
  if (parts === null) return null;
  return (
    <span className="whitespace-nowrap">
      {parts.unit === "s" ? (
        <>
          <NumberText value={parts.value} />
          {" s"}
        </>
      ) : null}
      {parts.unit === "min" ? (
        <>
          <NumberText value={parts.value} digits={1} />
          {` ${minutesWord}`}
        </>
      ) : null}
      {parts.unit === "h" ? (
        <>
          <NumberText value={parts.value} />
          {" h "}
          <NumberText value={parts.minutes} />
          {` ${minutesWord}`}
        </>
      ) : null}
    </span>
  );
}
