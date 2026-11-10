export interface TokenBucketOptions {
  readonly capacity: number;
  readonly refillEveryMs: number;
}

/** Reserves tokens and says how long the caller must wait for its token; reservations may go ahead of time. */
export class TokenBucket {
  private readonly options: TokenBucketOptions;
  private readonly now: () => number;
  private tokens: number;
  private updatedAt: number;

  constructor(options: TokenBucketOptions, now: () => number) {
    this.options = options;
    this.now = now;
    this.tokens = options.capacity;
    this.updatedAt = now();
  }

  take(): number {
    const now = this.now();
    const refilled = (now - this.updatedAt) / this.options.refillEveryMs;
    this.tokens = Math.min(this.options.capacity, this.tokens + refilled);
    this.updatedAt = now;
    this.tokens -= 1;
    return this.tokens >= 0 ? 0 : Math.round(-this.tokens * this.options.refillEveryMs);
  }
}
