// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { initialState, useAppStore } from "../state/store.ts";
import { requestCardFocus, takeCardFocus } from "./card-focus.ts";

beforeEach(() => {
  useAppStore.setState(initialState());
  takeCardFocus();
});

describe("card focus request", () => {
  it("is taken once by the card of the train the list opened", () => {
    requestCardFocus("live:7");
    useAppStore.getState().select("live:7");
    expect(takeCardFocus()).toBe(true);
    expect(takeCardFocus()).toBe(false);
  });

  it("is not taken when nothing was requested", () => {
    useAppStore.getState().select("live:7");
    expect(takeCardFocus()).toBe(false);
  });

  it("lapses when another train is selected before the card mounted", () => {
    requestCardFocus("live:7");
    useAppStore.getState().select("live:7");
    useAppStore.getState().select("live:8");
    useAppStore.getState().select("live:7");
    expect(takeCardFocus()).toBe(false);
  });

  it("lapses when the selection is cleared", () => {
    requestCardFocus("live:7");
    useAppStore.getState().select("live:7");
    useAppStore.getState().select(null);
    useAppStore.getState().select("live:7");
    expect(takeCardFocus()).toBe(false);
  });
});
