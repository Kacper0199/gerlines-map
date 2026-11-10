import { useColourKeyCopy } from "@gerlines/i18n/colour-key";
import { useCopy } from "@gerlines/i18n/react";
import { CategoryMark, cn } from "@gerlines/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { DelayClass } from "../../modes/delay.ts";
import {
  hasNeutralMark,
  NEUTRAL_GROUP_SIZE,
  operatorColourCss,
} from "../../modes/operator-colours.ts";
import {
  type ColouredGroup,
  groupName,
  isColouredGroup,
  OPERATOR_GROUPS,
  type OperatorGroup,
} from "../../modes/operator-groups.ts";
import type { CategoryKey } from "../../motion/categories.ts";
import { useAppStore } from "../../state/store.ts";
import { LEGEND_DELAY_CLASSES, SWATCH_COLOUR } from "./LegendDelayRows.tsx";

const CATEGORIES: readonly CategoryKey[] = [
  "hsr",
  "ld",
  "night",
  "rfast",
  "reg",
  "sbahn",
  "foreign",
];
const SHORT_GROUP_NAMES: Readonly<Record<ColouredGroup, string>> = {
  db: "DB",
  transdev: "Transdev",
  netinera: "Netinera",
  kvvh: "KVVH",
  hlb: "HLB",
  sweg: "SWEG",
};

function Dot({ fill, scale = 1 }: { fill: string; scale?: number }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 14 14" width={10} height={10} className="shrink-0">
      <circle cx={7} cy={7} r={5 * scale} fill={fill} />
    </svg>
  );
}

function Item({
  swatch,
  label,
  fullName,
  hidden,
  hiddenWord,
}: {
  swatch: ReactNode;
  label: string;
  fullName: string;
  hidden: boolean;
  hiddenWord: string;
}) {
  return (
    <li
      data-hidden={hidden}
      className={cn("flex shrink-0 items-center gap-1", hidden && "opacity-40")}
    >
      {swatch}
      <span aria-hidden="true">{label}</span>
      <span className="sr-only">{hidden ? `${fullName}, ${hiddenWord}` : fullName}</span>
    </li>
  );
}

function useEdgeState() {
  const ref = useRef<HTMLFieldSetElement>(null);
  const [edge, setEdge] = useState({ overflowing: false, atEnd: true });
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const measure = () =>
      setEdge({
        overflowing: element.scrollWidth > element.clientWidth + 1,
        atEnd: element.scrollLeft + element.clientWidth >= element.scrollWidth - 1,
      });
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    if (typeof ResizeObserver === "undefined") {
      return () => element.removeEventListener("scroll", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => {
      element.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, []);
  return { ref, ...edge };
}

function useItems() {
  const copy = useCopy();
  const key = useColourKeyCopy();
  const mode = useAppStore((state) => state.colourMode);
  const hiddenCategories = useAppStore((state) => state.hiddenCategories);
  const hiddenGroups = useAppStore((state) => state.hiddenOperatorGroups);
  const item = (props: {
    id: string;
    swatch: ReactNode;
    label: string;
    fullName: string;
    hidden: boolean;
  }) => <Item key={props.id} {...props} hiddenWord={key.hidden} />;
  if (mode === "category") {
    return CATEGORIES.map((category) =>
      item({
        id: category,
        swatch: <CategoryMark category={category} size={12} />,
        label: key.category[category],
        fullName: copy.categories[category].legend,
        hidden: hiddenCategories.includes(category),
      }),
    );
  }
  if (mode === "delay") {
    return LEGEND_DELAY_CLASSES.map((name: DelayClass) =>
      item({
        id: name,
        swatch: <Dot fill={SWATCH_COLOUR[name]} />,
        label: name === "foreign" ? key.category.foreign : key.delay[name],
        fullName: copy.legend.delay[name],
        hidden: name === "foreign" && hiddenCategories.includes("foreign"),
      }),
    );
  }
  const operatorName = (group: OperatorGroup) =>
    isColouredGroup(group)
      ? { short: SHORT_GROUP_NAMES[group], full: groupName(group) }
      : group === "other"
        ? { short: key.operator.other, full: copy.operatorMode.other }
        : { short: key.operator.unknown, full: copy.operatorMode.unknown };
  return OPERATOR_GROUPS.map((group) =>
    item({
      id: group,
      swatch: (
        <Dot
          fill={operatorColourCss(group)}
          scale={hasNeutralMark(group) ? NEUTRAL_GROUP_SIZE : 1}
        />
      ),
      label: operatorName(group).short,
      fullName: operatorName(group).full,
      hidden: hiddenGroups.includes(group),
    }),
  );
}

/**
 * One row with a swatch for every colour of the active mode, for phones, where the legend sits behind
 * the layers button. It names the colours and not the counts, so it needs no data and is there at
 * the first paint. Colours the visitor hid are dimmed and named as hidden. A mode with more colours
 * than the row holds scrolls sideways under a fade.
 */
export function ColourKey({ className }: { className?: string }) {
  const key = useColourKeyCopy();
  const mode = useAppStore((state) => state.colourMode);
  const items = useItems();
  const { ref, overflowing, atEnd } = useEdgeState();
  return (
    <div
      data-slot="colour-key"
      data-mode={mode}
      className={cn(
        "card-surface type-caption pointer-events-auto relative flex max-w-full",
        className,
      )}
    >
      <fieldset
        ref={ref}
        aria-label={key.label[mode]}
        tabIndex={overflowing ? 0 : undefined}
        data-overflowing={overflowing}
        className="focus-ring m-0 flex min-h-8 min-w-0 items-center overflow-x-auto rounded-[inherit] border-0 px-3 py-1 whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <ul className="flex items-center gap-x-2">{items}</ul>
      </fieldset>
      {overflowing && !atEnd ? (
        <span
          aria-hidden="true"
          data-slot="colour-key-fade"
          className="pointer-events-none absolute inset-y-0 right-0 w-6 rounded-r-[inherit] bg-linear-to-r from-transparent to-(--gl-surface)"
        />
      ) : null}
    </div>
  );
}
