/**
 * Product codes a route name may start with, the same list as `products.py` of the static import
 * (rule `delfi:name`). Used when a feed version has no `trip_product` rows yet.
 */
export const PRODUCT_CODES: ReadonlySet<string> = new Set([
  "ICE",
  "TGV",
  "THA",
  "RJX",
  "ES",
  "EST",
  "FR",
  "IC",
  "EC",
  "ECE",
  "ECM",
  "FLX",
  "RJ",
  "D",
  "EN",
  "NJ",
  "RE",
  "IRE",
  "MEX",
  "FEX",
  "RX",
  "REX",
  "HBX",
  "EX",
  "IR",
  "RR",
  "S",
  "RS",
  "RB",
  "R",
  "OS",
  "SP",
]);

/** Codes written in mixed case where they come from (Czech Osobní and Spěšný vlak). */
const CANONICAL: ReadonlyMap<string, string> = new Map([
  ["OS", "Os"],
  ["SP", "Sp"],
]);

const PREFIX = /^(\p{L}+)/u;
const NIGHT_LINE = /^\d+N$/;

/** The product a route name starts with ("RE" of "RE10" or "Re 1", "ICE" of "ICE 42"), else null. */
export function routeProduct(line: string | null): string | null {
  const text = line?.trim() ?? "";
  if (text === "" || NIGHT_LINE.test(text)) return null;
  const code = PREFIX.exec(text)?.[1]?.toUpperCase();
  if (!code || !PRODUCT_CODES.has(code)) return null;
  return CANONICAL.get(code) ?? code;
}
