import { readFileSync } from "node:fs";
import { Agent } from "node:https";
import { createSecureContext } from "node:tls";
import { inspect } from "node:util";

const SHOWN = "[client certificate]";

export interface ClientCertificateOptions {
  /** Trust these CA certificates instead of the default store, for a private test server. */
  readonly ca?: Buffer;
}

/**
 * A PKCS#12 client certificate and its password, held only in private fields: logging, `JSON.stringify` and
 * `util.inspect` show a placeholder, so neither the key nor the password can reach a log line or a sidecar.
 */
export class ClientCertificate {
  readonly #pfx: Buffer;
  readonly #passphrase: string;
  readonly #ca: Buffer | undefined;
  #agent: Agent | null = null;

  constructor(pfx: Buffer, passphrase: string, options: ClientCertificateOptions = {}) {
    this.#pfx = pfx;
    this.#passphrase = passphrase;
    this.#ca = options.ca;
  }

  /**
   * One keep-alive agent per certificate, so a minute poll reuses its TLS session. Like the global fetch, it
   * tunnels through `HTTPS_PROXY` only when `NODE_USE_ENV_PROXY=1`; the TLS session, and so the client
   * certificate, stays end to end.
   */
  agent(): Agent {
    this.#agent ??= new Agent({
      keepAlive: true,
      maxSockets: 2,
      pfx: this.#pfx,
      passphrase: this.#passphrase,
      ...(this.#ca ? { ca: this.#ca } : {}),
      ...(process.env.NODE_USE_ENV_PROXY === "1" ? { proxyEnv: process.env } : {}),
    });
    return this.#agent;
  }

  /** Throws when the file does not open with the password; the message never holds the password. */
  check(): void {
    createSecureContext({ pfx: this.#pfx, passphrase: this.#passphrase });
  }

  close(): void {
    this.#agent?.destroy();
    this.#agent = null;
  }

  toJSON(): string {
    return SHOWN;
  }

  toString(): string {
    return SHOWN;
  }

  [inspect.custom](): string {
    return SHOWN;
  }
}

function reason(error: unknown, secrets: readonly string[]): string {
  const raw = error instanceof Error ? error.message : String(error);
  return secrets.reduce(
    (text, secret) => (secret ? text.replaceAll(secret, "redacted") : text),
    raw,
  );
}

/** Reads and opens a PKCS#12 file; a wrong password or a broken file fails here, at start, not on each poll. */
export function loadClientCertificate(
  path: string,
  passphrase: string,
  options: ClientCertificateOptions = {},
): ClientCertificate {
  let pfx: Buffer;
  try {
    pfx = readFileSync(path);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    throw new Error(`cannot read the client certificate ${path}${code ? ` (${code})` : ""}`);
  }
  const certificate = new ClientCertificate(pfx, passphrase, options);
  try {
    certificate.check();
  } catch (error) {
    throw new Error(`cannot open the client certificate ${path}: ${reason(error, [passphrase])}`);
  }
  return certificate;
}
