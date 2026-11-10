const PRODUCT_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const PRINTABLE_ASCII_WITHOUT_COMMENT_DELIMITERS = /^[\x20-\x27\x2A-\x5B\x5D-\x7E]+$/;
const SURROUNDING_ASCII_WHITESPACE = /^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g;

export interface UserAgentParts {
  readonly appName: string;
  readonly version: string;
  readonly contact: string;
}

/**
 * Builds the `User-Agent` value every outbound request sends: `<appName>/<version> (+<contact>)`.
 * The contact is trimmed of ASCII whitespace and must be printable ASCII without `(`, `)` or `\`.
 * Throws a `TypeError` when a part would produce an invalid or injectable header.
 */
export function userAgent({ appName, version, contact }: UserAgentParts): string {
  if (!PRODUCT_TOKEN.test(appName)) {
    throw new TypeError(
      `User-Agent app name must be a non-empty HTTP token, got ${JSON.stringify(appName)}`,
    );
  }
  if (!PRODUCT_TOKEN.test(version)) {
    throw new TypeError(
      `User-Agent version must be a non-empty HTTP token, got ${JSON.stringify(version)}`,
    );
  }
  const trimmedContact = contact.replaceAll(SURROUNDING_ASCII_WHITESPACE, "");
  if (!PRINTABLE_ASCII_WITHOUT_COMMENT_DELIMITERS.test(trimmedContact)) {
    throw new TypeError(
      "User-Agent contact must be a non-empty URL or e-mail address in printable ASCII without parentheses or backslashes",
    );
  }
  return `${appName}/${version} (+${trimmedContact})`;
}
