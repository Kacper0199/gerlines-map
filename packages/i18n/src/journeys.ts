import { type JourneysPageCopy, journeysCopyFor } from "./copy-journeys.ts";
import { useLocale } from "./react.ts";

export { type JourneysCopy, type JourneysPageCopy, journeysCopyFor } from "./copy-journeys.ts";

export function useJourneysCopy(): JourneysPageCopy {
  return journeysCopyFor(useLocale());
}
