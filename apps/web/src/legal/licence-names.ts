const CANONICAL: readonly (readonly [RegExp, string])[] = [
  [/^(dl de zero 2\.0|datenlizenz deutschland zero version 2\.0)$/, "DL-DE ZERO 2.0"],
  [/^(dl de by 2\.0|datenlizenz deutschland namensnennung version 2\.0)$/, "DL-DE BY 2.0"],
  [/\bcc by 4\.0\b/, "CC BY 4.0"],
  [/^cc0$/, "CC0 1.0"],
];

/** Licence names up to this length are never broken across lines; longer ones wrap at spaces. */
export const NOWRAP_LICENCE_CHARS = 24;

/**
 * The name this site uses for a licence: providers write the same licence in many ways
 * (`DL-DE->BY-2.0`, `Datenlizenz Deutschland - Namensnennung - Version 2.0`, `CC-BY 4.0`), the
 * page shows one, and a name it does not know stays as the provider wrote it.
 */
export function licenceName(raw: string): string {
  const flat = raw
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, " ")
    .trim();
  return CANONICAL.find(([pattern]) => pattern.test(flat))?.[1] ?? raw;
}

/**
 * A provider's credit split where it joins a name to a second part with a spaced hyphen
 * (`Bayerische Vermessungsverwaltung - www.geodaten.bayern.de`): the head, the hyphen with the
 * word after it, which stay on one line, and the rest. Joined again they are the credit as written.
 */
export function creditParts(
  provider: string,
): { head: string; joint: string; rest: string } | null {
  const at = provider.indexOf(" - ");
  if (at < 0) return null;
  const tail = provider.slice(at + 3);
  const space = tail.indexOf(" ");
  return {
    head: provider.slice(0, at),
    joint: `- ${space < 0 ? tail : tail.slice(0, space)}`,
    rest: space < 0 ? "" : tail.slice(space),
  };
}
