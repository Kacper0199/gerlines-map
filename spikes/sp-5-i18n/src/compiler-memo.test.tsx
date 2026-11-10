// @vitest-environment happy-dom
import { changeLocale } from "@gerlines/i18n";
import { m } from "@gerlines/i18n/messages";
import { useCopy, useLocale } from "@gerlines/i18n/react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function CallsMessageWithoutLocale() {
  useLocale();
  return <p data-testid="without-locale">{m.brand_tagline()}</p>;
}

function CallsMessageWithLocale() {
  const locale = useLocale();
  return <p data-testid="with-locale">{m.brand_tagline({}, { locale })}</p>;
}

function ReadsCopy() {
  const copy = useCopy();
  return <p data-testid="from-copy">{copy.brand.tagline}</p>;
}

const GERMAN = "Jeder Zug in Deutschland, live";

describe("React Compiler with message functions", () => {
  beforeEach(async () => {
    window.localStorage.clear();
    await act(() => changeLocale("en"));
    render(
      <>
        <CallsMessageWithoutLocale />
        <CallsMessageWithLocale />
        <ReadsCopy />
      </>,
    );
  });

  afterEach(cleanup);

  it("updates a component that passes the locale to the message", async () => {
    await act(() => changeLocale("de"));
    expect(screen.getByTestId("with-locale").textContent).toBe(GERMAN);
  });

  it("updates a component that reads the copy of the active locale", async () => {
    await act(() => changeLocale("de"));
    expect(screen.getByTestId("from-copy").textContent).toBe(GERMAN);
  });

  it("keeps the old text in a component that calls a message without the locale", async () => {
    await act(() => changeLocale("de"));
    expect(screen.getByTestId("without-locale").textContent).toBe("Every train in Germany, live");
  });
});
