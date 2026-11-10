// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "../ui/button.tsx";
import { Checkbox } from "../ui/checkbox.tsx";
import { Switch } from "../ui/switch.tsx";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs.tsx";
import { BottomSheet } from "./bottom-sheet.tsx";
import { LanguageSwitch } from "./language-switch.tsx";
import { LegendRow } from "./legend-row.tsx";
import { SearchField } from "./search-field.tsx";
import { SoonTag } from "./soon-tag.tsx";
import { StyleThumb } from "./style-thumb.tsx";
import { ThemeProvider, useTheme } from "./theme-provider.tsx";

const LOCALES = [
  { code: "en", short: "EN", name: "English" },
  { code: "de", short: "DE", name: "Deutsch" },
  { code: "pl", short: "PL", name: "Polski" },
] as const;

describe("Tabs", () => {
  it("moves focus with the arrow keys, wraps around and selects with enter", async () => {
    const user = userEvent.setup();
    render(
      <Tabs defaultValue="category">
        <TabsList aria-label="Colour by">
          <TabsTrigger value="category">Category</TabsTrigger>
          <TabsTrigger value="delay">Delay</TabsTrigger>
          <TabsTrigger value="operator">Operator</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const category = screen.getByRole("tab", { name: "Category" });
    expect(category.getAttribute("aria-selected")).toBe("true");
    category.focus();
    await user.keyboard("{ArrowRight}");
    const delay = screen.getByRole("tab", { name: "Delay" });
    expect(document.activeElement).toBe(delay);
    expect(delay.getAttribute("aria-selected")).toBe("false");
    await user.keyboard("{Enter}");
    expect(delay.getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(document.activeElement).toBe(category);
  });
});

describe("Switch and Checkbox", () => {
  it("toggles the switch with the space key", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="Realtime" onCheckedChange={onCheckedChange} />);
    const control = screen.getByRole("switch", { name: "Realtime" });
    expect(control.getAttribute("aria-checked")).toBe("false");
    control.focus();
    await user.keyboard(" ");
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(onCheckedChange).toHaveBeenCalledWith(true, expect.anything());
  });

  it("toggles the checkbox with the space key and ignores a disabled one", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Checkbox aria-label="RB" />
        <Checkbox aria-label="Night" disabled />
      </>,
    );
    const rb = screen.getByRole("checkbox", { name: "RB" });
    rb.focus();
    await user.keyboard(" ");
    expect(rb.getAttribute("aria-checked")).toBe("true");
    await user.click(screen.getByRole("checkbox", { name: "Night" }));
    expect(screen.getByRole("checkbox", { name: "Night" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });
});

describe("Button", () => {
  it("reports loading, blocks clicks and keeps focus", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Copy link
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Copy link" });
    expect(button.getAttribute("aria-busy")).toBe("true");
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("LanguageSwitch", () => {
  it("selects a language and never ends without one", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <LanguageSwitch
        label="Language"
        locales={LOCALES}
        defaultValue="en"
        onValueChange={onValueChange}
      />,
    );
    const german = screen.getByRole("button", { name: "DE, Deutsch" });
    await user.click(german);
    expect(onValueChange).toHaveBeenLastCalledWith("de");
    expect(german.getAttribute("aria-pressed")).toBe("true");
    await user.click(german);
    expect(german.getAttribute("aria-pressed")).toBe("true");
    expect(onValueChange).toHaveBeenCalledTimes(1);
  });
});

describe("SearchField", () => {
  it("types, shows the clear button and empties the field", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<SearchField label="Search" clearLabel="Clear search" onValueChange={onValueChange} />);
    const input = screen.getByRole("searchbox", { name: "Search" }) as HTMLInputElement;
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    await user.type(input, "ICE");
    expect(input.value).toBe("ICE");
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(input.value).toBe("");
    expect(onValueChange).toHaveBeenLastCalledWith("");
  });

  it("marks an invalid field", () => {
    render(<SearchField label="Search" clearLabel="Clear" invalid defaultValue="x" />);
    expect(screen.getByRole("searchbox").getAttribute("aria-invalid")).toBe("true");
  });
});

describe("LegendRow", () => {
  it("toggles when the whole row is clicked and formats the count by locale", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(
      <LegendRow
        category="hsr"
        name="ICE"
        count={1234567}
        locale="de"
        onCheckedChange={onCheckedChange}
      />,
    );
    expect(screen.getByText("ICE").closest("label")?.textContent).toContain("1.234.567");
    await user.click(screen.getByText("ICE"));
    expect(onCheckedChange).toHaveBeenCalledWith(false, expect.anything());
  });

  it("shows a missing count as a placeholder, never as a number", () => {
    render(<LegendRow category="hsr" name="ICE" count={null} />);
    expect(screen.getByTestId("count-missing")).toBeTruthy();
    expect(screen.getByText("ICE").closest("label")?.textContent).toBe("ICE");
  });

  it("writes the count in ink and mutes it only for a hidden category", () => {
    render(<LegendRow category="hsr" name="ICE" count={151} checked />);
    const count = screen.getByText("151");
    expect(count.className).toContain("text-ink ");
    expect(count.className).not.toMatch(/(^|\s)text-ink-muted(\s|$)/);
    expect(count.className).toContain("group-has-[[data-unchecked]]/row:text-ink-muted");
  });

  it("hyphenates a long name by the language of its locale", () => {
    render(<LegendRow category="hsr" name="ICE und Hochgeschwindigkeit" count={13} locale="de" />);
    const name = screen.getByText("ICE und Hochgeschwindigkeit");
    expect(name.getAttribute("lang")).toBe("de");
    expect(name.className).toContain("hyphens-auto");
  });

  it("aligns the checkbox, mark and count with the first line of a wrapped name", () => {
    render(<LegendRow category="foreign" name="Hochgeschwindigkeitszug" count={7} />);
    const row = screen.getByText("Hochgeschwindigkeitszug").closest("label");
    expect(row?.className).toContain("items-start");
  });
});

describe("BottomSheet", () => {
  function sheet(props: Partial<React.ComponentProps<typeof BottomSheet>> = {}) {
    return render(
      <BottomSheet
        label="Selected train"
        expandLabel="Show more"
        collapseLabel="Show less"
        {...props}
      >
        <p>Body</p>
      </BottomSheet>,
    );
  }

  it("starts at the 304 px peek and expands from the handle", async () => {
    const user = userEvent.setup();
    sheet();
    const region = screen.getByRole("region", { name: "Selected train" });
    expect(region.style.height).toBe("304px");
    expect(region.dataset.state).toBe("peek");
    const handle = screen.getByRole("button", { name: "Show more" });
    expect(handle.getAttribute("aria-expanded")).toBe("false");
    await user.click(handle);
    expect(region.dataset.state).toBe("expanded");
    expect(region.style.height).toBe("calc(100dvh - var(--gl-sheet-inset, 120px))");
    expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  it("takes the height of its content when expanded to fit, capped by the viewport inset", async () => {
    const user = userEvent.setup();
    sheet({ expandedFit: "content" });
    const region = screen.getByRole("region", { name: "Selected train" });
    expect(region.style.height).toBe("304px");
    expect(region.style.maxHeight).toBe("");

    await user.click(screen.getByRole("button", { name: "Show more" }));

    expect(region.style.height).toBe("auto");
    expect(region.style.maxHeight).toBe("calc(100dvh - var(--gl-sheet-inset, 120px))");
    await user.click(screen.getByRole("button", { name: "Show less" }));
    expect(region.style.height).toBe("304px");
  });

  it("opens with the keyboard and collapses with escape", async () => {
    const user = userEvent.setup();
    sheet();
    const handle = screen.getByRole("button", { name: "Show more" });
    handle.focus();
    await user.keyboard("{Enter}");
    const region = screen.getByRole("region", { name: "Selected train" });
    expect(region.dataset.state).toBe("expanded");
    await user.keyboard("{Escape}");
    expect(region.dataset.state).toBe("peek");
  });

  it("follows a drag of more than 40 px and ignores a smaller one", () => {
    const onExpandedChange = vi.fn();
    sheet({ onExpandedChange });
    const handle = screen.getByRole("button", { name: "Show more" });
    fireEvent.pointerDown(handle, { clientY: 400, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 380, pointerId: 1 });
    expect(onExpandedChange).not.toHaveBeenCalled();
    fireEvent.pointerDown(handle, { clientY: 400, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 340, pointerId: 1 });
    expect(onExpandedChange).toHaveBeenCalledWith(true);
  });

  it("stays controlled when expanded is given", async () => {
    const user = userEvent.setup();
    const onExpandedChange = vi.fn();
    sheet({ expanded: false, onExpandedChange });
    await user.click(screen.getByRole("button", { name: "Show more" }));
    expect(onExpandedChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole("region").dataset.state).toBe("peek");
  });
});

function Probe() {
  const { theme, setTheme } = useTheme();
  return (
    <button type="button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
      {theme}
    </button>
  );
}

describe("ThemeProvider", () => {
  it("defaults to dark, writes data-theme and switches to light", async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(document.documentElement.dataset.theme).toBe("dark");
    await user.click(screen.getByRole("button"));
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("throws outside a provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Probe />)).toThrow("useTheme must be used inside ThemeProvider");
    spy.mockRestore();
  });
});

describe("StyleThumb", () => {
  it("shows the Soon tag under the label of a style that is not available yet", () => {
    const onPress = vi.fn();
    render(
      <StyleThumb
        kind="satellite"
        label="Satellite"
        status={<SoonTag label="Soon" description="Not available yet" />}
        pressed={false}
        disabled
        onPress={onPress}
      />,
    );

    const thumb = screen.getByRole("button", { name: /^Satellite Soon ?\. Not available yet$/ });
    fireEvent.click(thumb);

    expect(thumb.getAttribute("aria-disabled")).toBe("true");
    expect(onPress).not.toHaveBeenCalled();
  });

  it.each([
    ["dark", "#1A1B1D", "#EDE6D6"],
    ["light", "#EDEBE5", "#26231E"],
    ["satellite", "#3D4632", "#EDE6D6"],
    ["terrain", "#EDEBE5", "#26231E"],
  ] as const)(
    "draws the %s thumbnail with the ground and train colours of its theme",
    (kind, ground, train) => {
      const { container } = render(<StyleThumb kind={kind} label={kind} pressed={false} />);

      const svg = container.querySelector("svg");
      expect(svg?.querySelector("rect")?.getAttribute("fill")).toBe(ground);
      expect(svg?.querySelector("circle")?.getAttribute("fill")).toBe(train);
    },
  );

  it("presses an available style", () => {
    const onPress = vi.fn();
    render(<StyleThumb kind="light" label="Light" pressed={false} onPress={onPress} />);

    fireEvent.click(screen.getByRole("button", { name: "Light" }));

    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe("SoonTag", () => {
  it("shows the short word and gives screen readers the longer explanation", () => {
    render(<SoonTag label="Soon" description="Not available yet" />);

    const tag = document.querySelector("[data-slot=soon-tag]");
    expect(tag?.textContent).toBe("Soon. Not available yet");
    expect(tag?.querySelector(".sr-only")?.textContent).toBe(". Not available yet");
  });
});

describe("SearchField trailing slot", () => {
  it("shows the trailing content while the field is disabled and empty", () => {
    render(
      <SearchField
        label="Search"
        clearLabel="Clear"
        disabled
        trailing={<SoonTag label="Soon" description="Not available yet" />}
      />,
    );

    expect(screen.getByText("Soon")).toBeTruthy();
    expect((screen.getByRole("searchbox", { name: "Search" }) as HTMLInputElement).disabled).toBe(
      true,
    );
  });
});
