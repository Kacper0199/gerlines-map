import { cn } from "../../lib/cn.ts";
import { CATEGORY_COLOR_NAMES, type CategoryKey, FOREIGN_OPACITY } from "../../theme/tokens.ts";
import {
  CHEVRON_PATH,
  CHEVRON_STROKE,
  DOT_RADIUS,
  DOT_RING_STROKE,
  SHAPE_CELL,
} from "./category-shapes.ts";

export type MarkShape = "dot" | "chevron";

export interface CategoryMarkProps {
  readonly category: CategoryKey;
  readonly shape?: MarkShape;
  readonly size?: number;
  readonly heading?: number;
  readonly title?: string;
  readonly className?: string;
}

export function isHollow(category: CategoryKey): boolean {
  return category === "night";
}

export function CategoryMark({
  category,
  shape = "dot",
  size = 12,
  heading = 0,
  title,
  className,
}: CategoryMarkProps) {
  const color = `var(--gl-${CATEGORY_COLOR_NAMES[category]})`;
  const hollow = isHollow(category);
  const center = SHAPE_CELL / 2;
  const paint = hollow
    ? { fill: "none", stroke: color, strokeLinejoin: "round" as const }
    : { fill: color, stroke: "none" };
  return (
    <svg
      viewBox={`0 0 ${SHAPE_CELL} ${SHAPE_CELL}`}
      width={size}
      height={size}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      data-category={category}
      className={cn("inline-block shrink-0", className)}
      style={category === "foreign" ? { opacity: FOREIGN_OPACITY } : undefined}
    >
      {shape === "dot" ? (
        <circle
          cx={center}
          cy={center}
          r={hollow ? DOT_RADIUS - DOT_RING_STROKE / 2 : DOT_RADIUS}
          strokeWidth={DOT_RING_STROKE}
          {...paint}
        />
      ) : (
        <path
          d={CHEVRON_PATH}
          strokeWidth={CHEVRON_STROKE}
          transform={`rotate(${heading} ${center} ${center})`}
          {...paint}
        />
      )}
    </svg>
  );
}
