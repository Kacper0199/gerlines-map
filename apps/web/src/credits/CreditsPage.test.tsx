// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { CreditsPage, loadCredits } from "./CreditsPage.tsx";

afterEach(cleanup);

const PHOTO = {
  photoId: "db-403-p1",
  seriesId: "db-403",
  seriesName: "ICE 3",
  small: { url: "/api/v1/photos/db-403-p1-330-0123456789ab.jpg", width: 330, height: 220 },
  large: { url: "/api/v1/photos/db-403-p1-960-0123456789ab.jpg", width: 960, height: 640 },
  focus: { x: 0.5, y: 0.5 },
  title: "ICE 3 in Köln.JPG",
  author: "Rail Fan",
  authorUrl: "https://commons.wikimedia.org/wiki/User:Rail_Fan",
  licence: "CC BY-SA 4.0",
  licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0",
  sourceUrl: "https://commons.wikimedia.org/wiki/File:ICE_3.jpg",
};

function answer(status: number, body: unknown) {
  return async () => new Response(JSON.stringify(body), { status });
}

describe("CreditsPage", () => {
  it("lists every photo with its author, licence and file page", async () => {
    const pd = {
      ...PHOTO,
      photoId: "db-401-p1",
      seriesName: "ICE 1",
      authorUrl: null,
      licence: "Public domain",
      licenceUrl: null,
    };
    render(<CreditsPage fetcher={answer(200, { photos: [PHOTO, pd] })} />);
    expect(await screen.findByRole("heading", { name: "ICE 3" })).toBeTruthy();
    expect(screen.getByText("2 photos")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Rail Fan" }).getAttribute("href")).toBe(
      PHOTO.authorUrl,
    );
    expect(screen.getByRole("link", { name: "CC BY-SA 4.0" }).getAttribute("rel")).toContain(
      "license",
    );
    expect(screen.getByText("Public domain")).toBeTruthy();
    const titles = screen.getAllByRole("link", { name: "ICE 3 in Köln" });
    expect(titles.map((link) => link.getAttribute("href"))).toEqual([
      PHOTO.sourceUrl,
      PHOTO.sourceUrl,
    ]);
    expect(screen.getAllByText("Title")).toHaveLength(2);
    expect(screen.getByText(/cropped to 3 by 2 and resized/)).toBeTruthy();
    expect(screen.getByRole("img", { name: "ICE 1" }).getAttribute("srcset")).toContain("960w");
  });

  it("says when there are no photos and when loading failed", async () => {
    render(<CreditsPage fetcher={answer(200, { photos: [] })} />);
    expect(await screen.findByText("No vehicle photos are shown yet.")).toBeTruthy();
    cleanup();
    render(<CreditsPage fetcher={answer(503, { error: "not_configured" })} />);
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("offers Try again after a failed load and shows the photos once it works", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const flaky = async () => {
      calls += 1;
      if (calls > 1) await gate;
      return new Response(JSON.stringify(calls === 1 ? { error: "busy" } : { photos: [PHOTO] }), {
        status: calls === 1 ? 503 : 200,
      });
    };
    render(<CreditsPage fetcher={flaky} />);
    await screen.findByRole("alert");

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    const retry = screen.getByRole("button", { name: "Try again" });
    expect((retry as HTMLButtonElement).disabled).toBe(false);
    expect(retry.getAttribute("aria-disabled")).toBe("true");
    expect(retry.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(retry);
    expect(screen.getByRole("alert")).toBeTruthy();
    await userEvent.click(retry);
    await userEvent.keyboard("{Enter}");
    expect(calls).toBe(2);
    expect(document.activeElement).toBe(retry);
    release();
    expect(await screen.findByRole("heading", { name: "ICE 3" })).toBeTruthy();
    expect(calls).toBe(2);
    expect(document.activeElement?.textContent).toBe("1 photo");
    expect(document.activeElement?.getAttribute("tabindex")).toBe("-1");
  });

  it("refuses an answer that breaks the contract", async () => {
    const broken = { photos: [{ ...PHOTO, sourceUrl: "javascript:alert(1)" }] };
    await expect(loadCredits(answer(200, broken))).rejects.toThrow();
    render(<CreditsPage fetcher={answer(200, broken)} />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  });
});
