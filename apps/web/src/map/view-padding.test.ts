import { afterEach, describe, expect, it } from "vitest";
import { fitZoom, GERMANY_BOX } from "./soft-bounds.ts";
import { setSheetPeek, viewPadding } from "./view-padding.ts";

afterEach(() => setSheetPeek(null));

describe("viewPadding", () => {
  it("keeps the phone view below the search card and above the live bar or the sheet", () => {
    expect(viewPadding(true, false)).toEqual({ top: 172, bottom: 72, left: 12, right: 12 });
    expect(viewPadding(true, true).bottom).toBe(340);
  });

  it("keeps the selected train above the peek the open sheet measured", () => {
    setSheetPeek(388);
    expect(viewPadding(true, true).bottom).toBe(424);
    expect(viewPadding(true, false).bottom).toBe(72);
    setSheetPeek(null);
    expect(viewPadding(true, true).bottom).toBe(340);
  });

  it("keeps the desktop view clear of the left cards and the right column", () => {
    expect(viewPadding(false, true)).toEqual({ top: 24, bottom: 72, left: 412, right: 248 });
  });
});

describe("viewPadding of the national overview on tablets", () => {
  const desktop = { top: 24, bottom: 72, left: 412, right: 248 };
  const stacked = { top: 268, bottom: 72, left: 16, right: 16 };
  const nationalZoom = (width: number, height: number) => {
    const padding = viewPadding(false, false, { width, height });
    return fitZoom(GERMANY_BOX, { width, height, padding });
  };

  it("puts the national view below both columns on a tablet in portrait", () => {
    expect(viewPadding(false, false, { width: 834, height: 1194 })).toEqual(stacked);
    expect(viewPadding(false, false, { width: 768, height: 1024 })).toEqual(stacked);
  });

  it("starts below the right column, which ends at 251 px on a compact screen with the style card folded", () => {
    expect(viewPadding(false, false, { width: 834, height: 1194 }).top).toBeGreaterThan(251);
  });

  it("fits Germany at least twice as large as the side paddings would on 834 by 1194", () => {
    const view = { width: 834, height: 1194 };
    const withSides = fitZoom(GERMANY_BOX, { ...view, padding: desktop });

    expect(withSides).toBeLessThan(4);
    expect(nationalZoom(view.width, view.height)).toBeGreaterThan(withSides + 1);
  });

  it("leaves the whole width of Germany inside the 834 px view", () => {
    const zoom = nationalZoom(834, 1194);
    const germanyWidthPx = ((GERMANY_BOX.east - GERMANY_BOX.west) / 360) * 512 * 2 ** zoom;

    expect(germanyWidthPx).toBeLessThanOrEqual(834 - 2 * 16);
    expect(zoom).toBeGreaterThan(5.3);
  });

  it("keeps the side paddings in landscape, where the columns leave room", () => {
    expect(viewPadding(false, false, { width: 1194, height: 834 })).toEqual(desktop);
    expect(viewPadding(false, false, { width: 1024, height: 768 })).toEqual(desktop);
    expect(viewPadding(false, false, { width: 1440, height: 900 })).toEqual(desktop);
    expect(viewPadding(false, false, { width: 2560, height: 1440 })).toEqual(desktop);
  });

  it("keeps the side paddings above 1100 px wide even when the screen is tall", () => {
    expect(viewPadding(false, false, { width: 1180, height: 1700 })).toEqual(desktop);
  });

  describe("with a panel or card in the left slot", () => {
    const slotStacked = { top: 268, bottom: 72, left: 392, right: 16 };

    it("keeps Germany clear of the slot and below the right column, right of the slot, at 834 by 1194", () => {
      const view = { width: 834, height: 1194, leftSlotOpen: true };
      expect(viewPadding(false, false, view)).toEqual(slotStacked);
      expect(viewPadding(false, false, { ...view, leftSlotOpen: false })).toEqual(stacked);
    });

    it("draws Germany at least 1.5 times as wide as the side paddings would", () => {
      const view = { width: 834, height: 1194 };
      const zoomOf = (padding: typeof desktop) => fitZoom(GERMANY_BOX, { ...view, padding });
      expect(zoomOf(slotStacked) - zoomOf(desktop)).toBeGreaterThan(Math.log2(1.5));
    });

    it("keeps the side paddings where the stacked view would be smaller", () => {
      expect(viewPadding(false, false, { width: 1194, height: 834, leftSlotOpen: true })).toEqual(
        desktop,
      );
      expect(viewPadding(false, false, { width: 1024, height: 768, leftSlotOpen: true })).toEqual(
        desktop,
      );
    });
  });

  it("keeps the side paddings for a selected train, which must stay clear of the left card", () => {
    expect(viewPadding(false, true, { width: 834, height: 1194 })).toEqual(desktop);
  });

  it("keeps the side paddings when no viewport is known", () => {
    expect(viewPadding(false, false)).toEqual(desktop);
  });

  it("leaves the phone alone", () => {
    expect(viewPadding(true, false, { width: 390, height: 844 })).toEqual({
      top: 172,
      bottom: 72,
      left: 12,
      right: 12,
    });
  });
});
