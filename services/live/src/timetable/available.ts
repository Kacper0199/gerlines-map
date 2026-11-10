import type { LonLat } from "@gerlines/geo";
import type { StaticRun } from "../model.ts";
import type { FeedVersionInfo, TimetableSource, VersionCoverage } from "./loader.ts";

/**
 * A timetable source whose versions appear only from a given instant on the engine's clock. In a
 * replay every version is already in the database, so a rollover is replayed by naming when the
 * new version would have finished loading (`render --version-available 2=<ISO>`).
 */
export class AvailableFrom implements TimetableSource {
  private readonly inner: TimetableSource;
  private readonly availableAt: ReadonlyMap<number, number>;
  private readonly now: () => number;
  private readonly unlisted: number;

  /**
   * `availableAt` maps a feed version id to unix seconds; `now` returns unix seconds; `unlisted` is
   * the instant of a version the map does not name (always available unless given, Infinity hides it).
   */
  constructor(
    inner: TimetableSource,
    availableAt: ReadonlyMap<number, number>,
    now: () => number,
    unlisted = Number.NEGATIVE_INFINITY,
  ) {
    this.inner = inner;
    this.availableAt = availableAt;
    this.now = now;
    this.unlisted = unlisted;
  }

  async versions(): Promise<readonly FeedVersionInfo[]> {
    const now = this.now();
    return (await this.inner.versions()).filter(
      (version) => (this.availableAt.get(version.feedVersionId) ?? this.unlisted) <= now,
    );
  }

  runsOn(feedVersionId: number, serviceDate: string): Promise<readonly StaticRun[]> {
    return this.inner.runsOn(feedVersionId, serviceDate);
  }

  shapeCoverage(feedVersionId: number, serviceDate: string): Promise<VersionCoverage> {
    return this.inner.shapeCoverage(feedVersionId, serviceDate);
  }

  placeCoordinates(): Promise<ReadonlyMap<string, LonLat>> {
    return this.inner.placeCoordinates();
  }
}

/** `ID=ISO` pairs into feed version id to unix seconds. */
export function parseAvailability(values: readonly string[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const value of values) {
    const [id, at, ...rest] = value.split("=");
    const version = Number(id);
    const instant = Date.parse(at ?? "");
    if (rest.length > 0 || !Number.isInteger(version) || version < 1 || !Number.isFinite(instant)) {
      throw new Error(`--version-available takes ID=ISO, got ${value}`);
    }
    out.set(version, Math.floor(instant / 1000));
  }
  return out;
}
