import type { Tier } from "./protocol.ts";

export interface LodThresholds {
  icons: number;
  slices: number;
  cars: number;
  crossfadeZoom: number;
}

export const ARCHITECTURE_THRESHOLDS: LodThresholds = {
  icons: 9,
  slices: 12.5,
  cars: 14.5,
  crossfadeZoom: 0.5,
};

export interface TierOpacity {
  tier: Tier;
  opacity: number;
}

function fade(value: number, start: number, end: number): number {
  if (!(end > start)) return value >= end ? 1 : 0;
  return Math.min(1, Math.max(0, (value - start) / (end - start)));
}

export function tierPlan(zoom: number, thresholds: LodThresholds): TierOpacity[] {
  const half = Math.max(0, thresholds.crossfadeZoom) / 2;
  const bands: { tier: Tier; from: number; to: number }[] = [
    { tier: "dots", from: Number.NEGATIVE_INFINITY, to: thresholds.icons },
    { tier: "icons", from: thresholds.icons, to: thresholds.slices },
    { tier: "slices", from: thresholds.slices, to: thresholds.cars },
    { tier: "cars", from: thresholds.cars, to: Number.POSITIVE_INFINITY },
  ];
  const plan: TierOpacity[] = [];
  for (const band of bands) {
    const fadeIn = Number.isFinite(band.from) ? fade(zoom, band.from - half, band.from + half) : 1;
    const fadeOut = Number.isFinite(band.to) ? 1 - fade(zoom, band.to - half, band.to + half) : 1;
    const opacity = Math.min(fadeIn, fadeOut);
    if (opacity > 0) plan.push({ tier: band.tier, opacity });
  }
  return plan;
}
