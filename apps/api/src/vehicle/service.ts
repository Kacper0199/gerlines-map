import {
  FormationObservation,
  type TrainDetail,
  VEHICLE_SEQUENCE_SOURCE,
  type VehicleIdentity,
  type VehicleResolution,
} from "@gerlines/schema";
import {
  type FleetRuleRow,
  resolveIdentity,
  type SeriesFacts,
  trainKeyOfDetail,
} from "@gerlines/schema/vehicle-resolver";
import { SEQUENCE_SHARE_PER_HOUR } from "../limits.ts";
import { aggregateKey } from "../search/client-address.ts";
import { fixedWindowLimiter, type RateLimiter } from "../search/rate-limit.ts";
import { readFormation, seriesByNumber } from "./formation.ts";
import type { CatalogueSeries, CatalogueSource, IdentityStore } from "./repository.ts";
import type { SequenceQuery, SequenceResult } from "./vehicle-sequence.ts";

export { SEQUENCE_SHARE_PER_HOUR } from "../limits.ts";

export interface SequenceSource {
  get(query: SequenceQuery): Promise<SequenceResult>;
  knows(serviceDate: string, trainNumber: string): boolean;
}

export interface IdentityServiceOptions {
  readonly store: IdentityStore;
  readonly sequence?: SequenceSource | undefined;
  readonly logger: { error(line: string): void };
  readonly now?: () => number;
  readonly catalogueTtlMs?: number;
  readonly sequenceShare?: RateLimiter;
}

interface CachedIdentity {
  readonly identity: Promise<VehicleIdentity | null>;
  readonly until: number;
}

function cacheKey(detail: TrainDetail): string {
  return [
    detail.serviceDate,
    detail.trainNumber ?? detail.tripInstanceId,
    detail.operator?.id ?? "",
    detail.category,
    detail.line ?? "",
  ].join("|");
}

interface Catalogue {
  readonly rules: readonly FleetRuleRow[];
  readonly series: ReadonlyMap<string, SeriesFacts>;
  readonly byNumber: ReadonlyMap<string, string>;
  readonly sourceNames: ReadonlyMap<string, string>;
  readonly loadedAt: number;
}

const CATALOGUE_RETRY_MS = 60_000;
const MAX_CACHED_IDENTITIES = 20_000;

const HOUR_MS = 3_600_000;

/** An identity is kept this long per train and day, the lifetime of a served detail. */
export const IDENTITY_CACHE_MS = 5_000;
const DB_OPERATOR = /^db-/;
const SEQUENCE_CATEGORIES: ReadonlySet<string> = new Set([
  "hsr",
  "ld",
  "night",
  "rfast",
  "reg",
  "sbahn",
]);

function catalogueOf(
  rules: readonly FleetRuleRow[],
  series: readonly CatalogueSeries[],
  sources: readonly CatalogueSource[],
  at: number,
): Catalogue {
  return {
    rules,
    series: new Map(series.map((row) => [row.seriesId, row])),
    byNumber: seriesByNumber(series),
    sourceNames: new Map(sources.map((row) => [row.sourceId, row.name])),
    loadedAt: at,
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : String(error);
}

function served({
  ruleId: _rule,
  alternatives: _others,
  ...identity
}: VehicleResolution): VehicleIdentity {
  return identity;
}

/**
 * The vehicle identity of a train detail (ADR-0011), its source named by the catalogue display name
 * (null when the catalogue has none). Rules, series and source names are read from the database and
 * kept for `catalogueTtlMs`. Layer L0 is lazy: a train without a stored exact formation queues one
 * coach sequence request in the background (when a sequence source is configured) and is answered
 * from the lower layers; the stored result shows from the next read on. Each client may cause at
 * most 30 such calls an hour, counted by its /48 for IPv6 (an IPv4 address as it is), so no client
 * can use up the shared hourly budget alone.
 */
export class VehicleIdentityService {
  private current: Catalogue | null = null;
  private loading: Promise<Catalogue> | null = null;
  private retryAt = Number.NEGATIVE_INFINITY;
  private readonly identities = new Map<string, CachedIdentity>();
  private readonly observing = new Set<string>();
  private readonly evas = new Map<string, number | null>();
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly share: RateLimiter;

  private readonly options: IdentityServiceOptions;

  constructor(options: IdentityServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.ttl = options.catalogueTtlMs ?? 600_000;
    this.share =
      options.sequenceShare ??
      fixedWindowLimiter({ limit: SEQUENCE_SHARE_PER_HOUR, windowMs: HOUR_MS, now: this.now });
  }

  /** The identity; `client` (a limiter key) is charged its share, by `aggregateKey`, when a coach sequence call is queued. */
  identify(detail: TrainDetail, client?: string): Promise<VehicleIdentity | null> {
    const at = this.now();
    const key = cacheKey(detail);
    const cached = this.identities.get(key);
    if (cached && at < cached.until) return cached.identity;
    this.forgetExpired(at);
    const identity = this.resolve(detail, undefined, client).then((resolution) =>
      resolution ? served(resolution) : null,
    );
    this.identities.set(key, { identity, until: at + IDENTITY_CACHE_MS });
    identity.catch(() => {
      if (this.identities.get(key)?.identity === identity) this.identities.delete(key);
    });
    return identity;
  }

  private forgetExpired(at: number): void {
    if (this.identities.size < MAX_CACHED_IDENTITIES) return;
    for (const [key, cached] of this.identities) {
      if (cached.until <= at) this.identities.delete(key);
    }
    if (this.identities.size >= MAX_CACHED_IDENTITIES) this.identities.clear();
  }

  async resolve(
    detail: TrainDetail,
    pending?: (work: Promise<void>) => void,
    client?: string,
  ): Promise<VehicleResolution | null> {
    const catalogue = await this.load();
    const key = trainKeyOfDetail(detail);
    const { serviceDate, operatorId, trainNumber: numeric } = key;
    const [exact, majority] = numeric
      ? await Promise.all([
          this.options.store.exact(serviceDate, numeric, operatorId),
          this.options.store.majority(serviceDate, numeric, operatorId),
        ])
      : [null, null];
    if (!exact && numeric) {
      const work = this.observe(detail, numeric, catalogue, client);
      if (work) pending ? pending(work) : void work;
    }
    const resolution = resolveIdentity(key, {
      rules: catalogue.rules,
      series: catalogue.series,
      exact,
      majority,
    });
    return resolution
      ? { ...resolution, sourceName: catalogue.sourceNames.get(resolution.source) ?? null }
      : null;
  }

  private load(): Catalogue | Promise<Catalogue> {
    const at = this.now();
    const current = this.current;
    if (current === null) {
      this.loading ??= this.fetchCatalogue(at);
      return this.loading;
    }
    if (at - current.loadedAt > this.ttl && this.loading === null && at >= this.retryAt) {
      this.loading = this.fetchCatalogue(at);
      this.loading.catch((error: unknown) => {
        this.retryAt = at + Math.min(this.ttl, CATALOGUE_RETRY_MS);
        this.options.logger.error(`vehicle catalogue refresh failed: ${errorName(error)}`);
      });
    }
    return current;
  }

  private async fetchCatalogue(at: number): Promise<Catalogue> {
    try {
      const [rules, series, sources] = await Promise.all([
        this.options.store.rules(),
        this.options.store.series(),
        this.sourcesOrNone(),
      ]);
      this.current = catalogueOf(rules, series, sources, at);
      return this.current;
    } finally {
      this.loading = null;
    }
  }

  /** Source names only name the source; a failed read leaves them out and never fails the catalogue. */
  private async sourcesOrNone(): Promise<readonly CatalogueSource[]> {
    try {
      return await this.options.store.sources();
    } catch (error) {
      this.options.logger.error(`vehicle source names failed: ${errorName(error)}`);
      return [];
    }
  }

  private async evaOf(stopPlaceId: string): Promise<number | null> {
    const known = this.evas.get(stopPlaceId);
    if (known !== undefined) return known;
    const eva = await this.options.store.evaOf(stopPlaceId);
    if (this.evas.size >= MAX_CACHED_IDENTITIES) this.evas.clear();
    this.evas.set(stopPlaceId, eva);
    return eva;
  }

  private observe(
    detail: TrainDetail,
    trainNumber: string,
    catalogue: Catalogue,
    client: string | undefined,
  ): Promise<void> | null {
    const { sequence } = this.options;
    const origin = detail.stops[0];
    const operator = detail.operator?.id ?? "";
    if (!sequence || !origin?.scheduledDeparture || !detail.productName) return null;
    if (!DB_OPERATOR.test(operator) || !SEQUENCE_CATEGORIES.has(detail.category)) return null;
    const key = `${detail.serviceDate}|${trainNumber}`;
    if (this.observing.has(key) || sequence.knows(detail.serviceDate, trainNumber)) return null;
    if (client !== undefined && !this.share.hit(aggregateKey(client)).allowed) return null;
    this.observing.add(key);
    const departure = origin.scheduledDeparture;
    const category = detail.productName;
    return (async () => {
      const eva = await this.evaOf(origin.stopPlaceId);
      if (eva === null) return;
      const result = await sequence.get({
        category,
        trainNumber,
        serviceDate: detail.serviceDate,
        eva,
        departure,
      });
      if (result.status !== "ok") return;
      const formation = readFormation(result.answer, catalogue.byNumber);
      if (!formation) return;
      const observation = FormationObservation.safeParse({
        sourceId: VEHICLE_SEQUENCE_SOURCE,
        serviceDate: detail.serviceDate,
        trainNumber,
        operatorId: detail.operator?.id ?? null,
        categoryCode: detail.category,
        line: detail.line,
        seriesId: formation.seriesId,
        units: formation.units,
        cars: formation.cars,
        lengthMetres: formation.lengthMetres,
        unitNames: [...formation.unitNames],
        sequenceStatus: formation.sequenceStatus,
        rawSha256: result.sha256,
      });
      if (!observation.success) {
        this.options.logger.error(`vehicle sequence for ${trainNumber} out of range, not stored`);
        return;
      }
      await this.options.store.save(observation.data);
    })()
      .catch((error: unknown) => {
        this.options.logger.error(
          `vehicle sequence for ${trainNumber} failed: ${errorName(error)}`,
        );
      })
      .finally(() => {
        this.observing.delete(key);
      });
  }
}
