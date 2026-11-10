// @vitest-environment happy-dom
import { changeLocale } from "@gerlines/i18n";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchCard } from "../components/shell/SearchCard.tsx";
import { initialState, useAppStore } from "../state/store.ts";
import { pickFitting } from "./use-fitting-placeholder.ts";

const PX_PER_CHARACTER = 6;

let fieldWidth = 300;
let resizeCallbacks: Array<() => void> = [];

beforeEach(async () => {
  fieldWidth = 300;
  resizeCallbacks = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resizeCallbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ({
    font: "",
    measureText: (text: string) => ({ width: text.length * PX_PER_CHARACTER }),
  })) as unknown as HTMLCanvasElement["getContext"]);
  Object.defineProperty(HTMLInputElement.prototype, "clientWidth", {
    configurable: true,
    get: () => fieldWidth,
  });
  await changeLocale("en");
  useAppStore.setState({ ...initialState() });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLInputElement.prototype, "clientWidth");
});

function placeholder(name = "Search"): string | null {
  return screen.getByRole("combobox", { name }).getAttribute("placeholder");
}

function resizeTo(width: number) {
  fieldWidth = width;
  act(() => {
    for (const callback of resizeCallbacks) {
      callback();
    }
  });
}

describe("pickFitting", () => {
  const widthOf = (text: string) => text.length;

  it("takes the first candidate that fits, in the order given", () => {
    expect(pickFitting(["abcdef", "abcd", "ab"], 5, widthOf)).toBe("abcd");
    expect(pickFitting(["abcdef", "abcd", "ab"], 6, widthOf)).toBe("abcdef");
  });

  it("falls back to the last candidate when none fits", () => {
    expect(pickFitting(["abcdef", "abcd", "ab"], 1, widthOf)).toBe("ab");
  });
});

describe("the search field placeholder", () => {
  it("keeps the full string where it fits and never shows a cut one", () => {
    render(<SearchCard />);
    resizeTo(300);

    expect(placeholder()).toBe("Search for a train, line or station");
  });

  it("steps down to the medium string in the 360 px card of a tablet", () => {
    render(<SearchCard />);
    resizeTo(190);

    expect(placeholder()).toBe("Train, line or station");
  });

  it("steps down to the short and then the single word string on a 360 px phone", () => {
    render(<SearchCard />);
    resizeTo(110);
    expect(placeholder()).toBe("Train or station");

    resizeTo(70);
    expect(placeholder()).toBe("Search");
    resizeTo(20);
    expect(placeholder()).toBe("Search");
  });

  it("opens up again when the field grows", () => {
    render(<SearchCard />);
    resizeTo(70);
    expect(placeholder()).toBe("Search");

    resizeTo(300);
    expect(placeholder()).toBe("Search for a train, line or station");
  });

  it("measures each language with its own strings", async () => {
    await changeLocale("pl", { persist: false });
    render(<SearchCard />);
    resizeTo(190);
    expect(placeholder("Wyszukaj")).toBe("Pociąg, linia lub stacja");

    resizeTo(300);
    expect(placeholder("Wyszukaj")).toBe("Wyszukaj pociąg, linię lub stację");
  });

  it("keeps the full string when the layout cannot be measured", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    render(<SearchCard />);
    resizeTo(20);

    expect(placeholder()).toBe("Search for a train, line or station");
  });
});
