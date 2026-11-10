// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, useAppStore } from "../../state/store.ts";
import { TRAIN_FIXTURES } from "./fixtures/index.ts";
import { SelectedTrain } from "./SelectedTrain.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SelectedTrain with an id of no train of ours", () => {
  it("shows no card for an id that is neither a frame key nor a trip instance", () => {
    useAppStore.setState({ ...initialState(), selectedId: "20261023_17:32_de-DELFI_1" });

    render(<SelectedTrain phone={false} />);

    expect(screen.queryByRole("article", { name: "Selected train" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Selected train" })).toBeNull();
  });
});

describe("SelectedTrain with a trip instance id", () => {
  const fixture = TRAIN_FIXTURES["ice-delay"];
  if (!fixture) throw new Error("missing the ice-delay fixture");
  const id = fixture.detail.tripInstanceId;

  function serve() {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(fixture?.detail), {
          status: 200,
          headers: { "content-type": "application/json", etag: '"1"' },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  it("closes from the loading frame before the card code arrives (runs first, React.lazy caches the module)", () => {
    serve();
    useAppStore.setState({ ...initialState(), selectedId: id });
    render(<SelectedTrain phone />);

    expect(screen.getByRole("region", { name: "Selected train" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close train card" }));

    expect(useAppStore.getState().selectedId).toBeNull();
  });

  it("closes with the Escape key and ignores other keys", () => {
    serve();
    useAppStore.setState({ ...initialState(), selectedId: id });
    render(<SelectedTrain phone={false} />);

    fireEvent.keyDown(window, { key: "a" });
    expect(useAppStore.getState().selectedId).toBe(id);
    fireEvent.keyDown(window, { key: "Escape" });

    expect(useAppStore.getState().selectedId).toBeNull();
  });

  it("shows the loading frame while the card code loads, then the live card", async () => {
    const fetch = serve();
    useAppStore.setState({ ...initialState(), selectedId: id });

    render(<SelectedTrain phone={false} />);

    expect(screen.getByRole("article", { name: "Selected train" }).getAttribute("aria-label")).toBe(
      "Selected train",
    );
    expect(screen.getByRole("status").textContent).toBe("Loading train");
    expect(screen.getByRole("button", { name: "Close train card" })).toBeTruthy();
    expect(await screen.findByText("Line 42", {}, { timeout: 5000 })).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith(`/api/v1/trains/${id}`, expect.anything());
  });
});
