import {
  JOURNEY_CATEGORIES,
  JOURNEY_MAX_CHANGES_MAX,
  JOURNEY_OPERATOR_TERM_MAX,
  JOURNEY_OPERATOR_TERM_MIN,
  JOURNEY_OPERATOR_TERMS_MAX,
  JOURNEY_RESULTS_DEFAULT,
  JOURNEY_RESULTS_MAX,
  JOURNEY_SORTS,
  LONG_DISTANCE_PRODUCTS,
} from "@gerlines/schema/journeys";
import { STOP_ID_PATTERN } from "@gerlines/schema/search";
import { z } from "zod";

const PAGE_CURSOR = /^(EARLIER|LATER)\|\d{1,12}$/;
const OPERATOR_TERM = new RegExp(
  `^[\\p{L}\\p{N}][\\p{L}\\p{N} .&-]{${JOURNEY_OPERATOR_TERM_MIN - 1},${JOURNEY_OPERATOR_TERM_MAX - 1}}$`,
  "u",
);

function splitList(text: string): string[] {
  return text.trim() === "" ? [] : text.split(",").map((part) => part.trim());
}

function commaList<T extends string>(values: readonly [T, ...T[]]) {
  return z
    .string()
    .transform(splitList)
    .pipe(z.array(z.enum(values)))
    .transform((list) => [...new Set(list)]);
}

const operatorTerms = z
  .string()
  .transform(splitList)
  .pipe(
    z
      .array(z.string().regex(OPERATOR_TERM, "must be 2 to 40 letters, digits, spaces, . & or -"))
      .max(JOURNEY_OPERATOR_TERMS_MAX),
  )
  .transform((list) => [...new Set(list)]);

function smallInteger(min: number, max: number) {
  return z
    .string()
    .regex(/^\d{1,2}$/, "must be a whole number")
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));
}

const booleanText = z.enum(["true", "false"]).transform((text) => text === "true");

export const journeyQuerySchema = z
  .object({
    from: z
      .string()
      .regex(STOP_ID_PATTERN, "must be a stop id")
      .describe(
        "DELFI feed stop id of the origin, the stopId of a search answer, for example de:11000:900003201 or ch:1:sloid:10",
      ),
    to: z
      .string()
      .regex(STOP_ID_PATTERN, "must be a stop id")
      .describe(
        "DELFI feed stop id of the destination, the stopId of a search answer, for example de:02000:10950",
      ),
    time: z.iso
      .datetime({ offset: true })
      .optional()
      .describe(
        "Departure time, or arrival time with arriveBy, with an offset, for example 2026-10-27T06:00:00Z or 2026-10-27T07:00:00%2B01:00; a plus sent unencoded is read as the offset sign. Now when left out",
      ),
    arriveBy: booleanText.default(false).describe("true when time is the latest arrival"),
    categories: commaList(JOURNEY_CATEGORIES)
      .optional()
      .describe(
        "Comma list of categories every leg must belong to (hsr, ld, night, rfast, reg, sbahn, urban, bus, other); all when left out. rfast without reg keeps RE and drops RB",
      ),
    exclude: commaList(LONG_DISTANCE_PRODUCTS)
      .default([])
      .describe("Comma list of long-distance products to leave out: ic (DB IC and EC), flx"),
    operators: operatorTerms
      .default([])
      .describe(
        "Comma list of operator names: every leg must run with one of them. A name matches an operator whose name has a word starting with it, ignoring case and accents",
      ),
    avoidOperators: operatorTerms
      .default([])
      .describe("Comma list of operator names no leg may run with, matched like operators"),
    maxChanges: smallInteger(0, JOURNEY_MAX_CHANGES_MAX)
      .optional()
      .describe("Most changes between trains; 0 asks for direct trains only"),
    sort: z
      .enum(JOURNEY_SORTS)
      .optional()
      .describe(
        "Order of the journeys: fastest, fewestChanges, earliestArrival or latestDeparture; earliestArrival by default, latestDeparture with arriveBy",
      ),
    results: smallInteger(1, JOURNEY_RESULTS_MAX)
      .default(JOURNEY_RESULTS_DEFAULT)
      .describe(
        "At least this many journeys are wanted, when the router has them: when filters remove journeys, further pages are searched until this many remain, at most three router calls. The answer may hold more, all journeys of the pages searched that pass the filters",
      ),
    geometry: booleanText
      .default(false)
      .describe(
        "true adds each train leg's route line on the track (Google polyline, precision 5, simplified to 4 m)",
      ),
    cursor: z
      .string()
      .regex(PAGE_CURSOR, "must be a cursor from an earlier answer")
      .optional()
      .describe("earlierCursor or laterCursor of an earlier answer to the same query"),
  })
  .refine((query) => query.from !== query.to, {
    message: "from and to must differ",
    path: ["to"],
  })
  .refine((query) => query.categories === undefined || query.categories.length > 0, {
    message: "choose at least one category",
    path: ["categories"],
  });

const TIME_WITH_DECODED_PLUS = /^(\d{4}-\d{2}-\d{2}T[\d:.]+) (\d{2}(?::?\d{2})?)$/;

/**
 * A `+` in a query string is decoded as a space, so an offset sent unencoded
 * (`07:00:00+01:00`) arrives as `07:00:00 01:00`; this puts the sign back before validation.
 */
export function restoreTimeOffset(
  params: Readonly<Record<string, string>>,
): Record<string, string> {
  const time = params.time;
  if (time === undefined) {
    return { ...params };
  }
  return { ...params, time: time.replace(TIME_WITH_DECODED_PLUS, "$1+$2") };
}

export type JourneyQueryInput = z.input<typeof journeyQuerySchema>;
export type JourneyQuery = z.output<typeof journeyQuerySchema>;
