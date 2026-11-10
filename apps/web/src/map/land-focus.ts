import type { LandFacts } from "./geo-base.ts";
import { isLandCode, type LandCode } from "./style/map-styles.ts";

export interface FocusLook {
  readonly current: { readonly focus: LandCode | null };
  update(patch: { focus: LandCode | null }): void;
  laender(): Promise<readonly LandFacts[]>;
}

export interface FocusCamera {
  fitGermany(): void;
  fitLand(bounds: LandFacts["fit"]): void;
  alive(): boolean;
}

export async function focusLand(
  look: FocusLook,
  camera: FocusCamera,
  code: unknown,
): Promise<void> {
  if (code !== null && !isLandCode(code)) {
    return;
  }
  if (code === look.current.focus) {
    return;
  }
  look.update({ focus: code });
  if (code === null) {
    camera.fitGermany();
    return;
  }
  const land = (await look.laender()).find((entry) => entry.code === code);
  if (!land || !camera.alive() || look.current.focus !== code) {
    return;
  }
  camera.fitLand(land.fit);
}
