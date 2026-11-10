import { useCopy } from "@gerlines/i18n/react";
import type { TrainDetail } from "@gerlines/schema";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { nextLookupDelay } from "../../../hooks/use-frame-trip.ts";
import { useNow } from "../../../hooks/use-now.ts";
import {
  type FetchLike,
  type TrainDetailResult,
  useTrainDetail,
} from "../../../hooks/use-train-detail.ts";
import { buildCardModel } from "../model.ts";
import type { ShareOutcome } from "./CardActions.tsx";
import { trainTitle } from "./CardHead.tsx";
import { browserShareTarget, shareLink, trainShareUrl } from "./share.ts";
import { type TrainCardState, TrainPanel, TrainSheet } from "./TrainCard.tsx";

export interface LiveTrainCardProps {
  readonly tripInstanceId: string;
  readonly phone: boolean;
  readonly onClose: () => void;
  /** The engine's clock in ms (the live head's time), so a replay counts its own minutes; the device clock when absent. */
  readonly engineNowMs?: number;
  /** The map does not draw this train: no Follow or Route, and the card says so. */
  readonly notDrawn?: boolean;
  readonly following?: boolean;
  readonly onFollowChange?: (following: boolean) => void;
  readonly onDetail?: (detail: TrainDetail) => void;
  /** Shown in place of the card while the detail is not found or cannot be read; the detail is asked for again. */
  readonly unavailable?: ReactNode;
  readonly onRoute?: () => void;
  readonly fetch?: FetchLike;
  readonly refreshMs?: number;
  readonly frozenNowMs?: number;
  readonly defaultStopsOpen?: boolean;
  readonly defaultStationIndex?: number;
  readonly defaultExpanded?: boolean;
}

/** The card state; freshness is the age of the last fetch on the device clock, whatever clock the card counts minutes with. */
export function cardState(
  result: TrainDetailResult,
  deviceNowMs: number,
  notDrawn = false,
): TrainCardState {
  switch (result.status) {
    case "ready":
      return {
        status: "ready",
        detail: result.detail,
        freshness: {
          fetchAgeMs: Math.max(0, deviceNowMs - result.fetchedAtMs),
          refreshError: result.refreshError,
          ...(notDrawn ? { notDrawn } : {}),
        },
      };
    case "not-found":
      return { status: "not-found" };
    case "error":
      return { status: "error", retry: result.retry };
    default:
      return { status: "loading" };
  }
}

/**
 * While a stand-in card is shown for a detail that is not found or cannot be read, asks again after
 * 5 s, doubling to a minute. Returns whether the stand-in stays: it does through the retries, whose
 * loading state would otherwise flip the card to its skeleton until the next miss.
 */
function useDetailRetry(result: TrainDetailResult, hasStandIn: boolean): boolean {
  const misses = useRef(0);
  const [missed, setMissed] = useState(false);
  const ready = result.status === "ready";
  const missing = result.status === "not-found" || result.status === "error";
  const retry = hasStandIn && missing ? result.retry : undefined;
  useEffect(() => {
    if (ready) {
      misses.current = 0;
      setMissed(false);
    } else if (missing) {
      setMissed(true);
    }
  }, [ready, missing]);
  useEffect(() => {
    if (!retry) return undefined;
    const timer = setTimeout(() => {
      misses.current += 1;
      retry();
    }, nextLookupDelay(misses.current));
    return () => clearTimeout(timer);
  }, [retry]);
  return hasStandIn && (missing || (missed && result.status === "loading"));
}

export function LiveTrainCard({
  tripInstanceId,
  phone,
  onClose,
  engineNowMs,
  notDrawn,
  following: controlledFollowing,
  onFollowChange,
  onDetail,
  unavailable,
  onRoute,
  fetch,
  refreshMs,
  frozenNowMs,
  defaultStopsOpen,
  defaultStationIndex,
  defaultExpanded,
}: LiveTrainCardProps) {
  const copy = useCopy();
  const train = copy.train;
  const result = useTrainDetail(tripInstanceId, {
    ...(fetch ? { fetch } : {}),
    ...(refreshMs !== undefined ? { refreshMs } : {}),
    ...(frozenNowMs !== undefined ? { clock: () => frozenNowMs } : {}),
  });
  const deviceNowMs = useNow(15_000, frozenNowMs);
  const nowMs = engineNowMs ?? deviceNowMs;
  const standIn = useDetailRetry(result, unavailable !== undefined);
  const [localFollowing, setFollowing] = useState(false);
  const following = controlledFollowing ?? localFollowing;
  const detail = result.status === "ready" ? result.detail : null;
  useEffect(() => {
    if (detail) onDetail?.(detail);
  }, [detail, onDetail]);
  const state = useMemo(
    () => cardState(result, deviceNowMs, notDrawn === true),
    [result, deviceNowMs, notDrawn],
  );
  const handlers = {
    following,
    ...(onFollowChange
      ? {
          onFollowChange: (next: boolean) => {
            setFollowing(next);
            onFollowChange(next);
          },
        }
      : {}),
    ...(onRoute ? { onRoute } : {}),
    onShare: (): Promise<ShareOutcome> => {
      const title =
        state.status === "ready"
          ? trainTitle(buildCardModel(state.detail, nowMs), train, copy.card.train)
          : copy.card.train;
      return shareLink(
        trainShareUrl(tripInstanceId, window.location),
        train.shareTitle(title),
        browserShareTarget(),
      );
    },
  };
  const props = {
    state,
    nowMs,
    handlers,
    onClose,
    ...(defaultStopsOpen !== undefined ? { defaultStopsOpen } : {}),
    ...(defaultStationIndex !== undefined ? { defaultStationIndex } : {}),
  };
  if (standIn) return <>{unavailable}</>;
  return phone ? (
    <TrainSheet {...props} {...(defaultExpanded !== undefined ? { defaultExpanded } : {})} />
  ) : (
    <TrainPanel {...props} />
  );
}
