// @vitest-environment happy-dom
import { changeLocale } from "@gerlines/i18n";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { lazy, Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startLiveEarly, takeEarlyWorker } from "../live/early-start.ts";
import { MapErrorBoundary } from "./MapErrorBoundary.tsx";

const Shell = () => <p>Shell stays</p>;

function Stage({
  load,
  onReload,
}: {
  load: () => Promise<{ default: () => null }>;
  onReload?: () => void;
}) {
  const Lazy = lazy(load);
  return (
    <>
      <MapErrorBoundary {...(onReload ? { onReload } : {})}>
        <Suspense fallback={<div>Loading map</div>}>
          <Lazy />
        </Suspense>
      </MapErrorBoundary>
      <Shell />
    </>
  );
}

beforeEach(async () => {
  await changeLocale("en");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MapErrorBoundary", () => {
  it("terminates the live worker started early when the map fails", async () => {
    const terminate = vi.fn();
    vi.stubGlobal(
      "Worker",
      class {
        postMessage(): void {}
        terminate = terminate;
      },
    );
    startLiveEarly("dark", "");
    render(<Stage load={() => Promise.reject(new Error("chunk"))} />);
    await screen.findByRole("alert");
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(takeEarlyWorker()).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("keeps the shell and offers a reload when the map chunk fails to load", async () => {
    const onReload = vi.fn();
    render(<Stage load={() => Promise.reject(new Error("chunk 404"))} onReload={onReload} />);

    const alert = await screen.findByRole("alert");

    expect(alert.textContent).toContain("The map could not load");
    expect(screen.getByText("Shell stays")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload page" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("speaks the language of the interface", async () => {
    await changeLocale("de");
    render(<Stage load={() => Promise.reject(new Error("offline"))} />);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Die Karte konnte nicht geladen werden",
    );
    expect(screen.getByRole("button", { name: "Seite neu laden" })).toBeTruthy();
  });

  it("renders the map when it loads", async () => {
    render(<Stage load={() => Promise.resolve({ default: () => null })} />);

    await screen.findByText("Shell stays");

    expect(screen.queryByRole("alert")).toBeNull();
  });
});
