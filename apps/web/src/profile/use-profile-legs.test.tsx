// @vitest-environment happy-dom
import { TrainDetail } from "@gerlines/schema";
import { StatsTrainSegments } from "@gerlines/schema/stats";
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ice from "../components/train/fixtures/ice-delay.json" with { type: "json" };
import answerJson from "./fixtures/segments-619-hsr.json" with { type: "json" };
import { selectionFrom } from "./selection-fixture.ts";
import { profileSubjectOf } from "./subject.ts";
import { useProfileLegs } from "./use-profile-legs.ts";

const detail = TrainDetail.parse(ice.detail);
const answer = StatsTrainSegments.parse(answerJson);
const selection = selectionFrom(detail.stops, 7);
const subjectOf = () => {
  const subject = profileSubjectOf(detail, true);
  if (!subject) throw new Error("no subject");
  return subject;
};

describe("useProfileLegs", () => {
  it("keeps the legs when the detail refreshes with the same stops in a new array", () => {
    const { result, rerender } = renderHook(
      ({ subject }) => useProfileLegs(subject, answer, selection),
      { initialProps: { subject: subjectOf() } },
    );
    const first = result.current;
    expect(first?.placed).toBe(true);
    rerender({ subject: subjectOf() });
    expect(result.current).toBe(first);
  });

  it("builds new legs for another answer and unplaced legs when the stops no longer fit", () => {
    const { result, rerender } = renderHook(
      ({ chosen, sel }) => useProfileLegs(subjectOf(), chosen, sel),
      {
        initialProps: {
          chosen: answer as StatsTrainSegments | null,
          sel: selection as typeof selection | null,
        },
      },
    );
    const first = result.current;
    rerender({ chosen: { ...answer }, sel: selection });
    expect(result.current).not.toBe(first);
    rerender({ chosen: answer, sel: { ...selection, firstStop: 8 } });
    expect(result.current?.placed).toBe(false);
    rerender({ chosen: null, sel: selection });
    expect(result.current).toBeNull();
  });
});
