// @vitest-environment happy-dom
import { changeLocale, isLocale } from "@gerlines/i18n";
import { render } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { App } from "./App.tsx";

async function violationsFor(search: string) {
  window.history.replaceState({}, "", `/${search}`);
  const lang = new URLSearchParams(search).get("lang") ?? "en";
  await changeLocale(isLocale(lang) ? lang : "en");
  const { container, unmount } = render(<App />);
  const results = await axe.run(container, {
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
  });
  unmount();
  return results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.map((node) => node.target.join(" ")),
  }));
}

describe("component sheet accessibility, structure and names (axe-core, colour contrast is checked in the browser)", () => {
  it.each([
    ["dark", "?theme=dark"],
    ["light", "?theme=light"],
    ["German", "?lang=de"],
    ["Polish", "?lang=pl"],
  ])(
    "has no violations in the %s sheet",
    async (_name, search) => {
      expect(await violationsFor(search)).toEqual([]);
    },
    30_000,
  );
});
