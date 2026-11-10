import type { RebuildTarget, RowSink } from "./processor.ts";
import type { RowBatch } from "./rows.ts";
import { type PayloadLogRow, type StagedLog, StagingLostError, type SwapCounts } from "./writer.ts";

type Row = Record<string, unknown>;

/**
 * A row sink that keeps the realtime tables in memory with the upsert rules of `writer.ts`, so tests
 * can compare what different delivery orders leave behind without a database.
 */
export class MemorySink implements RowSink {
  readonly tables = {
    trip_instance: new Map<string, Row>(),
    trip_instance_source: new Map<string, Row>(),
    stop_event: new Map<string, Row>(),
    stop_event_forecast: new Map<string, Row>(),
    segment_obs: new Map<string, Row>(),
    event: new Map<string, Row>(),
    match_backlog: new Map<string, Row>(),
    alert_message: new Map<string, Row>(),
    alert_scope: new Map<string, Row>(),
    rt_payload: new Map<string, Row>(),
  };
  readonly logs: (PayloadLogRow | null)[] = [];
  readonly rebuilds: { source: string; days: readonly string[]; counts: SwapCounts }[] = [];
  /** Every staging write, in order, for tests that check what a rebuild stages and when. */
  readonly staged: RowBatch[] = [];
  failWrites = 0;
  /** Swaps that find their staged rows gone (another writer emptied them), counted down. */
  loseStaging = 0;

  async write(batch: RowBatch, log: PayloadLogRow | null): Promise<void> {
    if (this.failWrites > 0) {
      this.failWrites -= 1;
      throw new Error('invalid byte sequence for encoding "UTF8": 0x00');
    }
    this.logs.push(log);
    this.writeOrderFree(batch);
    const t = this.tables;
    writeStopEvents(t.stop_event, batch.stopEvents);
    insertNew(t.stop_event_forecast, batch.forecasts, forecastKey);
    insertNew(t.segment_obs, batch.segments, segmentKey);
    if (log) this.logLine(log);
  }

  /** A staged rebuild with the semantics of `stageBatch` and `swapStaged` in `writer.ts`. */
  async rebuild(source: string, days: readonly string[], cut: number): Promise<RebuildTarget> {
    const staging = {
      stop_event: new Map<string, Row>(),
      stop_event_forecast: new Map<string, Row>(),
      segment_obs: new Map<string, Row>(),
    };
    const wanted = new Set(days);
    return {
      stage: async (batch) => {
        this.staged.push(batch);
        this.writeOrderFree(batch);
        writeStopEvents(staging.stop_event, batch.stopEvents);
        insertNew(
          staging.stop_event_forecast,
          batch.forecasts.filter((row) => row.observedAt >= cut),
          forecastKey,
        );
        insertNew(
          staging.segment_obs,
          batch.segments.filter((row) => row.observedAt >= cut),
          segmentKey,
        );
      },
      swap: async (logs: readonly StagedLog[]) => {
        if (this.loseStaging > 0) {
          this.loseStaging -= 1;
          throw new StagingLostError();
        }
        const t = this.tables;
        const inDays = (row: Row) =>
          row.sourceId === source && wanted.has(row.serviceDate as string);
        const counts: SwapCounts = {
          deleted: {
            stopEvents: replaceDiffering(
              t.stop_event,
              staging.stop_event,
              (key, row) =>
                inDays(row) && ((row.observedAt as number) >= cut || staging.stop_event.has(key)),
            ),
            forecasts: replaceDiffering(
              t.stop_event_forecast,
              staging.stop_event_forecast,
              (_key, row) => inDays(row) && (row.observedAt as number) >= cut,
            ),
            segments: replaceDiffering(
              t.segment_obs,
              staging.segment_obs,
              (_key, row) => inDays(row) && (row.observedAt as number) >= cut,
            ),
          },
          inserted: {
            stopEvents: insertMissing(t.stop_event, staging.stop_event),
            forecasts: insertMissing(t.stop_event_forecast, staging.stop_event_forecast),
            segments: insertMissing(t.segment_obs, staging.segment_obs),
          },
        };
        for (const { log } of logs) {
          this.logs.push(log);
          this.logLine(log);
        }
        this.rebuilds.push({ source, days: [...days].sort(), counts });
        return counts;
      },
    };
  }

  private logLine(log: PayloadLogRow): void {
    const { processedAt: _processedAt, ...kept } = log;
    this.tables.rt_payload.set(log.rawObjectId, kept);
  }

  private writeOrderFree(batch: RowBatch): void {
    this.writeInstances(batch);
    const t = this.tables;
    insertNew(t.event, batch.events, (row) => `${row.eventId}|${row.occurredAt}`);
    mergeAll(t.match_backlog, batch.backlog, (row) =>
      [row.sourceId, row.entityKey, row.serviceDate, row.reason].join("|"),
    );
    mergeAll(t.alert_message, batch.alertMessages, (row) =>
      [row.sourceId, row.alertKey, row.contentHash].join("|"),
    );
    mergeAll(t.alert_scope, batch.alertScopes, (row) =>
      [row.sourceId, row.alertKey, row.contentHash, row.tripInstanceId ?? row.stopPlaceId].join(
        "|",
      ),
    );
  }

  private writeInstances(batch: RowBatch): void {
    const t = this.tables;
    for (const row of batch.instances) {
      const old = t.trip_instance.get(row.tripInstanceId);
      const earlier =
        !old ||
        row.observedAt < (old.observedAt as number) ||
        (row.observedAt === old.observedAt && row.sourceId < (old.sourceId as string));
      if (earlier) t.trip_instance.set(row.tripInstanceId, { ...row });
    }
    for (const row of batch.instanceSeen) {
      const key = `${row.tripInstanceId}|${row.sourceId}`;
      const old = t.trip_instance_source.get(key);
      const first = Math.min((old?.first as number) ?? row.observedAt, row.observedAt);
      const last = Math.max((old?.last as number) ?? row.observedAt, row.observedAt);
      const lastRaw = !old || row.observedAt > (old.last as number) ? row.rawObjectId : old.lastRaw;
      t.trip_instance_source.set(key, { first, last, lastRaw });
    }
  }

  /** Every table's rows in key order, as JSON, for equality checks between runs. */
  fingerprint(tables: readonly (keyof MemorySink["tables"])[] = FOLD_TABLES): string {
    return JSON.stringify(
      Object.fromEntries(
        tables.map((name) => [name, [...this.tables[name]].sort(([a], [b]) => a.localeCompare(b))]),
      ),
    );
  }
}

export const FOLD_TABLES = [
  "trip_instance",
  "trip_instance_source",
  "stop_event",
  "stop_event_forecast",
  "segment_obs",
  "event",
  "match_backlog",
  "alert_message",
  "alert_scope",
] as const;

const forecastKey = (row: RowBatch["forecasts"][number]) =>
  [row.tripInstanceId, row.stopIndex, row.sourceId, row.observedAt].join("|");
const segmentKey = (row: RowBatch["segments"][number]) =>
  [row.serviceDate, row.tripInstanceId, row.fromIndex, row.sourceId].join("|");

function writeStopEvents(table: Map<string, Row>, rows: RowBatch["stopEvents"]): void {
  for (const row of rows) {
    const key = `${row.serviceDate}|${row.tripInstanceId}|${row.stopIndex}|${row.sourceId}`;
    const old = table.get(key);
    if (!old) table.set(key, { ...row });
    else if (row.observedAt > (old.observedAt as number)) {
      table.set(key, {
        ...old,
        ...row,
        stopPlaceId: old.stopPlaceId,
        scheduledArrival: old.scheduledArrival,
        scheduledDeparture: old.scheduledDeparture,
        platformScheduled: old.platformScheduled,
      });
    }
  }
}

const canonical = (row: Row): string =>
  JSON.stringify(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)));

/** Deletes the rows `inScope` picks that differ from the staged row of their key; returns how many. */
function replaceDiffering(
  table: Map<string, Row>,
  staged: Map<string, Row>,
  inScope: (key: string, row: Row) => boolean,
): number {
  let deleted = 0;
  for (const [key, row] of [...table]) {
    if (!inScope(key, row)) continue;
    const other = staged.get(key);
    if (other && canonical(other) === canonical(row)) continue;
    table.delete(key);
    deleted += 1;
  }
  return deleted;
}

function insertMissing(table: Map<string, Row>, staged: Map<string, Row>): number {
  let inserted = 0;
  for (const [key, row] of staged) {
    if (table.has(key)) continue;
    table.set(key, { ...row });
    inserted += 1;
  }
  return inserted;
}

function insertNew<T extends object>(
  table: Map<string, Row>,
  rows: readonly T[],
  key: (row: T) => string,
): void {
  for (const row of rows) {
    const id = key(row);
    if (!table.has(id)) table.set(id, { ...row } as Row);
  }
}

function mergeAll<T extends object>(
  table: Map<string, Row>,
  rows: readonly T[],
  key: (row: T) => string,
): void {
  for (const row of rows) {
    const id = key(row);
    table.set(id, mergeSeen(table.get(id), { ...row } as Row));
  }
}

function mergeSeen(old: Row | undefined, row: Row): Row {
  if (!old) return row;
  const earlier = (row.firstObservedAt as number) < (old.firstObservedAt as number);
  return {
    ...(earlier ? row : old),
    firstObservedAt: Math.min(row.firstObservedAt as number, old.firstObservedAt as number),
    lastSeenHour: Math.max(row.lastSeenHour as number, old.lastSeenHour as number),
  };
}
