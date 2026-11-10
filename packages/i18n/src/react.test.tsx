// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changeLocale, currentLocale, subscribeLocale } from "./locale.ts";
import { useCopy, useFormatters, useLocale } from "./react.ts";

function Panel() {
  const copy = useCopy();
  const { count } = useFormatters();
  const locale = useLocale();
  return (
    <section lang={locale}>
      <h1>{copy.brand.tagline}</h1>
      <p data-testid="platform">{copy.card.platform("7")}</p>
      <p data-testid="count">{count(2665)}</p>
    </section>
  );
}

describe("locale switch", () => {
  beforeEach(async () => {
    window.localStorage.clear();
    await act(() => changeLocale("en"));
  });

  afterEach(cleanup);

  it("re-renders the subscribed components in the new language without remounting them", async () => {
    render(<Panel />);
    const heading = screen.getByRole("heading");
    expect(heading.textContent).toBe("Every train in Germany, live");

    await act(() => changeLocale("de"));
    expect(screen.getByRole("heading")).toBe(heading);
    expect(heading.textContent).toBe("Jeder Zug in Deutschland, live");
    expect(screen.getByTestId("platform").textContent).toBe("Gleis 7");
    expect(screen.getByTestId("count").textContent).toBe("2.665");

    await act(() => changeLocale("pl"));
    expect(screen.getByRole("heading")).toBe(heading);
    expect(heading.textContent).toBe("Każdy pociąg w Niemczech, na żywo");
    expect(screen.getByTestId("platform").textContent).toBe("Peron 7");
  });

  it("sets the document language", async () => {
    await act(() => changeLocale("pl"));
    expect(document.documentElement.lang).toBe("pl-PL");
    await act(() => changeLocale("de"));
    expect(document.documentElement.lang).toBe("de-DE");
  });

  it("remembers the choice in local storage without reloading the page", async () => {
    await act(() => changeLocale("pl"));
    expect(currentLocale()).toBe("pl");
    expect(window.localStorage.getItem("PARAGLIDE_LOCALE")).toBe("pl");
  });

  it("notifies nobody when the locale does not change", async () => {
    let renders = 0;
    const unsubscribe = subscribeLocale(() => {
      renders += 1;
    });
    await act(() => changeLocale("en"));
    unsubscribe();
    expect(renders).toBe(0);
  });
});
