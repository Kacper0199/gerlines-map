import type { CategoryKey } from "../../motion/categories.ts";
import type { LiveSelectionInfo } from "../../motion/protocol.ts";

const LETTERS_ONLY = /^[A-Za-z]+$/;
const DIGITS_ONLY = /^\d+$/;
const LEADING_LETTERS = /^[A-Za-z]+/;
const LONG_DISTANCE: ReadonlySet<CategoryKey> = new Set(["hsr", "ld", "night"]);

export interface NamingLabels {
  readonly line: (line: string) => string;
  readonly trainNumber: (number: string) => string;
}

/** What the naming reads: the frame's selection info and a list row carry these three. */
export type NamingSource = Pick<LiveSelectionInfo, "category" | "line" | "trainNumber">;

export interface FrameNaming {
  readonly title: string | null;
  readonly subtitle: string | null;
}

/** The product letters the data carries in the line (IC35 gives IC); never guessed from the category. */
function productOf(line: string | null): string | null {
  if (line === null) return null;
  return LETTERS_ONLY.test(line) ? line : (LEADING_LETTERS.exec(line)?.[0] ?? null);
}

function longDistanceNaming(
  info: NamingSource,
  line: string | null,
  labels: NamingLabels,
): FrameNaming {
  const { trainNumber } = info;
  if (trainNumber === null) {
    if (line === null) return { title: null, subtitle: null };
    return { title: DIGITS_ONLY.test(line) ? labels.line(line) : line, subtitle: null };
  }
  const product = productOf(line);
  return {
    title: product === null ? labels.trainNumber(String(trainNumber)) : `${product} ${trainNumber}`,
    subtitle: line !== null && line !== product ? labels.line(line) : null,
  };
}

function regionalNaming(
  info: NamingSource,
  line: string | null,
  labels: NamingLabels,
): FrameNaming {
  const { trainNumber } = info;
  const number = trainNumber === null ? null : String(trainNumber);
  if (line === null) {
    return { title: number === null ? null : labels.trainNumber(number), subtitle: null };
  }
  if (LETTERS_ONLY.test(line) && number !== null)
    return { title: `${line} ${number}`, subtitle: null };
  return {
    title: DIGITS_ONLY.test(line) ? labels.line(line) : line,
    subtitle: number === null ? null : labels.trainNumber(number),
  };
}

/**
 * The title and the secondary line of a frame train: long distance trains by the product the line
 * carries and the train number (ICE 953), or by the word Train and the number when it carries none, with the line below, other trains by line (RE 1) with the train number below.
 * A bare number never stands alone as the title.
 */
export function frameTrainNaming(info: NamingSource, labels: NamingLabels): FrameNaming {
  const line = info.line === null || info.line === "" ? null : info.line;
  return LONG_DISTANCE.has(info.category)
    ? longDistanceNaming(info, line, labels)
    : regionalNaming(info, line, labels);
}
