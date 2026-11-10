import { lazy, Suspense } from "react";
import { usePlaybackStore } from "../playback/store.ts";
import { useAppStore } from "../state/store.ts";
import type { ProfileCardSubject } from "./subject.ts";

const ProfileController = lazy(() => import("./ProfileController.tsx"));

/**
 * Mounts the profile controller while the switch is on; nothing of the profile is loaded before that. A
 * playback has no profile: its legs come from the detail of today, which is another time.
 */
export function ProfileHost({ subject }: { subject: ProfileCardSubject | null }) {
  const on = useAppStore((state) => state.profileOn);
  const playback = usePlaybackStore((state) => state.state !== null);
  return on && subject && !playback ? (
    <Suspense fallback={null}>
      <ProfileController subject={subject} />
    </Suspense>
  ) : null;
}
