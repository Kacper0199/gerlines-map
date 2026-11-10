// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import de from "../messages/de.json";
import en from "../messages/en.json";
import pl from "../messages/pl.json";
import { applyDocumentLanguage, changeLocale, currentLocale, subscribeLocale } from "./locale.ts";
import { getLocale } from "./paraglide/runtime.js";

describe("changeLocale", () => {
  beforeEach(async () => {
    window.localStorage.clear();
    await changeLocale("en");
  });

  afterEach(async () => {
    window.localStorage.clear();
    await changeLocale("en");
  });

  it("has stored the new locale before a listener runs", async () => {
    const seen: string[] = [];
    const unsubscribe = subscribeLocale(() => {
      seen.push(getLocale());
    });
    await changeLocale("pl");
    unsubscribe();
    expect(seen).toEqual(["pl"]);
  });

  it("calls every listener and saves the choice when one listener throws", async () => {
    const after = vi.fn();
    const stops = [
      subscribeLocale(() => {
        throw new Error("broken listener");
      }),
      subscribeLocale(after),
    ];
    const outcome = await changeLocale("de").then(
      () => null,
      (error: unknown) => error,
    );
    for (const stop of stops) {
      stop();
    }
    expect(after).toHaveBeenCalledTimes(1);
    expect(currentLocale()).toBe("de");
    expect(window.localStorage.getItem("PARAGLIDE_LOCALE")).toBe("de");
    expect(outcome).toBeInstanceOf(AggregateError);
    expect((outcome as AggregateError).errors).toHaveLength(1);
  });

  it("switches for the session without storing the choice when asked not to persist", async () => {
    const listener = vi.fn();
    const stop = subscribeLocale(listener);

    await changeLocale("pl", { persist: false });
    stop();

    expect(currentLocale()).toBe("pl");
    expect(document.documentElement.lang).toBe("pl-PL");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem("PARAGLIDE_LOCALE")).toBeNull();
  });

  it("stores the choice by default", async () => {
    await changeLocale("de");

    expect(window.localStorage.getItem("PARAGLIDE_LOCALE")).toBe("de");
  });

  it("stops notifying a listener after it unsubscribed", async () => {
    const listener = vi.fn();
    subscribeLocale(listener)();
    await changeLocale("pl");
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("document title and description", () => {
  const description = () =>
    document.querySelector('meta[name="description"]')?.getAttribute("content");

  beforeEach(async () => {
    document.head.innerHTML = '<meta name="description" content="x">';
    document.title = "x";
    await changeLocale("en", { persist: false });
  });

  it("are set by applyDocumentLanguage before anything renders", () => {
    document.title = "x";
    applyDocumentLanguage();
    expect(document.title).toBe(en.brand_title);
    expect(description()).toBe(en.brand_description);
  });

  it("follow every language switch without a reload", async () => {
    await changeLocale("pl", { persist: false });
    expect(document.title).toBe(pl.brand_title);
    expect(description()).toBe(pl.brand_description);
    await changeLocale("de", { persist: false });
    expect(document.title).toBe(de.brand_title);
    expect(description()).toBe(de.brand_description);
  });

  it("start in index.html with the English texts, so the first paint matches", () => {
    const html = readFileSync(resolve(process.cwd(), "../../apps/web/index.html"), "utf8");
    expect(html).toContain(`<title>${en.brand_title}</title>`);
    expect(html).toContain(`<meta name="description" content="${en.brand_description}" />`);
  });
});
