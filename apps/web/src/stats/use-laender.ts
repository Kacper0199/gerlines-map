import { useEffect, useState } from "react";
import { geoFilesFor, type LandFacts, readLaender } from "../map/geo-base.ts";

/** The 16 Länder with their names in every language, from the same national file the map uses. */
export function useLaender(): readonly LandFacts[] {
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
