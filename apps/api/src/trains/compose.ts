import { createHash } from "node:crypto";
import { headDelay, servedProgress, TrainDetail } from "@gerlines/schema";
import { normalizePlatform } from "@gerlines/schema/platform";
import type { TrainSnapshot } from "./reader.ts";

function later(current: string | null, candidate: string | null | undefined): string | null {
  if (!candidate) return current;
  const next = Date.parse(candidate);
  if (Number.isNaN(next)) return current;
  if (current === null) return new Date(next).toISOString();
  return next > Date.parse(current) ? new Date(next).toISOString() : current;
}

function earlier(current: string, cap: string | null | undefined): string {
  const limit = cap ? Date.parse(cap) : Number.NaN;
  if (Number.isNaN(limit) || limit >= Date.parse(current)) return current;
  return new Date(limit).toISOString();
}

type StoredStop = TrainDetail["stops"][number];

function withPlatforms(stop: StoredStop): StoredStop {
  return {
    ...stop,
    platformScheduled: normalizePlatform(stop.platformScheduled),
    platformActual: normalizePlatform(stop.platformActual),
  };
}

/** The stored detail, checked once; fields added by a newer live writer pass through unchanged. */
const StoredDetail = TrainDetail.loose();

type StoredTrainDetail = ReturnType<typeof StoredDetail.parse>;

/**
 * The head delay at the served `asOf`, so it follows the stops between writes as
 * progress does; a detail an older writer stored, without `delayBasis`, keeps its delay.
 */
function servedDelay(
  stored: StoredTrainDetail,
  progress: TrainDetail["progress"],
  asOf: number,
): Pick<TrainDetail, "delaySeconds" | "delayBasis"> {
  if (stored.delayBasis === undefined) return { delaySeconds: stored.delaySeconds };
  return headDelay({
    stops: stored.stops,
    progress,
    asOf,
    realtime: stored.provenance.kind === "realtime",
    current: stored.currentDelaySeconds ?? null,
  });
}

/**
 * The detail as served: the stored detail with `asOf` moved to the live engine's last confirmed tick
 * and `feedObservedAt` to the source's newest payload, so a client can tell a quiet train from a dead
 * feed. Progress is recomputed from the stops at that `asOf`, so it moves on between writes, and
 * never falls behind the live engine's progress stored with them, and the head delay follows that
 * progress (`headDelay`). Platforms are read as on the station sign (`normalizePlatform`), also in a
 * detail an older live writer stored; a district's stop numbers need the stop's DHID, which
 * a stored detail lacks, so only the live writer drops them. Null when nothing is stored; an error
 * when the stored value breaks the contract.
 */
export function composeDetail(snapshot: TrainSnapshot): TrainDetail | null {
  if (snapshot.detail === null) return null;
  const stored = StoredDetail.parse(JSON.parse(snapshot.detail));
  const provenance =
    stored.provenance.kind === "realtime"
      ? {
          ...stored.provenance,
          feedObservedAt: later(
            stored.provenance.feedObservedAt,
            snapshot.feeds[stored.provenance.sourceId],
          ),
        }
      : stored.provenance;
  const asOf = earlier(later(stored.asOf, snapshot.confirmed) ?? stored.asOf, snapshot.left);
  const progress = servedProgress(stored.progress, stored.stops, Date.parse(asOf));
  const delay = servedDelay(stored, progress, Date.parse(asOf));
  return {
    ...stored,
    asOf,
    provenance,
    progress,
    ...delay,
    stops: stored.stops.map(withPlatforms),
  };
}

/** A strong validator over the exact body bytes: any change of the served JSON changes it. */
export function etagOf(body: string): string {
  return `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;
}

/** True when an If-None-Match header names the entity tag (weak comparison, RFC 9110 §13.1.2). */
export function matchesEtag(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag);
}
