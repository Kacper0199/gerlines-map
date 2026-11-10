import type { CarFrame } from "../cars/car-instances.ts";
import type { DelayClass } from "../modes/delay.ts";
import type { OperatorGroup } from "../modes/operator-groups.ts";
import type { CategoryKey } from "./categories.ts";

export type Rgb = readonly [number, number, number];

export interface Palette {
  readonly fill: Readonly<Record<CategoryKey, Rgb>>;
  readonly land: Rgb;
  /** Colours of the delay colour mode. */
  readonly delay?: Readonly<Record<DelayClass, Rgb>>;
  /** Colours of the operator colour mode. */
  readonly operator?: Readonly<Record<OperatorGroup, Rgb>>;
}

export const POSITION_STRIDE = 3;

export interface FrameGroup {
  readonly hollow: boolean;
  readonly count: number;
  /** Longitude, latitude (degrees) and height (metres) of each train: `POSITION_STRIDE` numbers per train. */
  readonly positions: Float32Array | Float64Array;
  readonly iconAngles: Float32Array;
  readonly sizes: Float32Array;
  readonly fillColors: Uint8Array;
  readonly lineColors: Uint8Array;
  readonly ids: string[] | undefined;
  /** The label of each train beside `ids`, only while a label mode is on. */
  readonly labels?: string[] | undefined;
}

export interface SelectedFrame {
  readonly id: string;
  readonly lon: number;
  readonly lat: number;
  readonly bearing: number;
  /** Height on the relief in metres (0 where the map is flat). */
  readonly z: number;
  readonly alpha: number;
  readonly legKey: string;
  readonly vertex: number;
}

export interface Frame {
  readonly groups: readonly FrameGroup[];
  readonly selected: SelectedFrame | null;
  /** 3D cars of the trains nearest the view centre from zoom 14.25. */
  readonly cars?: CarFrame;
}

export interface EngineStats {
  readonly trips: number;
  readonly realtime: number;
  readonly counts: Readonly<Record<CategoryKey, number>>;
  /** Trains per delay class, for the legend of the delay colour mode. */
  readonly delayCounts?: Readonly<Record<DelayClass, number>>;
  /** Trains per operator group, for the legend of the operator colour mode. */
  readonly operatorCounts?: Readonly<Record<OperatorGroup, number>>;
  readonly untracked: number;
}
