import {
  createContext,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useContext,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/cn.ts";
import { SHEET_EXPANDED_INSET, SHEET_PEEK_HEIGHT } from "../../theme/tokens.ts";

/** The shell publishes the bottom edge of the cards above the sheet here; the token is the fallback. */
const SHEET_INSET = `var(--gl-sheet-inset, ${SHEET_EXPANDED_INSET}px)`;

export type SheetState = "peek" | "expanded";

const DRAG_THRESHOLD_PX = 40;

const SheetStateContext = createContext<SheetState>("peek");

export function useSheetState(): SheetState {
  return useContext(SheetStateContext);
}

export function SheetMore({ children, className }: { children: ReactNode; className?: string }) {
  const hidden = useSheetState() === "peek";
  return (
    <div inert={hidden} aria-hidden={hidden || undefined} className={className}>
      {children}
    </div>
  );
}

export interface BottomSheetProps {
  readonly label: string;
  readonly expandLabel: string;
  readonly collapseLabel: string;
  readonly expanded?: boolean;
  readonly defaultExpanded?: boolean;
  readonly onExpandedChange?: (expanded: boolean) => void;
  readonly position?: "fixed" | "absolute";
  readonly peekHeight?: number;
  readonly expandedHeight?: string;
  readonly expandedFit?: "viewport" | "content";
  /** False when the sheet has nothing more to show: no handle, and the height follows the content. */
  readonly expandable?: boolean;
  /** False when Escape belongs to the content (a list that closes with it): the sheet then leaves the key alone. */
  readonly collapseOnEscape?: boolean;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}

export function BottomSheet({
  label,
  expandLabel,
  collapseLabel,
  expanded,
  defaultExpanded = false,
  onExpandedChange,
  position = "fixed",
  peekHeight = SHEET_PEEK_HEIGHT,
  expandedHeight = `calc(100dvh - ${SHEET_INSET})`,
  expandedFit = "viewport",
  expandable = true,
  collapseOnEscape = true,
  leading,
  trailing,
  className,
  children,
}: BottomSheetProps) {
  const [inner, setInner] = useState(defaultExpanded);
  const isExpanded = expanded ?? inner;
  const dragStart = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const handle = useRef<HTMLButtonElement>(null);

  function setExpanded(next: boolean) {
    if (expanded === undefined) {
      setInner(next);
    }
    onExpandedChange?.(next);
  }

  function onPointerDown(event: PointerEvent<HTMLButtonElement>) {
    dragStart.current = event.clientY;
    suppressClick.current = false;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function endDrag() {
    dragStart.current = null;
  }

  function onPointerUp(event: PointerEvent<HTMLButtonElement>) {
    const start = dragStart.current;
    endDrag();
    if (start === null) {
      return;
    }
    const travelled = event.clientY - start;
    if (Math.abs(travelled) >= DRAG_THRESHOLD_PX) {
      suppressClick.current = true;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      setExpanded(travelled < 0);
    }
  }

  function onClick() {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    setExpanded(!isExpanded);
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && isExpanded && collapseOnEscape) {
      event.preventDefault();
      setExpanded(false);
      handle.current?.focus();
    }
  }

  const state: SheetState = isExpanded && expandable ? "expanded" : "peek";
  const fitsContent = !expandable || (isExpanded && expandedFit === "content");
  const height = fitsContent ? "auto" : isExpanded ? expandedHeight : `${peekHeight}px`;
  return (
    <section
      aria-label={label}
      data-slot="bottom-sheet"
      data-state={state}
      onKeyDown={onKeyDown}
      style={{
        height,
        ...(fitsContent ? { maxHeight: `calc(100dvh - ${SHEET_INSET})` } : {}),
      }}
      className={cn(
        "card-surface inset-x-0 bottom-0 flex flex-col overflow-hidden rounded-b-none rounded-t-2xl border-b-0 [interpolate-size:allow-keywords] transition-[height] duration-(--gl-duration-panel) ease-(--gl-ease-out)",
        position === "fixed" ? "fixed" : "absolute",
        className,
      )}
    >
      <div data-slot="bottom-sheet-head" className="flex h-target shrink-0 items-center px-4">
        <div className="flex min-w-0 flex-1 items-center">{leading}</div>
        {expandable ? (
          <button
            ref={handle}
            type="button"
            data-slot="bottom-sheet-handle"
            aria-expanded={isExpanded}
            aria-label={isExpanded ? collapseLabel : expandLabel}
            onClick={onClick}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerCancel={endDrag}
            onLostPointerCapture={endDrag}
            className="focus-ring group/handle grid h-target w-16 shrink-0 touch-none place-items-center rounded-md"
          >
            <span aria-hidden="true" className="h-1 w-10 rounded-sm bg-passed" />
          </button>
        ) : (
          <span aria-hidden="true" className="h-target w-16 shrink-0" />
        )}
        <div className="-mr-3 flex min-w-0 flex-1 items-center justify-end">{trailing}</div>
      </div>
      <SheetStateContext.Provider value={state}>
        <div
          className={cn(
            "min-h-0 flex-1 overscroll-contain",
            state === "expanded" || !expandable ? "overflow-y-auto" : "overflow-hidden",
          )}
        >
          {children}
        </div>
      </SheetStateContext.Provider>
    </section>
  );
}
