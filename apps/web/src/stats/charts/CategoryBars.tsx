import { useLocale } from "@gerlines/i18n/react";
import type { StatsPageCopy } from "@gerlines/i18n/stats";
import { useStatsCopy } from "@gerlines/i18n/stats";
import type { StatsNetwork } from "@gerlines/schema/stats";
import { CATEGORY_COLOR_NAMES, type CategoryKey, CategoryMark, isHollow } from "@gerlines/ui";
import type { CSSProperties } from "react";
import { numberFormat } from "../format.ts";
import { categoryEntries, MAP_CATEGORIES } from "../model.ts";
import { Percent } from "../NumberText.tsx";

function isMapCategory(category: string | null): category is CategoryKey {
  return category !== null && (MAP_CATEGORIES as readonly string[]).includes(category);
}

const FALLBACK_COLOUR = "var(--gl-passed)";

function colourOf(category: string | null): string {
  return isMapCategory(category) ? `var(--gl-${CATEGORY_COLOR_NAMES[category]})` : FALLBACK_COLOUR;
}

/** Night is the hollow mark of the legend, so its bar is an outline in the colour of its series. */
function barStyle(category: string | null, share: number): CSSProperties {
  const colour = colourOf(category);
  const width = `${share * 100}%`;
  if (isMapCategory(category) && isHollow(category)) {
    return {
      width,
      borderWidth: "1.5px",
      borderStyle: "solid",
      borderColor: colour,
      backgroundColor: "transparent",
    };
  }
  return { width, backgroundColor: colour };
}

export function categoryLabel(copy: StatsPageCopy, category: string | null): string {
  if (category === null) return copy.stats.category.none;
  if (isMapCategory(category)) return copy.categories[category].legend;
  return copy.stats.category[category as "urban" | "bus" | "other"];
}

export function CategoryBars({ rows }: { rows: StatsNetwork["byCategory"] }) {
  const copy = useStatsCopy();
  const locale = useLocale();
  return (
    <>
      <ul className="flex flex-col gap-3" aria-label={copy.stats.category.title}>
        {categoryEntries(rows).map(({ category, row }) => {
          const share = row?.summary.punctual6 ?? null;
          return (
            <li
              key={category ?? "none"}
              className="flex flex-col gap-1.5"
              data-category={category ?? "none"}
            >
              <div className="type-body flex items-baseline gap-2">
                <span
                  aria-hidden="true"
                  data-slot="category-dot"
                  className="flex h-[1lh] shrink-0 items-center self-start"
                >
                  {isMapCategory(category) ? (
                    <CategoryMark category={category} size={12} />
                  ) : (
                    <span className="size-2.5 rounded-full bg-passed" />
                  )}
                </span>
                <span className="min-w-0 flex-1 wrap-break-word">
                  {categoryLabel(copy, category)}
                  {row === null ? null : (
                    <span className="type-caption ml-2 inline-block whitespace-nowrap text-ink-muted">
                      {copy.stats.category.arrivals(
                        row.summary.observedArrivals,
                        numberFormat(locale, 0).format(row.summary.observedArrivals),
                      )}
                    </span>
                  )}
                </span>
                <span className="type-data text-ink">
                  {share === null ? (
                    <span className="type-body font-normal text-ink-muted">
                      {copy.delay.noData}
                    </span>
                  ) : (
                    <Percent share={share} />
                  )}
                </span>
              </div>
              <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-r-[3px] bg-raised">
                {share === null ? null : (
                  <div
                    data-slot="category-bar"
                    className="box-border h-full rounded-r-[3px]"
                    style={barStyle(category, share)}
                  />
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="type-caption text-ink-muted">{copy.stats.category.covers}</p>
    </>
  );
}
