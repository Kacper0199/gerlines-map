import { fitZoom, GERMANY_BOX } from "./soft-bounds.ts";

export interface Viewport {
  readonly width: number;
  readonly height: number;
  /** A card or panel holds the left slot, so the map view must stay clear of it. */
  readonly leftSlotOpen?: boolean;
}

export interface ViewPadding {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

const PHONE_SEARCH_CARD_BOTTOM = 172;
const PHONE_LIVE_BAR_TOP = 72;
const DEFAULT_SHEET_PEEK = 304;
const SHEET_CLEARANCE = 36;
const DESKTOP_PADDING: ViewPadding = { top: 24, bottom: 72, left: 412, right: 248 };
const STACKED_MAX_WIDTH = 1100;
const STACKED_TOP = 268;
const STACKED_SIDE = 16;
const SLOT_CLEARANCE = 392;

let measuredSheetPeek: number | null = null;

export function setSheetPeek(height: number | null): void {
  measuredSheetPeek = height;
}

function nationalZoom({ width, height }: Viewport, padding: ViewPadding): number {
  return fitZoom(GERMANY_BOX, { width, height, padding });
}

/**
 * Up to 1100 px wide the left cards and the right column leave at most 440 px of map between them.
 * When the screen is tall enough, the national view sits below both columns (on a compact screen the
 * folded style card and the collapsed legend end at 251 px) and uses the full width while the left slot is empty, which fits Germany larger.
 * With a panel or card in the left slot it keeps to the right of that slot instead of shrinking
 * between the two columns.
 */
function overviewPadding(viewport: Viewport): ViewPadding {
  if (viewport.width > STACKED_MAX_WIDTH) {
    return DESKTOP_PADDING;
  }
  const stacked: ViewPadding = {
    top: STACKED_TOP,
    bottom: DESKTOP_PADDING.bottom,
    left: viewport.leftSlotOpen ? SLOT_CLEARANCE : STACKED_SIDE,
    right: STACKED_SIDE,
  };
  return nationalZoom(viewport, stacked) > nationalZoom(viewport, DESKTOP_PADDING)
    ? stacked
    : DESKTOP_PADDING;
}

export function viewPadding(phone: boolean, withSheet: boolean, viewport?: Viewport): ViewPadding {
  if (phone) {
    const peek = measuredSheetPeek ?? DEFAULT_SHEET_PEEK;
    return {
      top: PHONE_SEARCH_CARD_BOTTOM,
      bottom: withSheet ? peek + SHEET_CLEARANCE : PHONE_LIVE_BAR_TOP,
      left: 12,
      right: 12,
    };
  }
  return withSheet || !viewport ? DESKTOP_PADDING : overviewPadding(viewport);
}
