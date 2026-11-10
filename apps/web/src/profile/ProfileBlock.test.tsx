// @vitest-environment happy-dom
import { changeLocale } from "@gerlines/i18n";
import { TrainDetail } from "@gerlines/schema";
import { ThemeProvider } from "@gerlines/ui";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ice from "../components/train/fixtures/ice-delay.json" with { type: "json" };
import { useAppStore } from "../state/store.ts";
import answer from "./fixtures/segments-619-hsr.json" with { type: "json" };
import ProfileBlock from "./ProfileBlock.tsx";
import { ProfileHost } from "./ProfileHost.tsx";
import { selectionFrom } from "./selection-fixture.ts";
import { profileSubjectOf } from "./subject.ts";
import { clearProfileCache } from "./use-profile.ts";

const detail = TrainDetail.parse(ice.detail);
const subject = profileSubjectOf(detail, true);
if (!subject) throw new Error("no subject");
const SELECTION = selectionFrom(detail.stops, 7);

const ok = () => new Response(JSON.stringify(answer), { status: 200 });

function mount() {
  return render(
    <ThemeProvider theme="dark" onThemeChange={() => undefined}>
      <ProfileBlock subject={subject as NonNullable<typeof subject>} />
      <ProfileHost subject={subject} />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  clearProfileCache();
  useAppStore.getState().select("live:1");
  useAppStore.getState().setRouteStops(SELECTION);
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  useAppStore.getState().select(null);
  await changeLocale("en", { persist: false });
});

describe("ProfileBlock", () => {
  it("asks for nothing until the profile is switched on", () => {
    const fetch = vi.fn(async () => ok());
    vi.stubGlobal("fetch", fetch);
    mount();
    const button = screen.getByRole("button", { name: "Show segment profile" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(fetch).not.toHaveBeenCalled();
    expect(useAppStore.getState().profile).toBeNull();
  });

  it("fetches the profile of the card train and hands its legs to the map", async () => {
    const fetch = vi.fn(async (_url: string) => ok());
    vi.stubGlobal("fetch", fetch);
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Show segment profile" }));
    await waitFor(() => expect(useAppStore.getState().profile).not.toBeNull());
    expect(fetch.mock.calls[0]?.[0]).toMatch(
      /^\/api\/v1\/stats\/trains\/619\/segments\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}&category=hsr&operator=db-fernverkehr-ag$/,
    );
    const overlay = useAppStore.getState().profile;
    expect(overlay?.legs).toHaveLength(21);
    expect(overlay?.quantile).toBe("median");
    expect(screen.getByText("Delay gain of this train against all trains")).toBeTruthy();
    expect(screen.getByText(/^Profile of /).textContent).toContain("DB Fernverkehr AG");
  });

  it("follows the measure the reader picks and takes the legs back when it is switched off", async () => {
    vi.stubGlobal("fetch", async () => ok());
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Show segment profile" }));
    await waitFor(() => expect(useAppStore.getState().profile).not.toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "80th percentile" }));
    await waitFor(() => expect(useAppStore.getState().profile?.quantile).toBe("p80"));
    await userEvent.click(screen.getByRole("button", { name: "Hide segment profile" }));
    expect(useAppStore.getState().profile).toBeNull();
  });

  it("keeps the profile on the map when the block is gone, as when the phone sheet is folded", async () => {
    vi.stubGlobal("fetch", async () => ok());
    const view = mount();
    await userEvent.click(screen.getByRole("button", { name: "Show segment profile" }));
    await waitFor(() => expect(useAppStore.getState().profile).not.toBeNull());
    view.rerender(
      <ThemeProvider theme="dark" onThemeChange={() => undefined}>
        <ProfileHost subject={subject} />
      </ThemeProvider>,
    );
    expect(screen.queryByRole("region", { name: "Segment profile" })).toBeNull();
    expect(useAppStore.getState().profile).not.toBeNull();
    expect(useAppStore.getState().profileOn).toBe(true);
  });

  it("lists every leg with the API figures and the reason a leg has none", async () => {
    vi.stubGlobal("fetch", async () => ok());
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Show segment profile" }));
    await userEvent.click(await screen.findByRole("button", { name: "Show 21 segments" }));
    const list = screen.getByRole("list");
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(21);
    expect(rows[2]?.textContent).toContain("Hamburg Hbf to Hamburg-Harburg");
    expect(rows[2]?.textContent).toContain(
      "This train: Median 1 min, 8 in 10 under 2 min, 24 runs",
    );
    expect(rows[3]?.textContent).toContain("This train: Too few runs: 3, at least 5 are needed");
    expect(rows[10]?.textContent).toContain("This train: No runs in this period");
  });

  it("keeps the retry button disabled for the wait the API named, then enables it", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return calls === 1
        ? new Response("{}", { status: 429, headers: { "retry-after": "1" } })
        : ok();
    });
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Show segment profile" }));
    const waiting = await screen.findByRole("button", { name: "Try again in 1 s" });
    expect(waiting.hasAttribute("disabled")).toBe(true);
    const ready = await screen.findByRole("button", { name: "Try again" }, { timeout: 3000 });
    expect(ready.hasAttribute("disabled")).toBe(false);
    await userEvent.click(ready);
    await waitFor(() => expect(calls).toBe(2));
  });

  it("tells how many legs sit in the answer under another station id, and gives them no figures", async () => {
    const other = "11111111-1111-4111-8111-111111111111";
    const renamed = {
      ...answer,
      segments: answer.segments.map((segment) =>
        segment.position === 5 || segment.position === 6
          ? { ...segment, from: { ...segment.from, id: other } }
          : segment,
      ),
    };
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(renamed), { status: 200 }));
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Show segment profile" }));
    expect(
      await screen.findByText(
        "2 segments of this route are in the data under other station ids, so they show no figures here",
      ),
    ).toBeTruthy();
  });

  it("says nothing of other station ids when every leg matches", async () => {
    vi.stubGlobal("fetch", async () => ok());
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Show segment profile" }));
    await screen.findByText(/^Profile of /);
    expect(screen.queryByText(/under other station ids/)).toBeNull();
  });

  it("says so, and draws nothing, when the stops cannot be placed on the route", async () => {
    vi.stubGlobal("fetch", async () => ok());
    useAppStore.getState().setRouteStops(selectionFrom(detail.stops, 7, detail.stops.length - 1));
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Show segment profile" }));
    expect(await screen.findByText(/cannot be placed on the route drawn/)).toBeTruthy();
    expect(useAppStore.getState().profile).toBeNull();
  });

  it("offers a retry when the API fails", async () => {
    const fetch = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetch);
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Show segment profile" }));
    expect((await screen.findByRole("alert")).textContent).toContain("could not be loaded");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(useAppStore.getState().profile).not.toBeNull());
  });

  it("reads in German and Polish", async () => {
    vi.stubGlobal("fetch", async () => ok());
    await changeLocale("de", { persist: false });
    const german = mount();
    expect(screen.getByRole("button", { name: "Streckenprofil anzeigen" })).toBeTruthy();
    german.unmount();
    await changeLocale("pl", { persist: false });
    mount();
    expect(screen.getByRole("button", { name: "Pokaż profil odcinków" })).toBeTruthy();
  });
});
