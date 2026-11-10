import {
  type ComponentType,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/cn.ts";
import { Button, type ButtonProps } from "../ui/button.tsx";
import type { IconButtonTooltipProps } from "./icon-button-tooltip.tsx";

const loadTooltip = () => import("./icon-button-tooltip.tsx");
const IconButtonTooltip = lazy<ComponentType<IconButtonTooltipProps>>(() =>
  loadTooltip().catch(() => ({ default: () => null })),
);

const SHOW_DELAY_MS = 300;
const CLOSE_DELAY_MS = 150;
const GROUP_WINDOW_MS = 600;
let lastClosedAt = Number.NEGATIVE_INFINITY;

export interface IconButtonProps extends Omit<ButtonProps, "size" | "aria-label"> {
  readonly label: string;
  readonly tooltip?: boolean;
  readonly tooltipSide?: "top" | "bottom";
}

type PointerEventOf = Parameters<NonNullable<ButtonProps["onPointerEnter"]>>[0];
type FocusEventOf = Parameters<NonNullable<ButtonProps["onFocus"]>>[0];

function focusIsVisible(element: HTMLElement): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}

function assign(ref: ButtonProps["ref"], node: HTMLButtonElement | null): void {
  if (typeof ref === "function") ref(node);
  else if (ref) (ref as { current: HTMLButtonElement | null }).current = node;
}

/**
 * An icon button with an accessible name. With `tooltip` the name also shows on hover and on keyboard focus;
 * the tooltip and its positioning code load on the first hover or focus, so a page that never points at the button
 * does not download them, and the button element itself is never replaced. The tooltip stays while the pointer
 * moves onto it and closes on Escape from anywhere (WCAG 1.4.13); if its chunk cannot be loaded the button simply has
 * no tooltip.
 */
export function IconButton({
  label,
  tooltip = false,
  tooltipSide = "top",
  variant = "quiet",
  className,
  children,
  ref: callerRef,
  onPointerEnter,
  onPointerLeave,
  onPointerDown,
  onPointerUp,
  onFocus,
  onBlur,
  ...props
}: IconButtonProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [requested, setRequested] = useState(false);
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pressing = useRef(false);

  const mergedRef = useCallback(
    (node: HTMLButtonElement | null) => {
      setAnchor(node);
      assign(callerRef, node);
    },
    [callerRef],
  );

  const visible = (next: boolean) => {
    if (openRef.current && !next) lastClosedAt = performance.now();
    openRef.current = next;
    setOpen(next);
  };
  const hide = () => {
    clearTimeout(timer.current);
    visible(false);
  };
  const hideSoon = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => visible(false), CLOSE_DELAY_MS);
  };
  const show = (immediately: boolean) => {
    setRequested(true);
    clearTimeout(timer.current);
    const grouped = performance.now() - lastClosedAt < GROUP_WINDOW_MS;
    if (immediately || grouped) {
      visible(true);
      return;
    }
    timer.current = setTimeout(() => visible(true), SHOW_DELAY_MS);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const hover = tooltip
    ? {
        onPointerEnter: (event: PointerEventOf) => {
          onPointerEnter?.(event);
          if (event.pointerType === "touch") return;
          void loadTooltip().catch(() => undefined);
          show(false);
        },
        onPointerLeave: (event: PointerEventOf) => {
          onPointerLeave?.(event);
          pressing.current = false;
          if (openRef.current) hideSoon();
          else hide();
        },
        onPointerDown: (event: PointerEventOf) => {
          onPointerDown?.(event);
          pressing.current = true;
          hide();
        },
        onPointerUp: (event: PointerEventOf) => {
          onPointerUp?.(event);
          pressing.current = false;
        },
        onFocus: (event: FocusEventOf) => {
          onFocus?.(event);
          if (pressing.current || !focusIsVisible(event.currentTarget)) return;
          void loadTooltip().catch(() => undefined);
          show(true);
        },
        onBlur: (event: FocusEventOf) => {
          onBlur?.(event);
          pressing.current = false;
          hide();
        },
      }
    : { onPointerEnter, onPointerLeave, onPointerDown, onPointerUp, onFocus, onBlur };

  return (
    <>
      <Button
        ref={tooltip ? mergedRef : callerRef}
        variant={variant}
        size="icon"
        aria-label={label}
        className={cn(className)}
        {...props}
        {...hover}
      >
        {children}
      </Button>
      {tooltip && requested && anchor ? (
        <Suspense fallback={null}>
          <IconButtonTooltip
            anchor={anchor}
            open={open}
            label={label}
            side={tooltipSide}
            onPopupEnter={() => clearTimeout(timer.current)}
            onPopupLeave={hideSoon}
          />
        </Suspense>
      ) : null}
    </>
  );
}
