// @vitest-environment happy-dom
import { changeLocale } from "@gerlines/i18n";
import { statsCopyFor } from "@gerlines/i18n/stats";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Percent } from "../NumberText.tsx";
import { binTitle } from "./DelayChart.tsx";

describe("binTitle", () => {
  const en = statsCopyFor("en");

  it("writes the early bins with a true minus sign, never a hyphen", () => {
    expect(binTitle({ fromS: -1800, toS: -300, count: 1 }, en)).toBe("−30 to −5 min");
    expect(binTitle({ fromS: -300, toS: 0, count: 1 }, en)).toBe("−5 to 0 min");
    expect(binTitle({ fromS: null, toS: -1800, count: 1 }, en)).toBe("Earlier than −30 min");
  });

  it("keeps plain digits for later bins and the open end", () => {
    expect(binTitle({ fromS: 960, toS: 1200, count: 1 }, en)).toBe("16 to 20 min");
    expect(binTitle({ fromS: 7200, toS: null, count: 1 }, en)).toBe("120 min or more");
  });
});

describe("Percent", () => {
  beforeEach(() => changeLocale("en"));
  afterEach(cleanup);

  it("shows a real share too small for one decimal as under 0.1, and a true zero as 0.0", () => {
    const tiny = render(<Percent share={0.0003} />);
    expect(tiny.container.textContent).toBe("under 0.1%");
    tiny.unmount();
    const zero = render(<Percent share={0} />);
    expect(zero.container.textContent).toBe("0.0%");
  });
});
