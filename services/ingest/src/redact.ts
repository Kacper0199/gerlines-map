const SECRET_PARAMETER = /key|token|secret|passw|auth|signature|^sig$|credential/i;
const MIN_SECRET_LENGTH = 6;
const REDACTED = "redacted";

export function redactText(text: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length >= MIN_SECRET_LENGTH)
    .reduce((result, secret) => result.replaceAll(secret, REDACTED), text);
}

const TOKEN_LIKE_LENGTH = 16;

/**
 * Every path segment and query value of a URL long enough to be a token. Sources that carry a token in
 * the URL treat all of them as secrets, so a token is redacted wherever it sits.
 */
export function tokenLikeParts(value: string): string[] {
  const url = new URL(value);
  const segments = url.pathname.split("/").map((segment) => decodeURIComponentSafe(segment));
  const parts = [...segments, ...url.searchParams.values()];
  return [...new Set(parts.filter((part) => part.length >= TOKEN_LIKE_LENGTH))];
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** A URL safe to store and log: no userinfo, no key-like query values, no configured secret anywhere. */
export function redactUrl(value: string, secrets: readonly string[], base?: string): string {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return "invalid-url";
  }
  url.username = "";
  url.password = "";
  for (const name of [...url.searchParams.keys()]) {
    if (SECRET_PARAMETER.test(name)) {
      url.searchParams.set(name, REDACTED);
    }
  }
  return redactText(url.toString(), secrets);
}
