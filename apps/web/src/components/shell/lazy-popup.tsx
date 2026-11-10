import { Component, type ReactNode, Suspense, useRef, useState } from "react";

/** Renders nothing when its children throw, so a popup chunk that cannot load leaves the page as it was. */
class QuietBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

export interface LazyPopup {
  readonly anchor: HTMLElement | null;
  readonly open: boolean;
  readonly requested: boolean;
  readonly setOpen: (open: boolean) => void;
  /** Props for the plain trigger button: it stays the same element while the popup loads and after. */
  readonly triggerProps: {
    readonly ref: (node: HTMLElement | null) => void;
    readonly "aria-haspopup": "dialog";
    readonly "aria-expanded": boolean;
    readonly onPointerEnter: () => void;
    readonly onFocus: () => void;
    readonly onPointerDown: () => void;
    readonly onClick: () => void;
  };
}

/**
 * The state of a popup whose trigger is a plain button and whose body (Base UI's popover and its positioning code) loads
 * on the first press: a hover or focus preloads it, a press asks for it, and the button is never replaced, so focus stays
 * on it. A press while the popup is open closes it (the popup's outside press fires first, which `wasOpen` remembers).
 */
export function useLazyPopup(preload: () => void, onOpen?: () => void): LazyPopup {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [requested, setRequested] = useState(false);
  const [open, setOpen] = useState(false);
  const wasOpen = useRef(false);
  return {
    anchor,
    open,
    requested,
    setOpen,
    triggerProps: {
      ref: setAnchor,
      "aria-haspopup": "dialog",
      "aria-expanded": open,
      onPointerEnter: preload,
      onFocus: preload,
      onPointerDown: () => {
        wasOpen.current = open;
      },
      onClick: () => {
        const next = !wasOpen.current;
        wasOpen.current = false;
        if (next) {
          onOpen?.();
          setRequested(true);
        }
        setOpen(next);
      },
    },
  };
}

/** The popup, once asked for; it renders nothing while loading and if loading fails. */
export function LazyPopupSlot({ popup, children }: { popup: LazyPopup; children: ReactNode }) {
  if (!(popup.requested && popup.anchor)) return null;
  return (
    <QuietBoundary>
      <Suspense fallback={null}>{children}</Suspense>
    </QuietBoundary>
  );
}
