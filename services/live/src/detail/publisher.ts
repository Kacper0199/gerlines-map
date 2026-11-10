import { TrainDetail } from "@gerlines/schema";
import { type BuildFailure, buildTrainDetail } from "./build.ts";
import type { CentrifugoClient } from "./centrifugo.ts";
import { floorAt, type ServedTrace, traceOf, withFloor } from "./floor.ts";
import { DETAIL_TTL_S, trainChannel } from "./keys.ts";
import type { DetailInput, DetailRef, TickDecision } from "./model.ts";
import type { DetailPort, LiveInstanceState, LiveTickUpdate } from "./port.ts";
import type { DetailRepository, LoadedDetails, LoadedInstance, ReadMode } from "./repository.ts";
import { type DetailStore, runTtlSeconds } from "./store.ts";

export interface Logger {
  info(line: string): void;
  error(line: string): void;
}

export interface BuildOptions {
  readonly asOf: number;
  readonly version: number;
  readonly timetableVersion: (instance: LoadedInstance) => string;
  readonly tick?: (instance: LoadedInstance) => TickDecision | null;
}

export interface BuildReport {
  readonly details: TrainDetail[];
  readonly failures: Partial<Record<BuildFailure | "invalid", number>>;
  readonly placeMismatches: number;
}

/** Builds and validates the details of loaded instances; a detail the schema refuses is dropped. */
export function buildAll(loaded: LoadedDetails, options: BuildOptions): BuildReport {
  const details: TrainDetail[] = [];
  const failures: Partial<Record<BuildFailure | "invalid", number>> = {};
  let placeMismatches = 0;
  for (const instance of loaded.instances) {
    const input: DetailInput = {
      ...instance,
      asOf: options.asOf,
      timetableVersion: options.timetableVersion(instance),
      version: options.version,
      places: loaded.places,
      operators: loaded.operators,
      sources: loaded.sources,
      feedObservedAt: loaded.feedObservedAt,
      tick: options.tick?.(instance) ?? null,
    };
    const result = buildTrainDetail(input);
    if (!result.ok) {
      failures[result.reason] = (failures[result.reason] ?? 0) + 1;
      continue;
    }
    placeMismatches += result.placeMismatches;
    const checked = TrainDetail.safeParse(result.detail);
    if (!checked.success) {
      failures.invalid = (failures.invalid ?? 0) + 1;
      continue;
    }
    details.push(checked.data);
  }
  return { details, failures, placeMismatches };
}

/** Publications per Centrifugo batch call, so a burst of changes never becomes one huge request. */
export const PUSH_BATCH = 100;

/**
 * Publishes each detail to its `train:<uuid>` channel in batches. No channel lookup first:
 * Centrifugo drops a publication to a channel without subscribers (history is off), and anonymous
 * subscribers cannot inflate a lookup the writer depends on.
 */
export async function pushDetails(
  client: Pick<CentrifugoClient, "publish">,
  details: readonly TrainDetail[],
): Promise<{ pushed: number; error: string | null }> {
  let pushed = 0;
  let refused = 0;
  try {
    for (let start = 0; start < details.length; start += PUSH_BATCH) {
      const publications = details
        .slice(start, start + PUSH_BATCH)
        .map((detail) => ({ channel: trainChannel(detail.tripInstanceId), data: detail }));
      const batchRefused = await client.publish(publications);
      refused += batchRefused;
      pushed += publications.length - batchRefused;
    }
  } catch (error) {
    return { pushed, error: (error as Error).message };
  }
  return { pushed, error: refused > 0 ? `${refused} publications refused` : null };
}

export interface PublisherOptions {
  readonly repository: Pick<DetailRepository, "load" | "feeds">;
  readonly store: DetailStore;
  readonly push?: Pick<CentrifugoClient, "publish">;
  readonly mode: ReadMode;
  readonly logger: Logger;
  /** Longest wait for the per-train push before the publish returns without it. */
  readonly pushBudgetMs?: number;
}

export interface TickReport {
  readonly at: number;
  readonly changed: number;
  readonly written: number;
  readonly pushed: number;
  readonly failures: BuildReport["failures"];
  readonly errors: readonly string[];
}

function refOf(state: LiveInstanceState): DetailRef {
  return {
    tripInstanceId: state.tripInstanceId,
    serviceDate: state.serviceDate,
    feedVersionId: state.tripKey === null ? null : state.feedVersionId,
    tripKey: state.tripKey,
    frameKey: state.key,
  };
}

function decisionOf(state: LiveInstanceState): TickDecision {
  return {
    sourceId: state.source?.sourceId ?? null,
    geometry: state.geometry,
    delaySeconds: state.delaySeconds,
    cancelled: state.cancelled,
    lastPassedIndex: state.lastPassedIndex,
    nextIndex: state.nextIndex,
  };
}

interface Entry {
  readonly state: LiveInstanceState;
  readonly left: boolean;
}

/**
 * The detail writer the live tick calls (WP-3.2a's `DetailPort`): on each tick it rebuilds the
 * changed trains, writes them to Valkey, confirms the tick and pushes the details to their
 * per-train channels within a time budget. The tick never waits on it (WP-3.2a's dispatcher). A failed
 * read or write rejects after its trains are kept for the next update, so the dispatcher backs off and
 * counts it; a push failure lands only in `lastReport` and the log.
 */
export class TrainDetailPublisher implements DetailPort {
  lastReport: TickReport | null = null;
  private readonly options: PublisherOptions;
  /** Trains of a failed store write, written with the next update unless it carries newer states. */
  private unwritten = new Map<string, Entry>();
  /** Trains that left long after their end, deleted from the store once a write succeeds. */
  private readonly pendingDiscard = new Set<string>();
  /** What the API can serve from each running train's last written detail (the progress floor). */
  private readonly traces = new Map<string, ServedTrace>();

  constructor(options: PublisherOptions) {
    this.options = options;
  }

  /** True when built details also go to their per-train channels. */
  get pushes(): boolean {
    return this.options.push !== undefined;
  }

  async publish(update: LiveTickUpdate): Promise<void> {
    const at = update.at * 1000;
    const errors: string[] = [];
    const entries = this.entriesOf(update);
    const states = new Map([...entries].map(([id, entry]) => [id, entry.state]));
    let report: BuildReport = { details: [], failures: {}, placeMismatches: 0 };
    let feeds: ReadonlyMap<string, number> = new Map();
    let written = false;
    let failure: unknown = null;
    try {
      if (states.size > 0) {
        const loaded = await this.options.repository.load(
          [...states.values()].map(refOf),
          at,
          this.options.mode,
          { activity: false },
        );
        feeds = loaded.feedObservedAt;
        report = buildAll(loaded, {
          asOf: at,
          version: update.sequence,
          timetableVersion: (instance) =>
            String(
              states.get(instance.ref.tripInstanceId)?.feedVersionId ?? update.timetableVersion,
            ),
          tick: (instance) => {
            const state = states.get(instance.ref.tripInstanceId);
            return state ? decisionOf(state) : null;
          },
        });
        report = { ...report, details: report.details.map((detail) => this.floored(detail, at)) };
      } else {
        feeds = await this.options.repository.feeds(at);
      }
      const ttl = new Map(
        [...states.values()].map((state) => [
          state.tripInstanceId,
          runTtlSeconds(state.endsAt, update.at),
        ]),
      );
      const leftAt = new Map(
        [...entries.values()]
          .filter((entry) => entry.left)
          .map(({ state }) => [state.tripInstanceId, state.at * 1000]),
      );
      await this.options.store.write(report.details, ttl, leftAt);
      const built = new Set(report.details.map((detail) => detail.tripInstanceId));
      const expired = [...this.pendingDiscard];
      await this.options.store.discard([
        ...[...states.keys()].filter((id) => !built.has(id)),
        ...expired,
      ]);
      written = true;
      this.unwritten = new Map();
      this.pendingDiscard.clear();
      this.remember(report.details, entries, expired);
      await this.options.store.confirm(at, feeds);
    } catch (error) {
      if (!written) this.unwritten = entries;
      failure = error;
      errors.push(`store: ${(error as Error).message}`);
    }
    const pushed = written ? await this.push(report.details, errors) : 0;
    this.lastReport = {
      at,
      changed: states.size,
      written: written ? report.details.length : 0,
      pushed,
      failures: report.failures,
      errors,
    };
    for (const line of errors) {
      if (line.startsWith("push:"))
        this.options.logger.error(`detail tick ${update.sequence}: ${line}`);
    }
    if (failure !== null) throw failure;
  }

  /**
   * The trains to write: those of an unwritten update, then this one's (newer states win). A train
   * that left more than 15 min after its run's end gets no detail and is discarded instead.
   */
  private entriesOf(update: LiveTickUpdate): Map<string, Entry> {
    const entries = new Map(this.unwritten);
    for (const state of update.changed) entries.set(state.tripInstanceId, { state, left: false });
    for (const state of update.removed) entries.set(state.tripInstanceId, { state, left: true });
    for (const [id, entry] of entries) {
      if (entry.left && entry.state.endsAt + DETAIL_TTL_S <= update.at) {
        this.pendingDiscard.add(id);
        entries.delete(id);
      }
    }
    return entries;
  }

  private floored(detail: TrainDetail, at: number): TrainDetail {
    const trace = this.traces.get(detail.tripInstanceId);
    return trace ? withFloor(detail, floorAt(trace, at)) : detail;
  }

  private remember(
    details: readonly TrainDetail[],
    entries: ReadonlyMap<string, { left: boolean }>,
    expired: readonly string[],
  ): void {
    for (const id of expired) this.traces.delete(id);
    for (const [id, entry] of entries) if (entry.left) this.traces.delete(id);
    for (const detail of details) {
      if (entries.get(detail.tripInstanceId)?.left !== true) {
        this.traces.set(detail.tripInstanceId, traceOf(detail));
      }
    }
  }

  private async push(details: readonly TrainDetail[], errors: string[]): Promise<number> {
    const push = this.options.push;
    if (!push) return 0;
    const budget = this.options.pushBudgetMs ?? 2_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const overBudget = new Promise<{ pushed: number; error: string }>((resolve) => {
      timer = setTimeout(
        () => resolve({ pushed: 0, error: `over the ${budget} ms budget` }),
        budget,
      );
    });
    const result = await Promise.race([pushDetails(push, details), overBudget]);
    clearTimeout(timer);
    if (result.error) errors.push(`push: ${result.error}`);
    return result.pushed;
  }
}
