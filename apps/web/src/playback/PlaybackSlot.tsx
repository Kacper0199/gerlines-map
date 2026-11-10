import { cn } from "@gerlines/ui";
import { lazy, Suspense } from "react";
import { usePlaybackStore } from "./store.ts";

const PlaybackPanel = lazy(() => import("./PlaybackPanel.tsx"));

/** The timeline above the live bar, loaded on the first press of History. */
export function PlaybackSlot({ className }: { className?: string }) {
  const open = usePlaybackStore((state) => state.panelOpen);
  if (!open) return null;
  return (
    <div className={cn("pointer-events-none flex", className)}>
      <Suspense fallback={null}>
        <PlaybackPanel />
      </Suspense>
    </div>
  );
}

export function usePlaybackActive(): boolean {
  return usePlaybackStore((state) => state.state !== null);
}
