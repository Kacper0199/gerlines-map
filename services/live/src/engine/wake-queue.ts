/** A min-heap of (time, id) wake-ups; stale entries are skipped by the caller. */
export class WakeQueue {
  private readonly times: number[] = [];
  private readonly ids: string[] = [];

  get size(): number {
    return this.times.length;
  }

  push(time: number, id: string): void {
    this.times.push(time);
    this.ids.push(id);
    let i = this.times.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  /** Removes and returns every id due at or before `now`, earliest first. */
  popDue(now: number): { time: number; id: string }[] {
    const due: { time: number; id: string }[] = [];
    while (this.times.length > 0 && (this.times[0] as number) <= now) {
      due.push({ time: this.times[0] as number, id: this.ids[0] as string });
      this.removeTop();
    }
    return due;
  }

  private removeTop(): void {
    const lastTime = this.times.pop() as number;
    const lastId = this.ids.pop() as string;
    if (this.times.length === 0) return;
    this.times[0] = lastTime;
    this.ids[0] = lastId;
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let smallest = i;
      if (left < this.times.length && this.less(left, smallest)) smallest = left;
      if (right < this.times.length && this.less(right, smallest)) smallest = right;
      if (smallest === i) break;
      this.swap(i, smallest);
      i = smallest;
    }
  }

  private less(a: number, b: number): boolean {
    const ta = this.times[a] as number;
    const tb = this.times[b] as number;
    return ta < tb || (ta === tb && (this.ids[a] as string) < (this.ids[b] as string));
  }

  private swap(a: number, b: number): void {
    [this.times[a], this.times[b]] = [this.times[b] as number, this.times[a] as number];
    [this.ids[a], this.ids[b]] = [this.ids[b] as string, this.ids[a] as string];
  }
}
