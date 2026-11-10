// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { axeResults, axeViolations, BROWSER_ONLY_RULES } from "../../test/helpers/axe.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the axe helper", () => {
  it("reports a button without a name and an image without a text alternative", async () => {
    document.body.innerHTML = '<div><button type="button"></button><img src="x.png"></div>';
    const found = await axeViolations(document.body);
    expect(found.some((line) => line.startsWith("button-name"))).toBe(true);
    expect(found.some((line) => line.startsWith("image-alt"))).toBe(true);
  });

  it("reports content outside any landmark only when it checks a whole page", async () => {
    document.body.innerHTML = "<p>Loose text</p>";
    expect(await axeViolations(document.body)).toEqual([]);
    const found = await axeViolations(document.body, { page: true });
    expect(found.some((line) => line.startsWith("region"))).toBe(true);
  });

  it("reports nothing for a labelled button", async () => {
    document.body.innerHTML = '<main><button type="button">Close</button></main>';
    expect(await axeViolations(document.body, { page: true })).toEqual([]);
  });

  it("does not count a 10 px button as a pass: rules that need a rendered page do not run", async () => {
    document.body.innerHTML =
      '<main><button type="button" style="width:10px;height:10px">x</button></main>';
    const results = await axeResults(document.body, { page: true });
    const ran = [...results.passes, ...results.violations, ...results.incomplete].map(
      (rule) => rule.id,
    );
    expect(ran).not.toContain("target-size");
    for (const id of BROWSER_ONLY_RULES) {
      expect(ran).not.toContain(id);
    }
    expect(await axeViolations(document.body, { page: true })).toEqual([]);
  });
});
