import { type StatsPageCopy, statsCopyFor } from "./copy-stats.ts";
import { useLocale } from "./react.ts";

export { type StatsCopy, type StatsPageCopy, statsCopyFor } from "./copy-stats.ts";

export function useStatsCopy(): StatsPageCopy {
  return statsCopyFor(useLocale());
}
