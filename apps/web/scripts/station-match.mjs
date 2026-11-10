// The name check of the journey pairs: a search hit stands for the asked station only when its name holds
// every word of the asked name outside parentheses, folded as the search folds (case, accents, ae oe ue, ß) and with
// Hbf and Bf read as Hauptbahnhof and Bahnhof. A qualifier in parentheses (Lahn, Hohentwiel, Main) may be missing,
// since display names write some towns short. Metz does not match Metzingen Bahnhof.
const SPECIAL = new Map([
  ["ß", "ss"],
  ["ł", "l"],
  ["đ", "d"],
  ["ø", "o"],
  ["æ", "ae"],
  ["œ", "oe"],
  ["ı", "i"],
]);
const OTHER_FORM = new Map([
  ["hbf", "hauptbahnhof"],
  ["hauptbahnhof", "hbf"],
  ["bf", "bahnhof"],
  ["bahnhof", "bf"],
]);

function wordsOf(text) {
  const lower = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "");
  const mapped = [...lower].map((char) => SPECIAL.get(char) ?? char).join("");
  return mapped
    .replace(/([aou])e/g, "$1")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
}

export function nameHoldsQuery(name, query) {
  const words = new Set(wordsOf(name).flatMap((word) => [word, OTHER_FORM.get(word) ?? word]));
  return wordsOf(query.replace(/\([^)]*\)/g, " ")).every((word) => words.has(word));
}
