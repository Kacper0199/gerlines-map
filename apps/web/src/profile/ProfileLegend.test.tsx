// @vitest-environment happy-dom
import { changeLocale } from "@gerlines/i18n";
import { useProfileCopy } from "@gerlines/i18n/profile";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProfileLegend } from "./ProfileLegend.tsx";

const NBSP = String.fromCharCode(160);

function Legend({ curtain }: { curtain: boolean }) {
  const copy = useProfileCopy();
  return (
    <ProfileLegend copy={copy.profile} theme="dark" unit={copy.delay.minutes} curtain={curtain} />
  );
}

afterEach(async () => {
  cleanup();
  await changeLocale("en", { persist: false });
});

describe("ProfileLegend curtain line", () => {
  it("keeps the cap and its unit together so the unit never wraps alone", async () => {
    await changeLocale("en", { persist: false });
    render(<Legend curtain />);

    const line = screen.getByText(/^Curtain height/);
    expect(line.textContent).toBe(
      `Curtain height: minutes this train loses on the segment, up to 10${NBSP}min`,
    );
  });

  it("does the same in German and Polish", async () => {
    for (const locale of ["de", "pl"] as const) {
      await changeLocale(locale, { persist: false });
      cleanup();
      render(<Legend curtain />);
      expect(document.body.textContent).toMatch(new RegExp(`10${NBSP}\\S+$`));
    }
  });

  it("leaves the line out when the curtain is not drawn", () => {
    render(<Legend curtain={false} />);

    expect(screen.queryByText(/^Curtain height/)).toBeNull();
  });
});
