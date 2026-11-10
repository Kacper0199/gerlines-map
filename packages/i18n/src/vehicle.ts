import { type VehicleCopy, vehicleCopyFor } from "./copy-vehicle.ts";
import { useLocale } from "./react.ts";

export { type VehicleCopy, vehicleCopyFor } from "./copy-vehicle.ts";

export function useVehicleCopy(): VehicleCopy {
  return vehicleCopyFor(useLocale());
}
