import type { Head } from "@gerlines/live-frame";

/** The push notice of a new head (design note §3): clients fetch the head, or poll it without push. */
export interface FrameNotice {
  readonly seq: number;
  readonly keyframe: number;
  readonly oldest: number;
  readonly tv: number;
}

export function noticeOf(head: Head): FrameNotice {
  return {
    seq: head.sequence,
    keyframe: head.keyframeSequence,
    oldest: head.oldestSequence,
    tv: head.timetableVersion,
  };
}

export interface Notifier {
  notify(head: Head): Promise<void>;
}

export const FRAMES_CHANNEL = "live:frames";

/**
 * Publishes the notice to Centrifugo's server HTTP API (`POST /api/publish`, `X-API-Key`). A failed
 * notice is counted and never stops the engine: clients fall back to polling the head.
 */
export class CentrifugoNotifier implements Notifier {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  sent = 0;
  failed = 0;
  lastError: string | null = null;

  constructor(baseUrl: string, apiKey: string, timeoutMs = 2000) {
    this.endpoint = new URL("/api/publish", baseUrl).toString();
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  async notify(head: Head): Promise<void> {
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": this.apiKey },
        body: JSON.stringify({ channel: FRAMES_CHANNEL, data: noticeOf(head) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      if (!response.ok || body?.error) {
        throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
      }
      this.sent++;
    } catch (error) {
      this.failed++;
      this.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    }
  }
}

/** Sends notices only when the head names a new sequence or keyframe. */
export class ChangedHeadNotifier implements Notifier {
  private readonly inner: Notifier;
  private last = "";

  constructor(inner: Notifier) {
    this.inner = inner;
  }

  async notify(head: Head): Promise<void> {
    const signature = `${head.sequence}:${head.keyframeSequence}:${head.timetableVersion}`;
    if (signature === this.last) return;
    this.last = signature;
    await this.inner.notify(head);
  }
}

/**
 * Sends notices outside the tick: `notify` returns at once, one request is in flight, and a head
 * that arrives meanwhile replaces any older one still waiting (clients only need the newest).
 */
export class BackgroundNotifier implements Notifier {
  private readonly inner: Notifier;
  private waiting: Head | null = null;
  private running: Promise<void> | null = null;
  skipped = 0;

  constructor(inner: Notifier) {
    this.inner = inner;
  }

  async notify(head: Head): Promise<void> {
    if (this.waiting) this.skipped++;
    this.waiting = head;
    this.running ??= this.drain();
  }

  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private async drain(): Promise<void> {
    await Promise.resolve();
    while (this.waiting) {
      const head = this.waiting;
      this.waiting = null;
      await this.inner.notify(head).catch(() => {});
    }
    this.running = null;
  }
}
