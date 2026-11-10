export interface CentrifugoOptions {
  /** Origin of the Centrifugo server, for example `http://127.0.0.1:8000`. */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface Publication {
  readonly channel: string;
  readonly data: unknown;
}

export class CentrifugoError extends Error {
  override readonly name = "CentrifugoError";
}

interface ApiError {
  readonly code?: number;
  readonly message?: string;
}

/** True for a host the API key may reach over plain http: loopback or a compose service name. */
export function plainHttpAllowed(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host)) return true;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(host);
}

/** The batch call of the Centrifugo server HTTP API the detail writer needs. */
export class CentrifugoClient {
  private readonly fetch: typeof fetch;
  private readonly origin: string;
  private readonly options: CentrifugoOptions;

  constructor(options: CentrifugoOptions) {
    this.options = options;
    const url = new URL(options.baseUrl);
    if (url.pathname !== "/" || url.search !== "" || url.username !== "" || url.password !== "") {
      throw new CentrifugoError("CENTRIFUGO_URL must be an origin without path, query or user");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new CentrifugoError("CENTRIFUGO_URL must use http or https");
    }
    if (url.protocol === "http:" && !plainHttpAllowed(url.hostname)) {
      throw new CentrifugoError(
        "CENTRIFUGO_URL must use https unless it is loopback or a service name",
      );
    }
    this.origin = url.origin;
    this.fetch = options.fetch ?? fetch;
  }

  private async call(method: string, body: unknown): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetch(`${this.origin}/api/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": this.options.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 3000),
      });
    } catch (error) {
      throw new CentrifugoError(`${method} failed: ${(error as Error).name}`);
    }
    if (!response.ok) throw new CentrifugoError(`${method} answered HTTP ${response.status}`);
    const parsed = (await response.json()) as Record<string, unknown>;
    const error = parsed.error as ApiError | undefined;
    if (error) throw new CentrifugoError(`${method} error ${error.code ?? "?"}`);
    return parsed;
  }

  /** Publishes in one batch; returns how many publications the server refused. */
  async publish(publications: readonly Publication[]): Promise<number> {
    if (publications.length === 0) return 0;
    const reply = await this.call("batch", {
      commands: publications.map(({ channel, data }) => ({ publish: { channel, data } })),
    });
    const replies = (reply.replies ?? []) as { error?: ApiError }[];
    return replies.filter((entry) => entry.error).length;
  }
}
