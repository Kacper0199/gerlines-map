import { describe, expect, it } from "vitest";
import { slotAfter } from "../policy/schedule.ts";
import { PROVIDER_LIMITS } from "../sources.ts";
import { VirtualClock } from "../testing/virtual-clock.ts";
import { ProviderGate, type ProviderLease } from "./provider-gate.ts";
import { Semaphore } from "./semaphore.ts";

const START = Date.parse("2026-10-29T10:00:00Z");
const MINUTE = 60_000;

function maxInRollingMinute(times: readonly number[]): number {
  const sorted = [...times].sort((a, b) => a - b);
  let best = 0;
  let first = 0;
  for (const [last, time] of sorted.entries()) {
    while (time - (sorted[first] ?? time) >= MINUTE) first += 1;
    best = Math.max(best, last - first + 1);
  }
  return best;
}

function gate(clock: VirtualClock, leases: Readonly<Record<string, ProviderLease>> = {}) {
  return new ProviderGate({
    clock,
    limits: { ...PROVIDER_LIMITS, slow: { capacity: 100, refillEveryMs: 1 } },
    inFlight: new Semaphore(3),
    leases,
  });
}

describe("ProviderGate", () => {
  it("sends no more than 41 IRIS requests in any rolling minute while slow downloads hold the shared slots", async () => {
    const clock = new VirtualClock(START);
    const subject = gate(clock);
    const controller = new AbortController();
    const signal = controller.signal;
    const end = START + 6 * MINUTE;
    void clock.sleep(end - START).then(() => controller.abort());
    const sent: number[] = [];
    const slow = Array.from({ length: 3 }, () =>
      subject.run("slow", signal, () => clock.sleep(90_000)),
    );
    const iris = Array.from({ length: 60 }, async (_unused, index) => {
      const offset = Math.floor((index * MINUTE) / 60);
      let due = START + offset;
      while (due < end && !signal.aborted) {
        await clock.sleep(due - clock.now(), signal);
        await subject.run("db-timetables", signal, async () => {
          sent.push(clock.now());
          await clock.sleep(200, signal);
        });
        due = slotAfter(clock.now(), MINUTE, offset);
      }
    });
    await clock.runUntil(end + MINUTE);
    await Promise.all([...slow, ...iris]);
    expect(sent.length).toBeGreaterThan(150);
    expect(maxInRollingMinute(sent)).toBeLessThanOrEqual(41);
  });

  it("holds every caller of a provider back while a pause runs, and only that provider", async () => {
    const clock = new VirtualClock(START);
    const subject = gate(clock);
    const signal = new AbortController().signal;
    const ran: Record<string, number> = {};
    subject.pause("db-timetables", 120_000);
    subject.pause("db-timetables", 30_000);
    const iris = subject.run("db-timetables", signal, async () => {
      ran.iris = clock.now();
    });
    const other = subject.run("db-fasta", signal, async () => {
      ran.fasta = clock.now();
    });
    await clock.runUntil(START + 5 * MINUTE);
    await Promise.all([iris, other]);
    expect(ran.fasta).toBe(START);
    expect(ran.iris).toBeGreaterThanOrEqual(START + 120_000);
  });

  it("skips a provider whose lease another process holds and runs it once the lease is free", async () => {
    const clock = new VirtualClock(START);
    let holder: string | null = "pid 4242 on laptop";
    const subject = gate(clock, { "db-timetables": { hold: async () => holder } });
    const signal = new AbortController().signal;
    let calls = 0;
    const task = async () => {
      calls += 1;
    };
    expect(await subject.run("db-timetables", signal, task)).toEqual({
      ran: false,
      heldBy: "pid 4242 on laptop",
    });
    expect(calls).toBe(0);
    holder = null;
    expect(await subject.run("db-timetables", signal, task)).toEqual({ ran: true });
    expect(calls).toBe(1);
  });
});
