import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";
import { colorValue } from "../../theme/tokens.ts";

export type MapStyleKind = "dark" | "light" | "satellite" | "terrain";

const IMAGERY = {
  field: "#3D4632",
  meadow: "#4A5238",
  forest: "#2C3527",
  town: "#4E4B45",
  water: "#1B2329",
} as const;

type Color = Parameters<typeof colorValue>[0];

function BaseMap({ kind }: { kind: "dark" | "light" }) {
  const c = (name: Color) => colorValue(name, kind);
  return (
    <>
      <rect width="104" height="64" fill={c("map-land")} />
      <path d="M0 40 C20 34 30 48 52 44 S90 36 104 42 V64 H0Z" fill={c("map-water")} />
      <path
        d="M-4 14 L40 22 L70 10 L108 20"
        stroke={c("map-road-motorway")}
        strokeWidth="3"
        fill="none"
      />
      <path d="M22 -4 L34 30 L60 68" stroke={c("map-road-major")} strokeWidth="2" fill="none" />
      <path d="M0 28 L104 52" stroke={c("map-rail")} strokeWidth="1" />
      <circle cx="30" cy="16" r="3" fill={c("cat-hsr")} />
      <circle cx="58" cy="19" r="2.4" fill={c("cat-reg")} />
      <circle cx="78" cy="30" r="2.4" fill={c("cat-sbahn")} />
    </>
  );
}

function Satellite() {
  const c = (name: Color) => colorValue(name, "dark");
  return (
    <>
      <rect width="104" height="64" fill={IMAGERY.field} />
      <path d="M0 0 H38 L30 26 L0 32Z" fill={IMAGERY.meadow} />
      <path d="M62 0 H104 V30 L74 24Z" fill={IMAGERY.forest} />
      <path d="M40 8 L56 6 L60 18 L44 22Z" fill={IMAGERY.town} />
      <path d="M0 44 C20 38 30 52 52 48 S90 40 104 46 V64 H0Z" fill={IMAGERY.water} />
      <path d="M0 28 L104 52" stroke={c("map-label")} strokeWidth="1" />
      <circle cx="30" cy="35" r="3" fill={c("cat-hsr")} />
      <circle cx="58" cy="41" r="2.4" fill={c("cat-reg")} />
      <circle cx="80" cy="46" r="2.4" fill={c("cat-sbahn")} />
    </>
  );
}

function Terrain() {
  const c = (name: Color) => colorValue(name, "light");
  return (
    <>
      <rect width="104" height="64" fill={c("map-land")} />
      <path d="M0 64 L26 30 L40 40 L62 12 L88 38 L104 26 V64Z" fill={c("map-green")} />
      <g fill={c("map-label")} opacity="0.28">
        <path d="M26 30 L40 40 L34 64 L18 64Z" />
        <path d="M62 12 L88 38 L80 64 L58 64 L66 34Z" />
      </g>
      <g fill={c("surface")} opacity="0.7">
        <path d="M26 30 L18 64 L4 64Z" />
        <path d="M62 12 L66 34 L50 64 L40 64 L40 40Z" />
      </g>
      <path d="M0 50 L104 36" stroke={c("map-rail")} strokeWidth="1" />
      <circle cx="28" cy="46" r="3" fill={c("cat-hsr")} />
      <circle cx="60" cy="42" r="2.4" fill={c("cat-reg")} />
      <circle cx="84" cy="39" r="2.4" fill={c("cat-sbahn")} />
    </>
  );
}

export interface StyleThumbProps {
  readonly kind: MapStyleKind;
  readonly label: string;
  readonly status?: ReactNode;
  readonly pressed: boolean;
  readonly disabled?: boolean;
  readonly onPress?: () => void;
  readonly className?: string;
}

export function StyleThumb({
  kind,
  label,
  status,
  pressed,
  disabled = false,
  onPress,
  className,
}: StyleThumbProps) {
  return (
    <button
      type="button"
      data-slot="style-thumb"
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onPress}
      className={cn(
        "type-caption focus-ring group/thumb grid min-h-target grid-cols-1 gap-1 rounded-md text-left font-semibold text-ink-muted aria-pressed:text-ink aria-disabled:cursor-not-allowed",
        className,
      )}
    >
      <svg
        viewBox="0 0 104 64"
        aria-hidden="true"
        className="block h-auto w-full rounded-[6px] shadow-[0_0_0_1px_var(--gl-hairline)] group-aria-pressed/thumb:shadow-[0_0_0_2px_var(--gl-ink)] group-aria-disabled/thumb:opacity-55"
      >
        {kind === "satellite" ? (
          <Satellite />
        ) : kind === "terrain" ? (
          <Terrain />
        ) : (
          <BaseMap kind={kind} />
        )}
      </svg>
      <span className="flex flex-col items-start gap-1 whitespace-normal">
        <span>{label}</span>
        {status}
      </span>
    </button>
  );
}
