/**
 * Valkey keys the live engine writes (`services/live/src/detail/keys.ts`, design note §4); the API
 * only reads them.
 */
export const TRAIN_DETAIL_PREFIX = "live:train:";
export const FRAME_KEY_PREFIX = "live:inst:";
export const TRAIN_LEFT_PREFIX = "live:left:";
export const DETAIL_CONFIRMED_KEY = "live:detail:confirmed";
export const DETAIL_FEEDS_KEY = "live:detail:feeds";

/** What the API reads for one train: the stored detail, the last confirmed tick, the feed times. */
export interface TrainSnapshot {
  readonly detail: string | null;
  readonly confirmed: string | null;
  /** When the train left the running set; the served `asOf` stops there. */
  readonly left?: string | null;
  readonly feeds: Readonly<Record<string, string>>;
}

export interface TrainDetailReader {
  train(tripInstanceId: string): Promise<TrainSnapshot>;
  instanceOfKey(frameKey: number): Promise<string | null>;
}

/** The part of an iovalkey client the reader uses. */
export interface ValkeyReadClient {
  get(key: string): Promise<string | null>;
  multi(): {
    get(key: string): unknown;
    hgetall(key: string): unknown;
    exec(): Promise<[Error | null, unknown][] | null>;
  };
}

export class LiveStoreUnavailableError extends Error {
  override readonly name = "LiveStoreUnavailableError";
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Reads the detail, the confirmation and the feed times in one round trip. */
export class ValkeyTrainDetailReader implements TrainDetailReader {
  private readonly client: ValkeyReadClient;

  constructor(client: ValkeyReadClient) {
    this.client = client;
  }

  async train(tripInstanceId: string): Promise<TrainSnapshot> {
    let replies: [Error | null, unknown][] | null;
    try {
      const transaction = this.client.multi();
      transaction.get(`${TRAIN_DETAIL_PREFIX}${tripInstanceId}`);
      transaction.get(DETAIL_CONFIRMED_KEY);
      transaction.hgetall(DETAIL_FEEDS_KEY);
      transaction.get(`${TRAIN_LEFT_PREFIX}${tripInstanceId}`);
      replies = await transaction.exec();
    } catch (error) {
      throw new LiveStoreUnavailableError((error as Error).message);
    }
    const failed = replies?.find(([error]) => error !== null);
    if (!replies || failed) {
      throw new LiveStoreUnavailableError(failed?.[0]?.message ?? "transaction aborted");
    }
    const feeds = replies[2]?.[1];
    return {
      detail: stringOrNull(replies[0]?.[1]),
      confirmed: stringOrNull(replies[1]?.[1]),
      left: stringOrNull(replies[3]?.[1]),
      feeds: feeds && typeof feeds === "object" ? (feeds as Record<string, string>) : {},
    };
  }

  /** The live engine's last confirmed tick and its newest payload per source (the data status). */
  async freshness(): Promise<{ confirmed: string | null; feeds: Record<string, string> }> {
    let replies: [Error | null, unknown][] | null;
    try {
      const transaction = this.client.multi();
      transaction.get(DETAIL_CONFIRMED_KEY);
      transaction.hgetall(DETAIL_FEEDS_KEY);
      replies = await transaction.exec();
    } catch (error) {
      throw new LiveStoreUnavailableError((error as Error).message);
    }
    const failed = replies?.find(([error]) => error !== null);
    if (!replies || failed) {
      throw new LiveStoreUnavailableError(failed?.[0]?.message ?? "transaction aborted");
    }
    const feeds = replies[1]?.[1];
    return {
      confirmed: stringOrNull(replies[0]?.[1]),
      feeds: feeds && typeof feeds === "object" ? (feeds as Record<string, string>) : {},
    };
  }

  async instanceOfKey(frameKey: number): Promise<string | null> {
    try {
      return await this.client.get(`${FRAME_KEY_PREFIX}${frameKey}`);
    } catch (error) {
      throw new LiveStoreUnavailableError((error as Error).message);
    }
  }
}
