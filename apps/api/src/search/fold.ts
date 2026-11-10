const SPECIAL_LETTERS: ReadonlyMap<string, string> = new Map([
  ["ß", "ss"],
  ["ł", "l"],
  ["đ", "d"],
  ["ø", "o"],
  ["æ", "ae"],
  ["œ", "oe"],
  ["ı", "i"],
]);

const COMBINING_MARKS = /\p{M}+/gu;
const NOT_ALPHANUMERIC = /[^\p{L}\p{N}]+/gu;
const GERMAN_DIGRAPHS = /([aou])e/g;
const LETTER_DIGIT = /(\p{L})(\p{N})|(\p{N})(\p{L})/gu;

const ABBREVIATIONS: readonly (readonly [string, string])[] = [
  ["hbf", "hauptbahnhof"],
  ["bf", "bahnhof"],
  ["str", "strasse"],
];
const OTHER_FORM: ReadonlyMap<string, string> = new Map(
  ABBREVIATIONS.flatMap(([short, long]) => [
    [short, long],
    [long, short],
  ]),
);

/**
 * The form names and queries are compared in: lower case, without diacritics, with the German
 * digraphs ae, oe, ue read as the plain vowel so München, Muenchen and Munchen meet, and with any
 * run of other characters as one space.
 */
export function foldText(text: string): string {
  const lower = text.toLowerCase().normalize("NFKD").replace(COMBINING_MARKS, "");
  let mapped = "";
  for (const char of lower) mapped += SPECIAL_LETTERS.get(char) ?? char;
  return mapped.replace(GERMAN_DIGRAPHS, "$1").replace(NOT_ALPHANUMERIC, " ").trim();
}

/** Words as typed, folded, with letters split from digits (RE1 gives re and 1). */
export function wordsOf(text: string): string[] {
  return foldText(text)
    .replace(LETTER_DIGIT, (_match, a, b, c, d) => (a ? `${a} ${b}` : `${c} ${d}`))
    .split(" ")
    .filter((word) => word !== "");
}

/**
 * Words of a name, each abbreviation followed by its other form (Hbf and Hauptbahnhof, Bf and
 * Bahnhof), so a query typed either way meets a name written either way.
 */
export function tokensOf(text: string): string[] {
  const tokens: string[] = [];
  for (const word of wordsOf(text)) {
    tokens.push(word);
    const other = OTHER_FORM.get(word);
    if (other !== undefined) tokens.push(other);
  }
  return tokens;
}

export function compactOf(text: string): string {
  return foldText(text).replaceAll(" ", "");
}
