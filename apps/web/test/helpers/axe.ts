import axe, { type AxeResults } from "axe-core";

export interface AxeOptions {
  /** Landmark coverage is checked only where a whole page is rendered, not a single panel. */
  readonly page?: boolean;
}

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

/**
 * Rules that measure a rendered page. happy-dom has no layout and no CSS, so they would report a
 * pass (a 10 px button passes target-size) or nothing; they are off and belong to the browser pass.
 */
export const BROWSER_ONLY_RULES = [
  "color-contrast",
  "color-contrast-enhanced",
  "target-size",
  "link-in-text-block",
  "scrollable-region-focusable",
  "css-orientation-lock",
] as const;

export async function axeResults(
  root: Element,
  { page = false }: AxeOptions = {},
): Promise<AxeResults> {
  const rules = Object.fromEntries(BROWSER_ONLY_RULES.map((id) => [id, { enabled: false }]));
  return axe.run(root, {
    runOnly: { type: "tag", values: WCAG_TAGS },
    rules: { ...rules, region: { enabled: page } },
  });
}

/** Runs axe-core over `root` and returns one line per violation. */
export async function axeViolations(root: Element, options: AxeOptions = {}): Promise<string[]> {
  const results = await axeResults(root, options);
  return results.violations.flatMap((violation) =>
    violation.nodes.map(
      (node) => `${violation.id} (${violation.impact ?? "n/a"}): ${node.html.slice(0, 160)}`,
    ),
  );
}
