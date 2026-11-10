import type { SourceActivity } from "@gerlines/schema/source-priority";

/** What the store keeps of one forecast row: the prediction, without the row's identity. */
export interface HeldForecast {
  /** Unix seconds (may carry a fraction). */
  readonly observedAt: number;
  readonly predictedArrival: number | null;
  readonly predictedDeparture: number | null;
  readonly arrivalDelay: number | null;
  readonly departureDelay: number | null;
  readonly cancelled: boolean;
  readonly explicit: boolean;
  /** The stop place the source's stop event names (`stop_event`), null when unknown. */
  readonly stopPlaceId: string | null;
}

/** One change of one source's prediction for one stop of a trip instance (`stop_event_forecast`). */
export interface ForecastRow extends HeldForecast {
  readonly instanceId: string;
  readonly serviceDate: string;
  readonly stopIndex: number;
  readonly sourceId: string;
}

/**
 * When a source last reported a trip instance (`trip_instance_source`), changed predictions or
 * not: a source that keeps repeating the same times is active, though it writes no forecast rows.
 */
export interface SeenRow {
  readonly instanceId: string;
  readonly sourceId: string;
  /** Unix seconds. */
  readonly firstSeen: number;
  /** Unix seconds. */
  readonly lastSeen: number;
}

/** What one source last said about one trip instance. */
export interface SourceView {
  readonly sourceId: string;
  firstSeen: number;
  lastSeen: number;
  readonly stops: Map<number, HeldForecast>;
}

interface Sighting {
  first: number;
  last: number;
}

interface InstanceView {
  readonly serviceDate: string;
  readonly sources: Map<string, SourceView>;
  sightings: Map<string, Sighting> | null;
}

/**
 * The newest prediction per (trip instance, source, stop). A row replaces the one held only when
 * its observation is at least as new (D-038: merge rule per instance and source); deletions are
 * not modelled, so a refold by ingest never removes what clients were shown.
 */
export class RealtimeStore {
  private readonly instances = new Map<string, InstanceView>();
  private readonly strings = new Map<string, string>();

  /** One copy of each repeated id (stop places, sources, dates): rows arrive with fresh strings. */
  private intern(value: string): string {
    const held = this.strings.get(value);
    if (held !== undefined) return held;
    this.strings.set(value, value);
    return value;
  }

  private held(row: ForecastRow): HeldForecast {
    return {
      observedAt: row.observedAt,
      predictedArrival: row.predictedArrival,
      predictedDeparture: row.predictedDeparture,
      arrivalDelay: row.arrivalDelay,
      departureDelay: row.departureDelay,
      cancelled: row.cancelled,
      explicit: row.explicit,
      stopPlaceId: row.stopPlaceId === null ? null : this.intern(row.stopPlaceId),
    };
  }

  /** Applies rows and returns the instance ids whose held state changed. */
  apply(rows: Iterable<ForecastRow>): Set<string> {
    const changed = new Set<string>();
    for (const row of rows) {
      let instance = this.instances.get(row.instanceId);
      if (!instance) {
        instance = {
          serviceDate: this.intern(row.serviceDate),
          sources: new Map(),
          sightings: null,
        };
        this.instances.set(row.instanceId, instance);
      }
      let source = instance.sources.get(row.sourceId);
      if (!source) {
        source = {
          sourceId: this.intern(row.sourceId),
          firstSeen: row.observedAt,
          lastSeen: row.observedAt,
          stops: new Map(),
        };
        instance.sources.set(row.sourceId, source);
      }
      const held = source.stops.get(row.stopIndex);
      if (held && held.observedAt > row.observedAt) continue;
      source.stops.set(row.stopIndex, this.held(row));
      source.firstSeen = Math.min(source.firstSeen, row.observedAt);
      source.lastSeen = Math.max(source.lastSeen, row.observedAt);
      changed.add(row.instanceId);
    }
    return changed;
  }

  /**
   * Replaces what `sourceId` (every source when null) holds for the held ones of `instanceIds` by
   * `rows`: after a rebuild the rows a source wrote for those instances are its rows now, and rows
   * the rebuild deleted must go. Rows of instances not held are ignored. Returns the held ids.
   */
  replace(
    sourceId: string | null,
    instanceIds: Iterable<string>,
    rows: Iterable<ForecastRow>,
  ): Set<string> {
    const held = new Set<string>();
    for (const id of instanceIds) {
      const instance = this.instances.get(id);
      if (!instance) continue;
      held.add(id);
      if (sourceId === null) instance.sources.clear();
      else instance.sources.delete(sourceId);
    }
    this.apply(
      (function* () {
        for (const row of rows) if (held.has(row.instanceId)) yield row;
      })(),
    );
    return held;
  }

  /**
   * Notes when sources reported held instances. It changes no prediction, so no instance is due
   * for it; the next evaluation sees the activity.
   */
  noteSeen(rows: Iterable<SeenRow>): void {
    for (const row of rows) {
      const instance = this.instances.get(row.instanceId);
      if (!instance) continue;
      instance.sightings ??= new Map();
      const sighting = instance.sightings.get(row.sourceId);
      if (sighting) {
        sighting.first = Math.min(sighting.first, row.firstSeen);
        sighting.last = Math.max(sighting.last, row.lastSeen);
      } else {
        instance.sightings.set(this.intern(row.sourceId), {
          first: row.firstSeen,
          last: row.lastSeen,
        });
      }
    }
  }

  source(instanceId: string, sourceId: string): SourceView | undefined {
    return this.instances.get(instanceId)?.sources.get(sourceId);
  }

  /**
   * The sources with predictions for an instance and when each reported it as of `now`: the newest
   * of its forecast rows and its sightings. A sighting first made after `now` does not count, and
   * one that runs past `now` counts up to `now` (a render reads sightings as known at the end).
   */
  activity(instanceId: string, now: number): SourceActivity[] {
    const instance = this.instances.get(instanceId);
    if (!instance) return [];
    return [...instance.sources.values()].map((source) => {
      let firstSeen = source.firstSeen;
      let lastSeen = source.lastSeen;
      const sighting = instance.sightings?.get(source.sourceId);
      if (sighting && sighting.first <= now) {
        firstSeen = Math.min(firstSeen, sighting.first);
        lastSeen = Math.max(lastSeen, Math.min(sighting.last, now));
      }
      return {
        sourceId: source.sourceId,
        firstSeen: Math.floor(firstSeen),
        lastSeen: Math.floor(lastSeen),
      };
    });
  }

  has(instanceId: string): boolean {
    return this.instances.has(instanceId);
  }

  /** The latest predicted arrival or departure any source holds for an instance, null without one. */
  predictedEnd(instanceId: string): number | null {
    let end: number | null = null;
    for (const source of this.instances.get(instanceId)?.sources.values() ?? []) {
      for (const row of source.stops.values()) {
        const latest = Math.max(row.predictedArrival ?? 0, row.predictedDeparture ?? 0);
        if (latest > 0 && (end === null || latest > end)) end = latest;
      }
    }
    return end;
  }

  /** Forgets one instance (the engine dropped it: its train has ended). */
  forget(instanceId: string): void {
    this.instances.delete(instanceId);
  }

  /** Forgets instances of service days before `serviceDate` (YYYY-MM-DD). */
  evictBefore(serviceDate: string): number {
    let removed = 0;
    for (const [id, instance] of this.instances) {
      if (instance.serviceDate < serviceDate) {
        this.instances.delete(id);
        removed++;
      }
    }
    return removed;
  }

  get rowCount(): number {
    let rows = 0;
    for (const instance of this.instances.values())
      for (const source of instance.sources.values()) rows += source.stops.size;
    return rows;
  }

  get size(): number {
    return this.instances.size;
  }
}
