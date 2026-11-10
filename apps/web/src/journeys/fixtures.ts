import { JourneyReliabilityResponse, JourneysResponse } from "@gerlines/schema/journeys";
import berlinMuenchen from "./fixtures/journeys-berlin-muenchen.json";
import bremenHamburg from "./fixtures/journeys-bremen-hamburg.json";
import bremenHamburgLater from "./fixtures/journeys-bremen-hamburg-later.json";
import reliabilityBremenHamburg from "./fixtures/reliability-bremen-hamburg.json";

/** Answers of the journeys API recorded over the MOTIS router (DELFI 2026-10-19) and gerlines_wp27. */
export const FIXTURES = {
  bremenHamburg: JourneysResponse.parse(bremenHamburg),
  bremenHamburgLater: JourneysResponse.parse(bremenHamburgLater),
  berlinMuenchen: JourneysResponse.parse(berlinMuenchen),
  reliabilityBremenHamburg: JourneyReliabilityResponse.parse(reliabilityBremenHamburg),
};
