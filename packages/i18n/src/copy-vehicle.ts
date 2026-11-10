import type { Locale } from "./locale.ts";
import { m } from "./paraglide/messages.js";

export function createVehicleCopy(locale: Locale) {
  const o = { locale };
  const generic: Readonly<Record<string, string>> = {
    "generic-hsr": m.vehicle_generic_hsr({}, o),
    "generic-ld": m.vehicle_generic_ld({}, o),
    "generic-dd-coach": m.vehicle_generic_dd_coach({}, o),
    "generic-reg-emu": m.vehicle_generic_reg_emu({}, o),
    "generic-reg-dd": m.vehicle_generic_reg_dd({}, o),
    "generic-dmu": m.vehicle_generic_dmu({}, o),
    "generic-sbahn": m.vehicle_generic_sbahn({}, o),
  };
  return {
    genericName: (modelId: string): string | null => generic[modelId] ?? null,
    units: (count: number) => m.vehicle_units({ count }, o),
    seriesBr: (br: string, count: number) => m.vehicle_series_br({ br, count }, o),
    sourceGerlines: m.vehicle_source_gerlines({}, o),
    sourceSequence: m.vehicle_source_sequence({}, o),
  };
}

export type VehicleCopy = ReturnType<typeof createVehicleCopy>;

const cache = new Map<Locale, VehicleCopy>();

export function vehicleCopyFor(locale: Locale): VehicleCopy {
  let copy = cache.get(locale);
  if (copy === undefined) {
    copy = createVehicleCopy(locale);
    cache.set(locale, copy);
  }
  return copy;
}
