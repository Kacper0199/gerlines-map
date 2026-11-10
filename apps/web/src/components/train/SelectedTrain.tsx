import type { TrainDetail } from "@gerlines/schema";
import { lazy, Suspense, useCallback, useEffect } from "react";
import { returnToMap } from "../../a11y/focus.ts";
import { seedTripOfKey, useTripOfKey } from "../../hooks/use-frame-trip.ts";
import { liveKeyOf, liveTrainId } from "../../live/train-ids.ts";
import { usePlaybackStore } from "../../playback/store.ts";
import { useAppStore } from "../../state/store.ts";
import { CardFallback } from "./card/CardFallback.tsx";
import { FrameTrainCard } from "./FrameTrainCard.tsx";

const LiveTrainCard = lazy(() =>
  import("./card/LiveTrainCard.tsx").then((module) => ({ default: module.LiveTrainCard })),
);

function useCloseOnEscape(): void {
  const select = useAppStore((state) => state.select);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        select(null);
        returnToMap();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [select]);
}

/** The card counts minutes with the engine's clock, in steps of 15 s like the device clock it replaces. */
const ENGINE_CLOCK_STEP_MS = 15_000;

const TRIP_INSTANCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isTripInstanceId(id: string | null): id is string {
  return id !== null && TRIP_INSTANCE_ID.test(id);
}

/** The shell remounts the card when this changes: a shared link turning into its frame key keeps one detail card. */
export function selectedCardKey(id: string): string {
  return isTripInstanceId(id) || liveKeyOf(id) !== null ? "detail" : id;
}

/** A playback shows only what the frames of that moment knew, and nothing for a pick whose detail is of today. */
function PlaybackSelection({ phone, byFrame }: { phone: boolean; byFrame: boolean }) {
  return byFrame ? <FrameTrainCard phone={phone} playback /> : null;
}

/**
 * The card of a train of our own frames or of a shared link. Both read the train detail by its trip
 * instance: a frame key is looked up first (a loading card meanwhile; when the lookup fails the
 * card shows what the frame knows and says the stops are missing, and tries again), a link names
 * the instance itself and selects the train on the map by the frame key its detail carries. Follow
 * and Route go to the map through the store.
 */
function DetailSelection({ phone }: { phone: boolean }) {
  const selectedId = useAppStore((state) => state.selectedId);
  const following = useAppStore((state) => state.following);
  const select = useAppStore((state) => state.select);
  const setFollowing = useAppStore((state) => state.setFollowing);
  const requestRoute = useAppStore((state) => state.requestRoute);
  const engineQuarter = useAppStore((state) =>
    state.status.dataTimeMs === undefined
      ? undefined
      : Math.floor(state.status.dataTimeMs / ENGINE_CLOCK_STEP_MS),
  );
  const drawn = useAppStore((state) => state.selectedDrawn);
  const key = liveKeyOf(selectedId);
  const onMap = key !== null && drawn === true;
  const playback = usePlaybackStore((store) => store.state !== null);
  const lookup = useTripOfKey(playback ? null : key);
  const close = useCallback(() => {
    select(null);
    returnToMap();
  }, [select]);
  const onDetail = useCallback(
    (detail: TrainDetail) => {
      if (isTripInstanceId(selectedId) && detail.frameKey !== null) {
        seedTripOfKey(detail.frameKey, detail.tripInstanceId);
        select(liveTrainId(detail.frameKey));
      }
    },
    [selectedId, select],
  );
  const tripInstanceId = isTripInstanceId(selectedId)
    ? selectedId
    : lookup.status === "ready"
      ? lookup.tripInstanceId
      : null;
  if (playback) return <PlaybackSelection phone={phone} byFrame={key !== null} />;
  if (tripInstanceId === null) {
    return lookup.status === "missing" ? (
      <FrameTrainCard phone={phone} detailUnavailable />
    ) : (
      <CardFallback phone={phone} onClose={close} />
    );
  }
  return (
    <Suspense fallback={<CardFallback phone={phone} onClose={close} />}>
      <LiveTrainCard
        key={tripInstanceId}
        tripInstanceId={tripInstanceId}
        phone={phone}
        onClose={close}
        following={following}
        {...(engineQuarter === undefined
          ? {}
          : { engineNowMs: engineQuarter * ENGINE_CLOCK_STEP_MS })}
        {...(key !== null && drawn === false ? { notDrawn: true } : {})}
        {...(onMap ? { onFollowChange: setFollowing, onRoute: requestRoute } : {})}
        onDetail={onDetail}
        {...(onMap ? { unavailable: <FrameTrainCard phone={phone} detailUnavailable /> } : {})}
      />
    </Suspense>
  );
}

export function SelectedTrain({ phone }: { phone: boolean }) {
  const selectedId = useAppStore((state) => state.selectedId);
  useCloseOnEscape();
  if (isTripInstanceId(selectedId) || liveKeyOf(selectedId) !== null) {
    return <DetailSelection phone={phone} />;
  }
  return null;
}
