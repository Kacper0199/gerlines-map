import { useEffect, useRef } from "react";
import { useAppStore } from "../state/store.ts";
import type { ProfileCardSubject } from "./subject.ts";
import { useProfile } from "./use-profile.ts";
import { useProfileLegs } from "./use-profile-legs.ts";
import { useProfileOverlay } from "./use-profile-overlay.ts";
import { useProfileRange } from "./use-profile-range.ts";

/**
 * Fetches the profile while the switch is on and hands it to the map, whatever part of the card is on show:
 * folding the phone sheet to see the map must not take the profile away. It draws nothing itself; the card's
 * block reads the answer from the store.
 */
export default function ProfileController({ subject }: { subject: ProfileCardSubject }) {
  const quantile = useAppStore((state) => state.profileQuantile);
  const routeStops = useAppStore((state) => state.routeStops);
  const setView = useAppStore((state) => state.setProfileView);
  const range = useProfileRange();
  const { view, retry } = useProfile(subject, range, true);
  const built = useProfileLegs(subject, view.state === "ready" ? view.data : null, routeStops);
  useEffect(() => {
    setView(view);
  }, [view, setView]);
  const retries = useAppStore((state) => state.profileRetries);
  const seen = useRef(retries);
  useEffect(() => {
    if (retries === seen.current) return;
    seen.current = retries;
    retry();
  }, [retries, retry]);
  useProfileOverlay(built?.placed ? built.legs : null, quantile);
  return null;
}
