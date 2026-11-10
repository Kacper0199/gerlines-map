import { lazy, Suspense, useState } from "react";
import { useAppStore } from "../state/store.ts";

const ProfileTooltip = lazy(() => import("../profile/ProfileTooltip.tsx"));

/** Loads the tooltip's strings when a segment of the profile is first pointed at, then keeps it mounted so it can outlive the pointer's trigger. */
export function ProfileTooltipHost() {
  const pointed = useAppStore((state) => state.profileHover !== null);
  const [loaded, setLoaded] = useState(false);
  if (pointed && !loaded) setLoaded(true);
  return loaded ? (
    <Suspense fallback={null}>
      <ProfileTooltip />
    </Suspense>
  ) : null;
}
