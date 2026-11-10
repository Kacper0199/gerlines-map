// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePlaybackStore } from "../playback/store.ts";
import { initialState, useAppStore } from "../state/store.ts";
import { ProfileHost } from "./ProfileHost.tsx";
import type { ProfileCardSubject } from "./subject.ts";

vi.mock("./ProfileController.tsx", () => ({
  default: () => <p>controller mounted</p>,
}));

const SUBJECT = { stops: [] } as unknown as ProfileCardSubject;

afterEach(() => {
  cleanup();
  usePlaybackStore.setState({ state: null });
  useAppStore.setState(initialState());
});

describe("ProfileHost", () => {
  it("mounts the controller while the switch is on", async () => {
    useAppStore.setState({ ...initialState(), selectedId: "live:1", profileOn: true });
    render(<ProfileHost subject={SUBJECT} />);
    expect(await screen.findByText("controller mounted")).toBeTruthy();
  });

  it("mounts nothing in a playback, whose legs would come from the detail of today", async () => {
    useAppStore.setState({ ...initialState(), selectedId: "live:1", profileOn: true });
    usePlaybackStore.setState({
      state: {
        phase: "playing",
        playing: true,
        position: 1,
        speed: 1,
        windowStart: 0,
        windowEnd: 3600,
        error: null,
        notice: null,
      },
    });
    render(<ProfileHost subject={SUBJECT} />);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByText("controller mounted")).toBeNull();
  });
});
