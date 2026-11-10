// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { axeViolations } from "../../../test/helpers/axe.ts";
import { RadioTabs } from "./RadioTabs.tsx";

const OPTIONS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Gamma" },
] as const;

function Harness({ initial = "a" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return <RadioTabs label="Letters" value={value} onValueChange={setValue} options={OPTIONS} />;
}

afterEach(cleanup);

describe("RadioTabs", () => {
  it("is one radio group with a name, each option a radio, the current one checked", () => {
    render(<Harness initial="b" />);
    const group = screen.getByRole("radiogroup", { name: "Letters" });
    const radios = screen.getAllByRole("radio");
    expect(
      radios.map(
        (radio) => radio.getAttribute("aria-checked") ?? (radio as HTMLInputElement).checked,
      ),
    ).toEqual([false, true, false]);
    expect(group.contains(radios[0] as HTMLElement)).toBe(true);
    expect(screen.getByRole("radio", { name: "Beta" })).toBeTruthy();
  });

  it("selects an option by click and by the arrow keys, one tab stop for the group", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByText("Gamma"));
    expect((screen.getByRole("radio", { name: "Gamma" }) as HTMLInputElement).checked).toBe(true);
    await user.tab();
    await user.tab();
    screen.getByRole("radio", { name: "Gamma" }).focus();
    await user.keyboard("{ArrowLeft}");
    expect((screen.getByRole("radio", { name: "Beta" }) as HTMLInputElement).checked).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Beta" }));
  });

  it("labelled by an element when one is given, and has no axe violations", async () => {
    const { container } = render(
      <>
        <span id="title">Pick one</span>
        <RadioTabs labelledBy="title" value="a" onValueChange={() => undefined} options={OPTIONS} />
      </>,
    );
    expect(screen.getByRole("radiogroup", { name: "Pick one" })).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
  });
});
