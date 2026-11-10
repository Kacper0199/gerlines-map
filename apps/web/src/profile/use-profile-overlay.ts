import { useEffect } from "react";
import { useAppStore } from "../state/store.ts";
import type { ProfileLeg, Quantile } from "./model.ts";

/** Hands the legs to the map while the profile is on and takes them back when it goes off or the card closes. */
export function useProfileOverlay(legs: readonly ProfileLeg[] | null, quantile: Quantile): void {
  const setProfile = useAppStore((state) => state.setProfile);
  useEffect(() => {
    setProfile(legs === null ? null : { legs, quantile });
  }, [legs, quantile, setProfile]);
  useEffect(() => () => setProfile(null), [setProfile]);
}
