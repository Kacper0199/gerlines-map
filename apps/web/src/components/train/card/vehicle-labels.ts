import { copyFor, LOCALE_TAGS, type Locale } from "@gerlines/i18n";
import { type VehicleCopy, vehicleCopyFor } from "@gerlines/i18n/vehicle";
import { VEHICLE_SEQUENCE_SOURCE, type VehicleIdentity } from "@gerlines/schema";

const DB_CLASS = /^DB Class (\d+(?:\.\d+)?)(?: and (\d+(?:\.\d+)?))?$/;

function numbersOf(vehicle: Pick<VehicleIdentity, "seriesName" | "br">): string[] | null {
  if (!vehicle.seriesName.startsWith("DB Class ")) return null;
  if (vehicle.br === null) return null;
  if (vehicle.br !== undefined) return vehicle.br.split(",").map((part) => part.trim());
  const match = DB_CLASS.exec(vehicle.seriesName);
  return match ? match.slice(1).filter((part): part is string => part !== undefined) : null;
}

/**
 * The catalogue names a series of the DB Class family "DB Class 422" and the API carries its
 * vehicle_series.br. German and Polish riders say Baureihe 422 and Seria DB 422, so those languages
 * build the name from the number. An answer without `br` (older than the field) falls back to the
 * number in the name; `br` null means the catalogue has none and the name stays. Product names
 * (ICE 3, Siemens Vectron) are the same in every language and stay as they are. The generic model of
 * a category (layer L4) has a name of GerLines' own making, so German and Polish translate it.
 */
export function seriesDisplayName(
  vehicle: Pick<VehicleIdentity, "seriesId" | "seriesName" | "br">,
  locale: Locale,
): string {
  if (locale !== "en") {
    const generic = vehicleCopyFor(locale).genericName(vehicle.seriesId);
    if (generic !== null) return generic;
  }
  const numbers = locale === "en" ? null : numbersOf(vehicle);
  if (numbers === null || numbers.length === 0) return vehicle.seriesName;
  const list = new Intl.ListFormat(LOCALE_TAGS[locale], { type: "conjunction", style: "long" });
  return vehicleCopyFor(locale).seriesBr(list.format(numbers), numbers.length);
}

/**
 * The source as the API names it from the catalogue. The two sources GerLines names itself read in
 * the language of the page; a source the API sends without a name is left out, never shown by id.
 */
export function sourceDisplayName(
  vehicle: Pick<VehicleIdentity, "source" | "sourceName">,
  copy: VehicleCopy,
): string | null {
  if (vehicle.source === "gerlines") return copy.sourceGerlines;
  if (vehicle.source === VEHICLE_SEQUENCE_SOURCE) return copy.sourceSequence;
  return vehicle.sourceName ?? null;
}

export function vehicleFactParts(
  vehicle: Pick<VehicleIdentity, "units" | "cars" | "lengthMetres">,
  locale: Locale,
): string[] {
  const copy = copyFor(locale);
  const length =
    vehicle.lengthMetres === null
      ? null
      : new Intl.NumberFormat(LOCALE_TAGS[locale], {
          style: "unit",
          unit: "meter",
          maximumFractionDigits: 0,
        }).format(vehicle.lengthMetres);
  return [
    vehicle.units === null ? null : vehicleCopyFor(locale).units(vehicle.units),
    vehicle.cars === null ? null : copy.train.vehicleCars(vehicle.cars),
    length,
  ].filter((part): part is string => part !== null);
}
