// @vitest-environment happy-dom
import { TooltipProvider } from "@gerlines/ui";
import { act, cleanup, render, screen } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TrainPanel } from "../components/train/card/TrainCard.tsx";
import { FrameTrainCard } from "../components/train/FrameTrainCard.tsx";
import { testDetail } from "../components/train/test-detail.ts";
import type { LiveSelectionInfo } from "../motion/protocol.ts";
import { initialState, useAppStore } from "../state/store.ts";
import { requestCardFocus, takeCardFocus } from "./card-focus.ts";

const INFO: LiveSelectionInfo = {
  key: 7,
  line: "ICE",
  trainNumber: 541,
  category: "hsr",
  foreign: false,
  realtime: true,
  delaySeconds: 360,
  dataTimeMs: 0,
  speedMps: null,
};

let swap: () => void = () => {};

function Stand({ children }: { children: ReactNode }) {
  const [detail, setDetail] = useState(false);
  swap = () => setDetail(true);
  return (
    <TooltipProvider>
      {detail ? (
        <TrainPanel
          state={{ status: "ready", detail: testDetail() }}
          nowMs={0}
          handlers={{}}
          onClose={() => {}}
        />
      ) : (
        children
      )}
    </TooltipProvider>
  );
}

beforeEach(() => {
  takeCardFocus();
  useAppStore.setState({ ...initialState(), selectedId: "live:7", liveSelection: INFO });
});
afterEach(cleanup);

describe("card heading focus on a late or replaced card", () => {
  it("does not take the focus from a field the user moved to before the card mounted", () => {
    render(<input aria-label="Search" />);
    const field = screen.getByLabelText("Search");
    requestCardFocus("live:7");
    field.focus();
    render(<FrameTrainCard phone={false} />);
    expect(document.activeElement).toBe(field);
  });

  it("hands the focus to the detail card when the card that held it is replaced", () => {
    takeCardFocus();
    requestCardFocus("live:7");
    render(
      <Stand>
        <FrameTrainCard phone={false} detailUnavailable />
      </Stand>,
    );
    const standIn = document.activeElement;
    expect(standIn?.tagName).toBe("H2");

    act(() => swap());

    expect(document.body.contains(standIn)).toBe(false);
    expect(document.activeElement?.tagName).toBe("H2");
    expect(document.activeElement?.textContent).toBe("ICE 541");
  });

  it("does not ask for a new focus when the card closes with its heading focused", () => {
    requestCardFocus("live:7");
    const view = render(<FrameTrainCard phone={false} />);
    expect(document.activeElement?.tagName).toBe("H2");
    act(() => useAppStore.getState().select(null));
    view.unmount();
    useAppStore.getState().select("live:7");
    expect(takeCardFocus()).toBe(false);
  });
});
