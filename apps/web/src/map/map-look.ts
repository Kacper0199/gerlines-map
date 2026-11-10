import type { ExpressionSpecification, Map as MapLibreMap, StyleSpecification } from "maplibre-gl";
import {
  EMPTY_POINTS,
  type GeoFiles,
  type LandFacts,
  landLabelPoints,
  type PointCollection,
  readLaender,
} from "./geo-base.ts";
import { buildStyle, focusOf, type GeoData } from "./style/build-style.ts";
import { labelKindOf, labelText } from "./style/layer-kit.ts";
import type { LandCode, MapStyleKind } from "./style/map-styles.ts";

export interface LookState {
  readonly style: MapStyleKind;
  readonly labelLanguage: string;
  readonly focus: LandCode | null;
  readonly terrain3d: boolean;
  readonly buildings: boolean;
}

export type LookMap = Pick<
  MapLibreMap,
  "on" | "once" | "setStyle" | "getLayer" | "setLayoutProperty"
>;

export function lookStyle(
  state: LookState,
  assetBaseUrl: string,
  landLabels: PointCollection = EMPTY_POINTS,
  geo: GeoData = {},
): StyleSpecification {
  return buildStyle({ ...state, assetBaseUrl, landLabels, geo });
}

export class MapLook {
  private readonly map: LookMap;
  private readonly files: GeoFiles;
  private readonly assetBaseUrl: string;
  private state: LookState;
  private spec: StyleSpecification;
  private landLabels: PointCollection = EMPTY_POINTS;
  private laenderRequest: Promise<readonly LandFacts[]> | undefined;
  private relabelRetried = false;
  private disposed = false;

  constructor(
    map: LookMap,
    state: LookState,
    assetBaseUrl: string,
    files: GeoFiles,
    spec: StyleSpecification,
  ) {
    this.map = map;
    this.state = state;
    this.assetBaseUrl = assetBaseUrl;
    this.files = files;
    this.spec = spec;
    map.on("style.load", () => this.applyLabelLanguage());
  }

  get current(): LookState {
    return this.state;
  }

  update(patch: Partial<LookState>): void {
    const next = { ...this.state, ...patch };
    const changed = (Object.keys(next) as (keyof LookState)[]).filter(
      (key) => next[key] !== this.state[key],
    );
    if (changed.length === 0) {
      return;
    }
    this.state = next;
    if (changed.length === 1 && changed[0] === "labelLanguage") {
      this.spec = this.build();
      this.relabelRetried = false;
      this.applyLabelLanguage();
      return;
    }
    const focus = focusOf(this.state);
    if (focus !== null && !this.files.data.landMasks?.[focus]) {
      void this.files.landMask(focus).then(() => {
        if (focusOf(this.state) === focus) {
          this.apply();
        }
      });
      return;
    }
    this.apply();
  }

  laender(): Promise<readonly LandFacts[]> {
    if (!this.laenderRequest) {
      this.laenderRequest = this.files.national().then((geo) => {
        const facts = readLaender(geo.laender);
        if (facts.length === 0) {
          this.laenderRequest = undefined;
        }
        this.landLabels = landLabelPoints(facts);
        this.apply();
        return facts;
      });
    }
    return this.laenderRequest;
  }

  dispose(): void {
    this.disposed = true;
  }

  private build(): StyleSpecification {
    return lookStyle(this.state, this.assetBaseUrl, this.landLabels, this.files.data);
  }

  private apply(): void {
    if (this.disposed) {
      return;
    }
    this.spec = this.build();
    this.map.setStyle(this.spec, { diff: true });
  }

  private applyLabelLanguage(): void {
    if (this.disposed) {
      return;
    }
    let failed = false;
    for (const layer of this.spec.layers) {
      const kind = labelKindOf(layer);
      if (!(kind && this.map.getLayer(layer.id))) {
        continue;
      }
      try {
        const text = labelText(kind, this.state.labelLanguage) as ExpressionSpecification;
        this.map.setLayoutProperty(layer.id, "text-field", text);
      } catch {
        failed = true;
      }
    }
    if (failed && !this.relabelRetried) {
      this.relabelRetried = true;
      this.map.once("idle", () => this.applyLabelLanguage());
    }
  }
}
