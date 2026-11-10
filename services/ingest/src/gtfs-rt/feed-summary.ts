export interface FeedSummaryOk {
  readonly ok: true;
  readonly gtfsRealtimeVersion: string | null;
  readonly incrementality: "FULL_DATASET" | "DIFFERENTIAL" | null;
  readonly headerTimestamp: number | null;
  readonly entities: number;
  readonly tripUpdates: number;
  readonly vehicles: number;
  readonly alerts: number;
  readonly deleted: number;
}

export interface FeedSummaryError {
  readonly ok: false;
  readonly error: string;
}

export type FeedSummary = FeedSummaryOk | FeedSummaryError;

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_FIXED32 = 5;

class WireError extends Error {}

class Reader {
  readonly bytes: Uint8Array;
  readonly start: number;
  readonly end: number;
  position: number;

  constructor(bytes: Uint8Array, start: number, end: number) {
    this.bytes = bytes;
    this.start = start;
    this.end = end;
    this.position = start;
  }

  get done(): boolean {
    return this.position >= this.end;
  }

  varint(): number {
    let result = 0;
    let multiplier = 1;
    for (let index = 0; index < 10; index += 1) {
      if (this.position >= this.end) {
        throw new WireError("varint runs past the end of the message");
      }
      const byte = this.bytes[this.position] ?? 0;
      this.position += 1;
      result += (byte & 0x7f) * multiplier;
      if (byte < 0x80) {
        return result;
      }
      multiplier *= 0x80;
    }
    throw new WireError("varint longer than 10 bytes");
  }

  tag(): { field: number; wireType: number } {
    const key = this.varint();
    return { field: Math.floor(key / 8), wireType: key % 8 };
  }

  lengthDelimited(): Reader {
    const length = this.varint();
    const start = this.position;
    if (start + length > this.end) {
      throw new WireError("length-delimited field runs past the end of the message");
    }
    this.position = start + length;
    return new Reader(this.bytes, start, start + length);
  }

  skip(wireType: number): void {
    if (wireType === WIRE_VARINT) {
      this.varint();
    } else if (wireType === WIRE_FIXED64) {
      this.advance(8);
    } else if (wireType === WIRE_LENGTH_DELIMITED) {
      this.lengthDelimited();
    } else if (wireType === WIRE_FIXED32) {
      this.advance(4);
    } else {
      throw new WireError(`unsupported wire type ${wireType}`);
    }
  }

  text(): string {
    const slice = this.lengthDelimited();
    return new TextDecoder().decode(this.bytes.subarray(slice.start, slice.end));
  }

  private advance(count: number): void {
    if (this.position + count > this.end) {
      throw new WireError("fixed-width field runs past the end of the message");
    }
    this.position += count;
  }
}

interface Header {
  version: string | null;
  incrementality: FeedSummaryOk["incrementality"];
  timestamp: number | null;
}

const INCREMENTALITY: Record<number, FeedSummaryOk["incrementality"]> = {
  0: "FULL_DATASET",
  1: "DIFFERENTIAL",
};

function readHeaderField(reader: Reader, header: Header, field: number, wireType: number): void {
  if (field === 1 && wireType === WIRE_LENGTH_DELIMITED) {
    header.version = reader.text();
  } else if (field === 2 && wireType === WIRE_VARINT) {
    header.incrementality = INCREMENTALITY[reader.varint()] ?? null;
  } else if (field === 3 && wireType === WIRE_VARINT) {
    header.timestamp = reader.varint();
  } else {
    reader.skip(wireType);
  }
}

function readHeader(reader: Reader): Header {
  const header: Header = { version: null, incrementality: "FULL_DATASET", timestamp: null };
  while (!reader.done) {
    const { field, wireType } = reader.tag();
    readHeaderField(reader, header, field, wireType);
  }
  return header;
}

interface EntityCounts {
  entities: number;
  tripUpdates: number;
  vehicles: number;
  alerts: number;
  deleted: number;
}

const ENTITY_KINDS: Record<number, "tripUpdates" | "vehicles" | "alerts"> = {
  3: "tripUpdates",
  4: "vehicles",
  5: "alerts",
};

function countEntity(reader: Reader, counts: EntityCounts): void {
  counts.entities += 1;
  while (!reader.done) {
    const { field, wireType } = reader.tag();
    if (field === 2 && wireType === WIRE_VARINT) {
      counts.deleted += reader.varint() === 0 ? 0 : 1;
      continue;
    }
    const kind = wireType === WIRE_LENGTH_DELIMITED ? ENTITY_KINDS[field] : undefined;
    if (kind) counts[kind] += 1;
    reader.skip(wireType);
  }
}

/**
 * Reads only the FeedHeader and the kind of each FeedEntity of a GTFS-Realtime FeedMessage,
 * without decoding trip updates, vehicles or alerts.
 */
export function summarizeFeed(bytes: Uint8Array): FeedSummary {
  const reader = new Reader(bytes, 0, bytes.length);
  const counts: EntityCounts = { entities: 0, tripUpdates: 0, vehicles: 0, alerts: 0, deleted: 0 };
  let header: Header | undefined;
  try {
    while (!reader.done) {
      const { field, wireType } = reader.tag();
      if (field === 1 && wireType === WIRE_LENGTH_DELIMITED) {
        header = readHeader(reader.lengthDelimited());
      } else if (field === 2 && wireType === WIRE_LENGTH_DELIMITED) {
        countEntity(reader.lengthDelimited(), counts);
      } else {
        reader.skip(wireType);
      }
    }
  } catch (error) {
    if (error instanceof WireError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
  if (!header) {
    return { ok: false, error: "feed has no header" };
  }
  return {
    ok: true,
    gtfsRealtimeVersion: header.version,
    incrementality: header.incrementality,
    headerTimestamp: header.timestamp,
    ...counts,
  };
}
