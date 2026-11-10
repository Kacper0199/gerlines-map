import { useCopy, useLocale } from "@gerlines/i18n/react";
import { cn } from "@gerlines/ui";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { geoFilesFor, type LandFacts, readLaender } from "../../map/geo-base.ts";
import { useAppStore } from "../../state/store.ts";

function useLaender(): readonly LandFacts[] {
  const [laender, setLaender] = useState<readonly LandFacts[]>([]);
  useEffect(() => {
    let live = true;
    void geoFilesFor(window.location.origin)
      .national()
      .then((data) => {
        if (live) setLaender(readLaender(data.laender ?? null));
      });
    return () => {
      live = false;
    };
  }, []);
  return laender;
}

/** The focused Land under the search card; pressing it shows all of Germany again (DESIGN.md Land focus). */
export function LandChip({ className }: { className?: string }) {
  const copy = useCopy();
  const locale = useLocale() as keyof LandFacts["names"];
  const focusLand = useAppStore((state) => state.focusLand);
  const setFocusLand = useAppStore((state) => state.setFocusLand);
  const laender = useLaender();
  if (focusLand === null) return null;
  const name = laender.find((land) => land.code === focusLand)?.names[locale] ?? focusLand;
  return (
    <button
      type="button"
      aria-label={copy.search.landClear(name)}
      onClick={() => setFocusLand(null)}
      className={cn(
        "card-surface type-body-strong pointer-events-auto inline-flex min-h-target items-center gap-2 self-start rounded-full py-1 pr-2 pl-4 text-ink hover:bg-raised max-[640px]:min-h-11",
        className,
      )}
    >
      <span className="wrap-break-word">{name}</span>
      <X aria-hidden="true" className="size-4 text-ink-muted" />
    </button>
  );
}
