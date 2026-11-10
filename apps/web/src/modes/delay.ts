export const DELAY_CLASSES = ["ok", "minor", "major", "severe", "none", "foreign"] as const;

export type DelayClass = (typeof DELAY_CLASSES)[number];

export const MINOR_FROM_S = 180;
export const MAJOR_FROM_S = 360;
export const SEVERE_FROM_S = 900;

/** Later classes are drawn over earlier ones, so a late train is never hidden under an on time one. */
export const DELAY_DRAW_ORDER: Readonly<Record<DelayClass, number>> = {
  foreign: 0,
  none: 1,
  ok: 2,
  minor: 3,
  major: 4,
  severe: 5,
};

export interface DelaySource {
  readonly delay: number | null;
  readonly realtime: boolean;
  readonly foreign: boolean;
}

/**
 * The delay colour class of a train. A train without realtime data or without a delay value is
 * `none` (missing), never `ok`; a foreign train keeps its own class because its feed is not
 * compared with ours.
 */
export function delayClassOf({ delay, realtime, foreign }: DelaySource): DelayClass {
  if (foreign) return "foreign";
  if (!realtime || delay === null) return "none";
  if (delay >= SEVERE_FROM_S) return "severe";
  if (delay >= MAJOR_FROM_S) return "major";
  if (delay >= MINOR_FROM_S) return "minor";
  return "ok";
}
