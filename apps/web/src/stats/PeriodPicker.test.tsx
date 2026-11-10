// @vitest-environment happy-dom
import { changeLocale } from "@gerlines/i18n";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PeriodPicker } from "./PeriodPicker.tsx";
import { initialStatsState, useStatsStore } from "./store.ts";

const DEBOUNCE_MS = 400;

beforeEach(async () => {
  await changeLocale("en");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-11-08T12:00:00Z"));
  useStatsStore.setState({
    ...initialStatsState(),
    period: { kind: "custom", from: "2026-11-02", to: "2026-11-08" },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const period = () => useStatsStore.getState().period;

describe("custom range", () => {
  it("waits for typing to stop before it asks for a new range", () => {
    render(<PeriodPicker />);
    const from = screen.getByLabelText("From");
    fireEvent.change(from, { target: { value: "2026-10-01" } });
    fireEvent.change(from, { target: { value: "2026-10-02" } });
    fireEvent.change(from, { target: { value: "2026-10-03" } });
    expect(period()).toEqual({ kind: "custom", from: "2026-11-02", to: "2026-11-08" });
    act(() => vi.advanceTimersByTime(DEBOUNCE_MS - 1));
    expect(period()).toMatchObject({ from: "2026-11-02" });
    act(() => vi.advanceTimersByTime(1));
    expect(period()).toEqual({ kind: "custom", from: "2026-10-03", to: "2026-11-08" });
  });

  it("applies the range at once when the field loses focus", () => {
    render(<PeriodPicker />);
    const from = screen.getByLabelText("From");
    fireEvent.change(from, { target: { value: "2026-10-20" } });
    fireEvent.blur(from);
    expect(period()).toMatchObject({ from: "2026-10-20" });
  });

  it("clamps a year typed digit by digit to the first data month", () => {
    render(<PeriodPicker />);
    const from = screen.getByLabelText("From") as HTMLInputElement;
    fireEvent.change(from, { target: { value: "0002-11-01" } });
    act(() => vi.advanceTimersByTime(DEBOUNCE_MS));
    expect(period()).toMatchObject({ from: "2024-01-01" });
    expect(from.value).toBe("2024-01-01");
  });

  it("clamps a last day after today to today", () => {
    render(<PeriodPicker />);
    const to = screen.getByLabelText("To") as HTMLInputElement;
    fireEvent.change(to, { target: { value: "2027-01-01" } });
    act(() => vi.advanceTimersByTime(DEBOUNCE_MS));
    expect(period()).toMatchObject({ to: "2026-11-08" });
    expect(to.value).toBe("2026-11-08");
  });

  it("gives both fields the bounds the clamp uses", () => {
    render(<PeriodPicker />);
    for (const label of ["From", "To"]) {
      const field = screen.getByLabelText(label) as HTMLInputElement;
      expect(field.min).toBe("2024-01-01");
      expect(field.max).toBe("2026-11-08");
    }
  });

  it("says what is wrong with the typed range at once and politely, not as an alert", () => {
    render(<PeriodPicker />);
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-11-09" } });
    const message = screen.getByText("The first day is after the last day.");
    expect(message.getAttribute("aria-live")).toBe("polite");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("follows a period that was set elsewhere", () => {
    render(<PeriodPicker />);
    act(() =>
      useStatsStore.getState().setPeriod({ kind: "custom", from: "2026-10-01", to: "2026-10-09" }),
    );
    expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe("2026-10-01");
  });
});
