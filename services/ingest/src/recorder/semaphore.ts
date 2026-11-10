/** At most `limit` tasks at once; the rest wait in arrival order. */
export class Semaphore {
  private readonly limit: number;
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(limit: number) {
    this.limit = limit;
  }

  get inUse(): number {
    return this.active;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}
