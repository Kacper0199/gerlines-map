import { beforeEach, describe, expect, it } from "vitest";
import { resetPanelStore, usePanelStore } from "./panel-store.ts";

beforeEach(resetPanelStore);

describe("active panel", () => {
  it("starts with no panel open", () => {
    expect(usePanelStore.getState().active).toBeNull();
  });

  it("opens a panel and replaces the one that was open", () => {
    const { open } = usePanelStore.getState();
    open("stats");
    expect(usePanelStore.getState().active).toBe("stats");
    open("journeys");
    expect(usePanelStore.getState().active).toBe("journeys");
  });

  it("closes only the panel that asks, so a late close cannot shut its successor", () => {
    const { open, close } = usePanelStore.getState();
    open("journeys");
    close("stats");
    expect(usePanelStore.getState().active).toBe("journeys");
    close("journeys");
    expect(usePanelStore.getState().active).toBeNull();
  });

  it("keeps the same state object when nothing changes", () => {
    const { open, close } = usePanelStore.getState();
    open("stats");
    const before = usePanelStore.getState();
    open("stats");
    close("journeys");
    expect(usePanelStore.getState()).toBe(before);
  });
});

describe("a card takes the slot and gives it back", () => {
  it("suspends the open panel and resumes it when the card closes", () => {
    const { open, suspend, resume } = usePanelStore.getState();
    open("stats");
    suspend();
    expect(usePanelStore.getState()).toMatchObject({ active: null, returnTo: "stats" });
    resume();
    expect(usePanelStore.getState()).toMatchObject({ active: "stats", returnTo: null });
  });

  it("marks a resumed panel until the user opens or closes a panel again", () => {
    const { open, close, suspend, resume } = usePanelStore.getState();
    open("stats");
    expect(usePanelStore.getState().resumed).toBe(false);
    suspend();
    resume();
    expect(usePanelStore.getState().resumed).toBe(true);
    open("stats");
    expect(usePanelStore.getState().resumed).toBe(false);
    suspend();
    resume();
    close("stats");
    expect(usePanelStore.getState().resumed).toBe(false);
  });

  it("returns to nothing when no panel was open before the card", () => {
    const { suspend, resume } = usePanelStore.getState();
    suspend();
    resume();
    expect(usePanelStore.getState()).toMatchObject({ active: null, returnTo: null });
  });

  it("keeps the first panel when a second card follows the first", () => {
    const { open, suspend, resume } = usePanelStore.getState();
    open("journeys");
    suspend();
    suspend();
    resume();
    expect(usePanelStore.getState().active).toBe("journeys");
  });

  it("forgets the panel to return to when another panel is opened while the card is up", () => {
    const { open, suspend, resume } = usePanelStore.getState();
    open("stats");
    suspend();
    open("journeys");
    expect(usePanelStore.getState()).toMatchObject({ active: "journeys", returnTo: null });
    resume();
    expect(usePanelStore.getState().active).toBe("journeys");
  });

  it("drops the panel to return to when that panel is closed", () => {
    const { open, suspend, close, resume } = usePanelStore.getState();
    open("stats");
    suspend();
    close("stats");
    resume();
    expect(usePanelStore.getState().active).toBeNull();
  });
});
