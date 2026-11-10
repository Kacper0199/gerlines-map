const MISSING_RECHECK_MS = 30_000;

type Fetcher = (url: string, init?: { method?: "HEAD" }) => Promise<Response>;

/**
 * Whether the shape pack of an epoch is published, asked with HEAD so the pack itself is not
 * downloaded again after the shape store has read it. A pack that exists is remembered; a missing
 * one is asked for again after a while, since packs appear later.
 */
export class PackChecker {
  private readonly found = new Set<string>();
  private readonly missing = new Map<string, number>();
  private readonly fetcher: Fetcher;
  private readonly baseUrl: () => string;
  private readonly now: () => number;

  constructor(fetcher: Fetcher, baseUrl: () => string, now: () => number) {
    this.fetcher = fetcher;
    this.baseUrl = baseUrl;
    this.now = now;
  }

  async exists(epoch: number, shapeId: string | number): Promise<boolean> {
    const key = `${epoch}/${shapeId}`;
    if (this.found.has(key)) return true;
    const missedAt = this.missing.get(key);
    if (missedAt !== undefined && this.now() - missedAt < MISSING_RECHECK_MS) return false;
    const url = `${this.baseUrl()}/s/${key}.bin`;
    let response = await this.fetcher(url, { method: "HEAD" });
    if (response.status === 405 || response.status === 501) response = await this.fetcher(url);
    if (response.status !== 404 && !response.ok) {
      throw new Error(`pack ${key}: ${response.status}`);
    }
    if (response.ok) {
      this.missing.delete(key);
      this.found.add(key);
    } else {
      this.missing.set(key, this.now());
    }
    return response.ok;
  }
}
